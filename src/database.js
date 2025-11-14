const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs-extra');
const Config = require('./config');

// 抽象資料庫介面
class DatabaseInterface {
    async init() {
        throw new Error('子類別必須實作 init 方法');
    }

    async addVideo(videoData) {
        throw new Error('子類別必須實作 addVideo 方法');
    }

    async getVideos(filters = {}) {
        throw new Error('子類別必須實作 getVideos 方法');
    }

    async searchVideos(searchTerm, tags = []) {
        throw new Error('子類別必須實作 searchVideos 方法');
    }

    async updateVideo(videoId, updates) {
        throw new Error('子類別必須實作 updateVideo 方法');
    }

    async deleteVideo(videoId) {
        throw new Error('子類別必須實作 deleteVideo 方法');
    }

    async deleteVideoWithFile(videoId) {
        throw new Error('子類別必須實作 deleteVideoWithFile 方法');
    }

    async setVideoMetadata(fingerprint, metadata) {
        throw new Error('子類別必須實作 setVideoMetadata 方法');
    }

    async addVideoTag(fingerprint, tagName) {
        throw new Error('子類別必須實作 addVideoTag 方法');
    }

    async removeVideoTag(fingerprint, tagName) {
        throw new Error('子類別必須實作 removeVideoTag 方法');
    }

    async deleteVideoMetadata(fingerprint) {
        throw new Error('子類別必須實作 deleteVideoMetadata 方法');
    }

    async migrateLegacyTags() {
        throw new Error('子類別必須實作 migrateLegacyTags 方法');
    }

    async addTag(videoId, tagName) {
        throw new Error('子類別必須實作 addTag 方法');
    }

    async removeTag(videoId, tagName) {
        throw new Error('子類別必須實作 removeTag 方法');
    }

    async getAllTags() {
        throw new Error('子類別必須實作 getAllTags 方法');
    }

    async createTagGroup(groupData) {
        throw new Error('子類別必須實作 createTagGroup 方法');
    }

    async getAllTagGroups() {
        throw new Error('子類別必須實作 getAllTagGroups 方法');
    }

    async createTag(tagData) {
        throw new Error('子類別必須實作 createTag 方法');
    }

    async getTagsByGroup() {
        throw new Error('子類別必須實作 getTagsByGroup 方法');
    }

    close() {
        throw new Error('子類別必須實作 close 方法');
    }
}

// MongoDB 資料庫實作
class MongoDatabase extends DatabaseInterface {
    constructor(connectionString) {
        super();
        this.connectionString = connectionString;
        this.client = null;
        this.db = null;
    }

    async init() {
        this.client = new MongoClient(this.connectionString);
        await this.client.connect();

        // 從連線字串中提取資料庫名稱
        const dbName = this.extractDatabaseName(this.connectionString);
        this.db = this.client.db(dbName);

        // 創建索引
        await this.createIndexes();
    }

    extractDatabaseName(connectionString) {
        // 從MongoDB連線字串中提取資料庫名稱
        const match = connectionString.match(/\/([^/?]+)(\?|$)/);
        return match ? match[1] : 'videonow';
    }

    async createIndexes() {
        // 為videos集合創建索引
        await this.db.collection('videos').createIndex({ filepath: 1 }, { unique: true });
        await this.db.collection('videos').createIndex({ fingerprint: 1 }, { unique: true, sparse: true });
        await this.db.collection('videos').createIndex({ filename: 'text', description: 'text' });
        await this.db.collection('videos').createIndex({ created_at: -1 });
        await this.db.collection('videos').createIndex({ is_master: 1 });

        // 為tags集合創建索引
        await this.db.collection('tags').createIndex({ name: 1 }, { unique: true });
        await this.db.collection('tag_groups').createIndex({ name: 1 }, { unique: true });
    }

    async addVideo(videoData) {
        const { filename, filepath, filesize, duration, description, fingerprint, file_created_at } = videoData;

        try {
            let existingVideo = null;

            // 第一步：優先使用指紋查找，如果沒有指紋則用路徑查找
            if (fingerprint) {
                existingVideo = await this.db.collection('videos').findOne({ fingerprint });

                // 如果用指紋找到了，但路徑不同，記錄檔案移動
                if (existingVideo && existingVideo.filepath !== filepath) {
                    console.log(`檔案移動檢測: ${existingVideo.filepath} -> ${filepath}`);
                }
            }

            // 第二步：如果指紋沒找到，用路徑查找
            if (!existingVideo) {
                existingVideo = await this.db.collection('videos').findOne({ filepath });
            }

            if (existingVideo) {
                // 檔案已存在，更新基本檔案資訊，保留用戶設定
                const updateResult = await this.db.collection('videos').updateOne(
                    { _id: existingVideo._id },
                    {
                        $set: {
                            filename,
                            filepath,
                            filesize: filesize || 0,
                            duration: duration || 0,
                            fingerprint,
                            file_created_at: file_created_at || null,
                            updated_at: new Date()
                        }
                    }
                );
                console.log(`更新現有影片資訊: ${filename}`);
                return 'updated';
            } else {
                // 新檔案，插入新記錄
                const video = {
                    filename,
                    filepath,
                    filesize: filesize || 0,
                    duration: duration || 0,
                    description: description || '',
                    rating: 0,
                    tags: [],
                    fingerprint,
                    is_master: true,  // 預設為主影片
                    file_created_at: file_created_at || null,
                    created_at: new Date(),
                    updated_at: new Date()
                };

                const result = await this.db.collection('videos').insertOne(video);
                console.log(`添加新影片: ${filename}`);
                return result.insertedId.toString();
            }
        } catch (error) {
            throw error;
        }
    }

    async getVideos(filters = {}) {
        // 分頁參數
        const limit = filters.limit || 9;
        const offset = filters.offset || 0;
        const needCount = filters.count !== false;

        // 構建聚合管道
        const pipeline = [];

        // 第一步：過濾掉子影片（is_master !== false）
        pipeline.push({
            $match: {
                $or: [
                    { is_master: { $ne: false } },  // is_master 為 true 或不存在
                    { is_master: { $exists: false } }
                ]
            }
        });

        // 第二步：左連接 video_tag_relations
        pipeline.push({
            $lookup: {
                from: 'video_tag_relations',
                localField: 'fingerprint',
                foreignField: 'fingerprint',
                as: 'tag_relation'
            }
        });

        // 第三步：添加標籤欄位
        pipeline.push({
            $addFields: {
                tags: {
                    $ifNull: [
                        { $arrayElemAt: ['$tag_relation.tags', 0] },
                        []
                    ]
                }
            }
        });

        // 第四步：篩選條件
        const matchStage = {};
        if (filters.filename) {
            matchStage.filename = new RegExp(filters.filename, 'i');
        }
        if (filters.tag) {
            matchStage.tags = filters.tag;
        }
        if (filters.rating && filters.rating > 0) {
            matchStage.rating = filters.rating;
        }
        if (Object.keys(matchStage).length > 0) {
            pipeline.push({ $match: matchStage });
        }

        // 第五步：排序
        pipeline.push({
            $sort: { file_created_at: -1, created_at: -1 }
        });

        // 第六步：分頁
        pipeline.push({ $skip: offset });
        pipeline.push({ $limit: limit });

        // 第七步：清理欄位
        pipeline.push({
            $project: {
                tag_relation: 0
            }
        });

        const videos = await this.db.collection('videos').aggregate(pipeline).toArray();

        const mappedVideos = videos.map(video => ({
            ...video,
            id: video._id.toString(),
            tags: video.tags || []
        }));

        // 如果需要計算總數，執行額外查詢
        if (needCount) {
            const countPipeline = [
                {
                    $match: {
                        $or: [
                            { is_master: { $ne: false } },
                            { is_master: { $exists: false } }
                        ]
                    }
                },
                {
                    $lookup: {
                        from: 'video_tag_relations',
                        localField: 'fingerprint',
                        foreignField: 'fingerprint',
                        as: 'tag_relation'
                    }
                },
                {
                    $addFields: {
                        tags: {
                            $ifNull: [
                                { $arrayElemAt: ['$tag_relation.tags', 0] },
                                []
                            ]
                        }
                    }
                }
            ];

            if (Object.keys(matchStage).length > 0) {
                countPipeline.push({ $match: matchStage });
            }

            countPipeline.push({ $count: 'total' });

            const countResult = await this.db.collection('videos').aggregate(countPipeline).toArray();
            const total = countResult.length > 0 ? countResult[0].total : 0;

            return {
                videos: mappedVideos,
                total: total,
                page: Math.floor(offset / limit) + 1,
                pageSize: limit,
                totalPages: Math.ceil(total / limit)
            };
        } else {
            return { videos: mappedVideos };
        }
    }

    async searchVideos(searchTerm, tags = [], filters = {}) {
        // 分頁參數
        const limit = filters.limit || 9;
        const offset = filters.offset || 0;
        const needCount = filters.count !== false;

        // 構建聚合管道
        const pipeline = [];

        // 第一步：過濾掉子影片（is_master !== false）
        pipeline.push({
            $match: {
                $or: [
                    { is_master: { $ne: false } },
                    { is_master: { $exists: false } }
                ]
            }
        });

        // 第二步：左連接 video_tag_relations
        pipeline.push({
            $lookup: {
                from: 'video_tag_relations',
                localField: 'fingerprint',
                foreignField: 'fingerprint',
                as: 'tag_relation'
            }
        });

        // 第三步：添加標籤欄位
        pipeline.push({
            $addFields: {
                tags: {
                    $ifNull: [
                        { $arrayElemAt: ['$tag_relation.tags', 0] },
                        []
                    ]
                }
            }
        });

        // 第四步：篩選條件
        const matchStage = {};

        if (searchTerm && searchTerm.trim()) {
            matchStage.$or = [
                { filename: new RegExp(searchTerm, 'i') },
                { description: new RegExp(searchTerm, 'i') }
            ];
        }

        if (tags.length > 0) {
            // 使用 $all 確保所有指定的標籤都存在
            matchStage.tags = { $all: tags };
        }

        if (filters.rating && filters.rating > 0) {
            matchStage.rating = filters.rating;
        }

        if (Object.keys(matchStage).length > 0) {
            pipeline.push({ $match: matchStage });
        }

        // 第五步：排序
        pipeline.push({
            $sort: { file_created_at: -1, created_at: -1 }
        });

        // 第六步：分頁
        pipeline.push({ $skip: offset });
        pipeline.push({ $limit: limit });

        // 第七步：清理欄位
        pipeline.push({
            $project: {
                tag_relation: 0
            }
        });

        const videos = await this.db.collection('videos').aggregate(pipeline).toArray();

        const mappedVideos = videos.map(video => ({
            ...video,
            id: video._id.toString(),
            tags: video.tags || []
        }));

        // 如果需要計算總數，執行額外查詢
        if (needCount) {
            const countPipeline = [
                {
                    $match: {
                        $or: [
                            { is_master: { $ne: false } },
                            { is_master: { $exists: false } }
                        ]
                    }
                },
                {
                    $lookup: {
                        from: 'video_tag_relations',
                        localField: 'fingerprint',
                        foreignField: 'fingerprint',
                        as: 'tag_relation'
                    }
                },
                {
                    $addFields: {
                        tags: {
                            $ifNull: [
                                { $arrayElemAt: ['$tag_relation.tags', 0] },
                                []
                            ]
                        }
                    }
                }
            ];

            if (Object.keys(matchStage).length > 0) {
                countPipeline.push({ $match: matchStage });
            }

            countPipeline.push({ $count: 'total' });

            const countResult = await this.db.collection('videos').aggregate(countPipeline).toArray();
            const total = countResult.length > 0 ? countResult[0].total : 0;

            return {
                videos: mappedVideos,
                total: total,
                page: Math.floor(offset / limit) + 1,
                pageSize: limit,
                totalPages: Math.ceil(total / limit)
            };
        } else {
            return { videos: mappedVideos };
        }
    }

    async updateVideo(videoId, updates) {
        const objectId = new ObjectId(videoId);
        const updateDoc = {
            $set: {
                ...updates,
                updated_at: new Date()
            }
        };

        await this.db.collection('videos').updateOne(
            { _id: objectId },
            updateDoc
        );
    }

    async setVideoMetadata(fingerprint, metadata) {
        const { rating = 0, description = '' } = metadata;

        await this.db.collection('videos').updateOne(
            { fingerprint },
            {
                $set: {
                    rating,
                    description,
                    updated_at: new Date()
                }
            }
        );
    }

    async addVideoTag(fingerprint, tagName) {
        // 確保影片存在
        const video = await this.db.collection('videos').findOne({ fingerprint });
        if (!video) {
            throw new Error(`找不到指紋為 ${fingerprint} 的影片`);
        }

        // 從 video_tag_relations 集合獲取當前標籤
        const relation = await this.db.collection('video_tag_relations').findOne({ fingerprint });

        let tags = [];
        if (relation && relation.tags) {
            tags = Array.isArray(relation.tags) ? relation.tags : [];
        }

        // 添加新標籤（如果不存在）
        if (!tags.includes(tagName)) {
            tags.push(tagName);
        }

        // 更新或插入到 video_tag_relations 集合
        await this.db.collection('video_tag_relations').updateOne(
            { fingerprint },
            {
                $set: {
                    tags,
                    updated_at: new Date()
                },
                $setOnInsert: {
                    created_at: new Date()
                }
            },
            { upsert: true }
        );
    }

    async removeVideoTag(fingerprint, tagName) {
        // 確保影片存在
        const video = await this.db.collection('videos').findOne({ fingerprint });
        if (!video) {
            throw new Error(`找不到指紋為 ${fingerprint} 的影片`);
        }

        // 從 video_tag_relations 集合獲取當前標籤
        const relation = await this.db.collection('video_tag_relations').findOne({ fingerprint });

        let tags = [];
        if (relation && relation.tags) {
            tags = Array.isArray(relation.tags) ? relation.tags : [];
        }

        // 移除標籤
        tags = tags.filter(tag => tag !== tagName);

        if (tags.length === 0) {
            // 如果沒有標籤了，刪除記錄
            await this.db.collection('video_tag_relations').deleteOne({ fingerprint });
        } else {
            // 更新標籤陣列
            await this.db.collection('video_tag_relations').updateOne(
                { fingerprint },
                {
                    $set: {
                        tags,
                        updated_at: new Date()
                    }
                }
            );
        }
    }

    async deleteVideoMetadata(fingerprint) {
        // 刪除標籤關聯
        await this.db.collection('video_tag_relations').deleteMany({ fingerprint });

        // 清除 videos 集合中的元數據
        await this.db.collection('videos').updateOne(
            { fingerprint },
            {
                $set: {
                    rating: 0,
                    description: '',
                    updated_at: new Date()
                }
            }
        );
    }

    async migrateLegacyTags() {
        console.log('開始遷移舊標籤系統到新系統...');

        try {
            // 查詢所有舊的標籤關聯 (假設 MongoDB 中標籤存儲在 videos 集合的 tags 欄位中)
            const videos = await this.db.collection('videos')
                .find({
                    fingerprint: { $exists: true, $ne: null },
                    $or: [
                        { tags: { $exists: true, $ne: [] } },
                        { rating: { $exists: true } },
                        { description: { $exists: true, $ne: '' } }
                    ]
                })
                .toArray();

            if (videos.length === 0) {
                console.log('沒有找到需要遷移的舊標籤數據');
                return { migrated: 0, metadataMigrated: 0 };
            }

            console.log(`找到 ${videos.length} 個影片需要遷移`);

            let migratedTags = 0;
            let migratedMetadata = 0;

            for (const video of videos) {
                const { fingerprint, tags = [], rating = 0, description = '' } = video;

                try {
                    // 更新 videos 集合中的 rating 和 description（如果需要）
                    await this.db.collection('videos').updateOne(
                        { fingerprint },
                        {
                            $set: {
                                rating: rating || 0,
                                description: description || '',
                                updated_at: new Date()
                            }
                        }
                    );

                    // 遷移標籤關聯（使用陣列格式）
                    if (tags.length > 0) {
                        await this.db.collection('video_tag_relations').updateOne(
                            { fingerprint },
                            {
                                $set: {
                                    tags: tags.filter(tag => tag && tag.trim()),
                                    updated_at: new Date()
                                },
                                $setOnInsert: {
                                    created_at: new Date()
                                }
                            },
                            { upsert: true }
                        );
                    }

                    migratedTags++;
                    migratedMetadata++;
                } catch (error) {
                    console.warn(`遷移影片失敗 ${fingerprint}:`, error.message);
                }
            }

            console.log(`標籤遷移完成 - 遷移了 ${migratedTags} 個影片`);
            return { migrated: migratedTags, metadataMigrated: migratedMetadata };

        } catch (error) {
            console.error('標籤遷移失敗:', error);
            throw error;
        }
    }

    async deleteVideo(videoId) {
        const objectId = new ObjectId(videoId);
        await this.db.collection('videos').deleteOne({ _id: objectId });
    }

    async deleteVideoWithFile(videoId) {
        const objectId = new ObjectId(videoId);

        // 先獲取影片檔案路徑和指紋
        const video = await this.db.collection('videos').findOne({ _id: objectId });

        if (!video) {
            throw new Error('找不到指定的影片');
        }

        const filepath = video.filepath;
        const fingerprint = video.fingerprint;
        const folderPath = path.dirname(filepath);

        // 刪除資料庫記錄
        await this.db.collection('videos').deleteOne({ _id: objectId });

        // 級聯刪除相關元數據（如果有指紋）
        if (fingerprint) {
            try {
                await this.deleteVideoMetadata(fingerprint);
            } catch (metadataErr) {
                console.warn('刪除影片元數據失敗:', metadataErr);
            }
        }

        // 刪除實際檔案
        let folderDeleted = false;
        let folderDeleteError = null;

        try {
            await fs.unlink(filepath);

            // 檔案刪除成功後，檢查資料夾是否為空
            try {
                const filesInFolder = await fs.readdir(folderPath);

                // 如果資料夾為空（或只有隱藏檔案如 .DS_Store, Thumbs.db），則刪除資料夾
                const visibleFiles = filesInFolder.filter(file =>
                    !file.startsWith('.') &&
                    file !== 'Thumbs.db' &&
                    file !== 'desktop.ini'
                );

                if (visibleFiles.length === 0) {
                    // 刪除所有剩餘檔案（包括隱藏檔案）
                    for (const file of filesInFolder) {
                        await fs.unlink(path.join(folderPath, file));
                    }
                    // 刪除資料夾
                    await fs.rmdir(folderPath);
                    folderDeleted = true;
                }
            } catch (folderErr) {
                console.warn('檢查或刪除資料夾失敗:', folderErr);
                folderDeleteError = folderErr.message;
            }

            return {
                recordDeleted: true,
                fileDeleted: true,
                folderDeleted,
                folderDeleteError
            };
        } catch (fileErr) {
            console.warn('刪除檔案失敗:', fileErr);
            // 即使檔案刪除失敗，也視為部分成功（記錄已刪除）
            return { recordDeleted: true, fileDeleted: false, error: fileErr.message };
        }
    }

    async addTag(videoId, tagName) {
        // 確保標籤存在
        await this.db.collection('tags').updateOne(
            { name: tagName },
            {
                $setOnInsert: {
                    name: tagName,
                    color: '#3b82f6',
                    group_id: null,
                    created_at: new Date()
                }
            },
            { upsert: true }
        );

        // 將標籤加到影片
        const objectId = new ObjectId(videoId);
        await this.db.collection('videos').updateOne(
            { _id: objectId },
            {
                $addToSet: { tags: tagName },
                $set: { updated_at: new Date() }
            }
        );
    }

    async removeTag(videoId, tagName) {
        const objectId = new ObjectId(videoId);
        await this.db.collection('videos').updateOne(
            { _id: objectId },
            {
                $pull: { tags: tagName },
                $set: { updated_at: new Date() }
            }
        );
    }

    async getAllTags() {
        const pipeline = [
            {
                $lookup: {
                    from: 'videos',
                    localField: 'name',
                    foreignField: 'tags',
                    as: 'videos'
                }
            },
            {
                $project: {
                    name: 1,
                    color: 1,
                    group_id: 1,
                    created_at: 1,
                    video_count: { $size: '$videos' }
                }
            },
            { $sort: { name: 1 } }
        ];

        const tags = await this.db.collection('tags').aggregate(pipeline).toArray();
        return tags.map(tag => ({
            ...tag,
            id: tag._id.toString()
        }));
    }

    async createTagGroup(groupData) {
        const { name, color, description, sort_order } = groupData;
        const group = {
            name,
            color: color || '#6366f1',
            description: description || '',
            sort_order: sort_order || 0,
            created_at: new Date()
        };

        const result = await this.db.collection('tag_groups').insertOne(group);
        return result.insertedId.toString();
    }

    async getAllTagGroups() {
        const pipeline = [
            {
                $lookup: {
                    from: 'tags',
                    localField: '_id',
                    foreignField: 'group_id',
                    as: 'tags'
                }
            },
            {
                $project: {
                    name: 1,
                    color: 1,
                    description: 1,
                    sort_order: 1,
                    created_at: 1,
                    tag_count: { $size: '$tags' }
                }
            },
            { $sort: { sort_order: 1, name: 1 } }
        ];

        const groups = await this.db.collection('tag_groups').aggregate(pipeline).toArray();
        return groups.map(group => ({
            ...group,
            id: group._id.toString()
        }));
    }

    async createTag(tagData) {
        const { name, color, group_id } = tagData;
        const tag = {
            name,
            color: color || '#3b82f6',
            group_id: group_id ? new ObjectId(group_id) : null,
            created_at: new Date()
        };

        const result = await this.db.collection('tags').insertOne(tag);
        return result.insertedId.toString();
    }

    async getTagsByGroup() {
        // 先獲取所有標籤群組
        const groups = await this.db.collection('tag_groups').find().sort({ sort_order: 1, name: 1 }).toArray();

        const result = [];

        // 處理每個群組
        for (const group of groups) {
            const tags = await this.db.collection('tags').find({ group_id: group._id }).toArray();

            // 計算每個標籤的影片數量 - 從 video_tag_relations 集合查詢
            const tagsWithCount = await Promise.all(tags.map(async (tag) => {
                const count = await this.db.collection('video_tag_relations').countDocuments({
                    tags: { $in: [tag.name] }
                });

                return {
                    id: tag._id.toString(),
                    name: tag.name,
                    color: tag.color,
                    video_count: count
                };
            }));

            result.push({
                id: group._id.toString(),
                name: group.name,
                color: group.color,
                description: group.description,
                tags: tagsWithCount
            });
        }

        // 處理未分類的標籤
        const unGroupedTags = await this.db.collection('tags').find({
            $or: [{ group_id: null }, { group_id: { $exists: false } }]
        }).toArray();

        if (unGroupedTags.length > 0) {
            const tagsWithCount = await Promise.all(unGroupedTags.map(async (tag) => {
                const count = await this.db.collection('video_tag_relations').countDocuments({
                    tags: { $in: [tag.name] }
                });
                return {
                    id: tag._id.toString(),
                    name: tag.name,
                    color: tag.color,
                    video_count: count
                };
            }));

            result.push({
                id: null,
                name: '未分類',
                color: '#64748b',
                description: '未指定群組的標籤',
                tags: tagsWithCount
            });
        }

        return result;
    }


    async deleteTag(tagId) {
        const objectId = new ObjectId(tagId);

        // 先從所有影片中移除此標籤
        const tag = await this.db.collection('tags').findOne({ _id: objectId });
        if (tag) {
            await this.db.collection('videos').updateMany(
                { tags: { $in: [tag.name] } },
                { $pull: { tags: tag.name } }
            );
        }

        // 刪除標籤
        const result = await this.db.collection('tags').deleteOne({ _id: objectId });

        if (result.deletedCount === 0) {
            throw new Error('標籤不存在');
        }

        return true;
    }

    async updateTagGroup(groupId, updates) {
        try {
            console.log('更新標籤群組:', { groupId, updates });

            const updateDoc = { ...updates };
            if (updateDoc.updated_at === undefined) {
                updateDoc.updated_at = new Date();
            }

            const result = await this.db.collection('tag_groups').updateOne(
                { _id: new ObjectId(groupId) },
                { $set: updateDoc }
            );

            console.log('更新結果:', { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
            return result.modifiedCount > 0;
        } catch (error) {
            console.error('更新標籤群組失敗:', error);
            throw error;
        }
    }

    async updateTag(tagId, updates) {
        try {
            console.log('更新標籤:', { tagId, updates });

            const updateDoc = { ...updates };
            if (updateDoc.updated_at === undefined) {
                updateDoc.updated_at = new Date();
            }

            // 如果有 group_id，轉換為 ObjectId
            if (updateDoc.group_id) {
                updateDoc.group_id = new ObjectId(updateDoc.group_id);
            } else if (updateDoc.group_id === null) {
                updateDoc.group_id = null;
            }

            const result = await this.db.collection('tags').updateOne(
                { _id: new ObjectId(tagId) },
                { $set: updateDoc }
            );

            console.log('更新標籤結果:', { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount });
            return result.modifiedCount > 0;
        } catch (error) {
            console.error('更新標籤失敗:', error);
            throw error;
        }
    }

    // ========== 影片合集相關方法 ==========

    async getVideosByFolder(folderPath) {
        try {
            // 標準化路徑：統一使用反斜線，並確保結尾沒有分隔符
            let normalizedPath = folderPath.replace(/\//g, '\\').replace(/\\+$/, '');

            // 轉義正則表達式特殊字符
            const escapedPath = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // 匹配同一資料夾下的所有影片（支援兩種路徑分隔符）
            // 模式：路徑 + 分隔符 + 檔名（不含子資料夾）
            const pattern = `^${escapedPath}[\\\\/][^\\\\/]+$`;

            console.log('資料夾路徑:', folderPath);
            console.log('標準化路徑:', normalizedPath);
            console.log('搜尋正則:', pattern);

            const videos = await this.db.collection('videos').find({
                filepath: new RegExp(pattern, 'i')  // 不區分大小寫
            }).toArray();

            console.log(`找到 ${videos.length} 個影片`);

            return videos.map(video => ({
                ...video,
                id: video._id.toString()
            }));
        } catch (error) {
            console.error('獲取資料夾影片失敗:', error);
            throw error;
        }
    }

    async createVideoCollection(mainVideoFingerprint, childVideoFingerprints, collectionName, folderPath) {
        try {
            // 建立記錄陣列
            const records = [];

            // 主影片記錄
            records.push({
                fingerprint: mainVideoFingerprint,
                is_main: true,
                collection_name: collectionName,
                folder_path: folderPath,
                created_at: new Date(),
                updated_at: new Date()
            });

            // 子影片記錄
            childVideoFingerprints.forEach((fingerprint, index) => {
                records.push({
                    fingerprint: fingerprint,
                    is_main: false,
                    main_fingerprint: mainVideoFingerprint,
                    sort_order: index,
                    created_at: new Date(),
                    updated_at: new Date()
                });
            });

            // 批次插入
            const result = await this.db.collection('video_collections').insertMany(records);

            // 設定子影片的 is_master = false
            await this.db.collection('videos').updateMany(
                { fingerprint: { $in: childVideoFingerprints } },
                { $set: { is_master: false, updated_at: new Date() } }
            );

            // 確保主影片的 is_master = true
            await this.db.collection('videos').updateOne(
                { fingerprint: mainVideoFingerprint },
                { $set: { is_master: true, updated_at: new Date() } }
            );

            // 為主影片加上「合集」標籤
            await this.addVideoTag(mainVideoFingerprint, '合集');

            return { success: true, insertedCount: result.insertedCount };
        } catch (error) {
            console.error('建立影片合集失敗:', error);
            throw error;
        }
    }

    async removeVideoCollection(mainVideoFingerprint) {
        try {
            // 先獲取所有子影片的 fingerprint
            const childRecords = await this.db.collection('video_collections')
                .find({ main_fingerprint: mainVideoFingerprint, is_main: false })
                .toArray();
            const childFingerprints = childRecords.map(r => r.fingerprint);

            // 刪除合集記錄
            const collectionResult = await this.db.collection('video_collections').deleteMany({
                $or: [
                    { fingerprint: mainVideoFingerprint, is_main: true },
                    { main_fingerprint: mainVideoFingerprint, is_main: false }
                ]
            });

            // 刪除所有子影片的資料庫記錄和標籤關聯
            if (childFingerprints.length > 0) {
                await this.db.collection('videos').deleteMany(
                    { fingerprint: { $in: childFingerprints } }
                );

                await this.db.collection('video_tag_relations').deleteMany(
                    { fingerprint: { $in: childFingerprints } }
                );

                console.log(`已刪除 ${childFingerprints.length} 個子影片的資料庫記錄`);
            }

            // 刪除主影片的資料庫記錄和標籤關聯
            await this.db.collection('videos').deleteOne(
                { fingerprint: mainVideoFingerprint }
            );

            await this.db.collection('video_tag_relations').deleteMany(
                { fingerprint: mainVideoFingerprint }
            );

            console.log(`已刪除主影片和 ${childFingerprints.length} 個子影片的資料庫記錄`);

            return {
                success: collectionResult.deletedCount > 0,
                deletedCount: collectionResult.deletedCount,
                totalVideosDeleted: childFingerprints.length + 1 // 子影片 + 主影片
            };
        } catch (error) {
            console.error('刪除影片合集失敗:', error);
            throw error;
        }
    }

    async getVideoCollection(mainVideoFingerprint) {
        try {
            const mainRecord = await this.db.collection('video_collections').findOne({
                fingerprint: mainVideoFingerprint,
                is_main: true
            });

            if (!mainRecord) {
                return null;
            }

            // 查詢子影片記錄
            const childRecords = await this.db.collection('video_collections')
                .find({ main_fingerprint: mainVideoFingerprint, is_main: false })
                .sort({ sort_order: 1 })
                .toArray();

            // 查詢子影片的詳細資訊
            const childFingerprints = childRecords.map(r => r.fingerprint);
            const childVideos = await this.db.collection('videos')
                .find({ fingerprint: { $in: childFingerprints } })
                .toArray();

            // 按 sort_order 排序並組合資料
            const sortedChildVideos = childRecords.map(record => {
                const video = childVideos.find(v => v.fingerprint === record.fingerprint);
                return video ? { ...video, sort_order: record.sort_order } : null;
            }).filter(v => v !== null);

            return {
                name: mainRecord.collection_name,
                child_videos: sortedChildVideos
            };
        } catch (error) {
            console.error('取得影片合集失敗:', error);
            throw error;
        }
    }

    async updateVideoCollection(mainVideoFingerprint, updates) {
        try {
            const result = await this.db.collection('video_collections').updateOne(
                { fingerprint: mainVideoFingerprint, is_main: true },
                { $set: { ...updates, updated_at: new Date() } }
            );
            return { success: result.modifiedCount > 0 };
        } catch (error) {
            console.error('更新影片合集失敗:', error);
            throw error;
        }
    }

    async removeVideoFromCollection(mainVideoFingerprint, childFingerprint) {
        try {
            const result = await this.db.collection('video_collections').deleteOne({
                fingerprint: childFingerprint,
                is_main: false,
                main_fingerprint: mainVideoFingerprint
            });
            return { success: result.deletedCount > 0 };
        } catch (error) {
            console.error('從合集移除影片失敗:', error);
            throw error;
        }
    }

    close() {
        if (this.client) {
            this.client.close();
        }
    }
}

// 資料庫工廠類別
class DatabaseFactory {
    static async create() {
        const config = new Config();
        await config.init();
        const dbConfig = await config.getDatabaseConfig();

        if (dbConfig.type === 'mongodb') {
            const connectionString = await config.getMongoDBConnectionString();
            const database = new MongoDatabase(connectionString);
            await database.init();
            return database;
        } else {
            throw new Error('僅支援 MongoDB 資料庫。請在設定中配置 MongoDB 連線。');
        }
    }
}

module.exports = DatabaseFactory;