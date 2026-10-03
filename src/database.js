const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const fs = require('fs-extra');
const Config = require('./config');
const { getUserDataDir } = require('./appPaths');
const FileFingerprint = require('./fileFingerprint');
const { COLLECTION_TAG, COLLECTION_TAG_COLOR, SYSTEM_GROUP } = require('./systemTags');

// app_meta 內記錄「舊標籤系統已遷移」的旗標 id
const LEGACY_TAG_MIGRATION_KEY = 'legacy_tags_migrated';
// app_meta 內記錄「is_master 欄位已回填」的旗標 id
const MASTER_FLAG_BACKFILL_KEY = 'master_flag_backfilled';
// app_meta 內記錄「標籤 sort_order 欄位已回填」的旗標 id
const TAG_SORT_ORDER_BACKFILL_KEY = 'tag_sort_order_backfilled';

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

    async backfillOrphanTags() {
        throw new Error('子類別必須實作 backfillOrphanTags 方法');
    }

    async ensureCollectionTag(options) {
        throw new Error('子類別必須實作 ensureCollectionTag 方法');
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

    async reorderTags(groupId, orderedTagIds) {
        throw new Error('子類別必須實作 reorderTags 方法');
    }

    async getAllDrivePaths() {
        throw new Error('子類別必須實作 getAllDrivePaths 方法');
    }

    async getAllVideoRefs() {
        throw new Error('子類別必須實作 getAllVideoRefs 方法');
    }

    async getVideoByPath(filepath) {
        throw new Error('子類別必須實作 getVideoByPath 方法');
    }

    async recordVideoPlay(filepath) {
        throw new Error('子類別必須實作 recordVideoPlay 方法');
    }

    async setVideoDuration(filepath, seconds) {
        throw new Error('子類別必須實作 setVideoDuration 方法');
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

        // 必須在任何查詢之前完成：_masterMatch() 已改用等值比對，
        // 欄位沒補齊的話舊影片會整批從列表消失
        await this._backfillMasterFlag();
        await this._backfillTagSortOrder();
    }

    // is_master 標記「這筆要不要出現在主列表」：合集子影片為 false，其餘（含合集主影片）為 true。
    //
    // 這個欄位是後來才加的，而且只寫在 addVideo 的新增路徑 —— 更新路徑的 $set 不含 is_master，
    // 所以更早入庫的影片重新掃描再多次也補不到，只能靠 $exists:false 當成 true 兼容。
    // 但 `$or: [{ $ne: false }, { $exists: false }]` 全是否定型條件，無法用單一索引同時滿足
    // 篩選與排序，列表查詢每次都得把全部影片撈進記憶體重排（翻到後面的頁也不會變快）。
    //
    // 補齊欄位後條件才能簡化成等值比對，交給 {is_master, file_created_at, created_at} 複合索引。
    async _backfillMasterFlag() {
        const meta = this.db.collection('app_meta');
        if (await meta.findOne({ _id: MASTER_FLAG_BACKFILL_KEY })) return;

        // 缺欄位者一律視為主影片：子影片是 createVideoCollection 明確寫成 false 的，
        // 不會落在這個查詢裡
        const result = await this.db.collection('videos').updateMany(
            { is_master: { $exists: false } },
            { $set: { is_master: true } }
        );
        if (result.modifiedCount > 0) {
            console.log(`已回填 ${result.modifiedCount} 筆影片的 is_master 欄位`);
        }

        await meta.updateOne(
            { _id: MASTER_FLAG_BACKFILL_KEY },
            { $set: { completed_at: new Date() } },
            { upsert: true }
        );
    }

    // sort_order 是後來才加的欄位。Mongo 排序時「缺欄位」會排在所有數字之前，
    // 新舊混用會讓沒排過的標籤全部跳到最前面，所以先補成 0,1,2...。
    // 順序沿用現有的 _id（約等於建立順序），也就是舊版畫面上看到的順序，避免升級後無故重排
    async _backfillTagSortOrder() {
        const meta = this.db.collection('app_meta');
        if (await meta.findOne({ _id: TAG_SORT_ORDER_BACKFILL_KEY })) return;

        const tags = await this.db.collection('tags').find().toArray();
        const byGroup = new Map();
        for (const tag of tags) {
            const key = tag.group_id ? tag.group_id.toString() : '';
            if (!byGroup.has(key)) byGroup.set(key, []);
            byGroup.get(key).push(tag);
        }

        const ops = [];
        for (const list of byGroup.values()) {
            list.sort((a, b) => String(a._id).localeCompare(String(b._id)));
            list.forEach((tag, index) => {
                if (tag.sort_order !== index) {
                    ops.push({ updateOne: { filter: { _id: tag._id }, update: { $set: { sort_order: index } } } });
                }
            });
        }
        if (ops.length > 0) {
            await this.db.collection('tags').bulkWrite(ops);
            console.log(`已回填 ${ops.length} 個標籤的 sort_order 欄位`);
        }

        await meta.updateOne(
            { _id: TAG_SORT_ORDER_BACKFILL_KEY },
            { $set: { completed_at: new Date() } },
            { upsert: true }
        );
    }

    extractDatabaseName(connectionString) {
        // 從MongoDB連線字串中提取資料庫名稱
        const match = connectionString.match(/\/([^/?]+)(\?|$)/);
        return match ? match[1] : 'videonow';
    }

    // 每次啟動都會呼叫（已存在的索引是 no-op）。
    // 每個集合合併成一次 createIndexes 指令、集合之間平行送出，
    // 把原本 12 趟序列化的網路來回壓成 3 趟。
    async createIndexes() {
        await Promise.all([
            this.db.collection('videos').createIndexes([
                { key: { filepath: 1 }, unique: true },
                { key: { fingerprint: 1 }, unique: true, sparse: true },
                { key: { filename: 1 } },
                { key: { created_at: -1 } },
                { key: { is_master: 1 } },
                // 複合索引：支援常見的 is_master + 排序查詢
                { key: { is_master: 1, file_created_at: -1 } },
                { key: { is_master: 1, created_at: -1 } },
                // 列表預設排序（file_created_at, created_at）整段交給索引，
                // 省掉兩萬筆的記憶體排序，深頁也不會變慢
                { key: { is_master: 1, file_created_at: -1, created_at: -1 } }
            ]),
            this.db.collection('tags').createIndexes([
                { key: { name: 1 }, unique: true }
            ]),
            this.db.collection('tag_groups').createIndexes([
                { key: { name: 1 }, unique: true }
            ]),
            // 為video_tag_relations集合創建索引，加速標籤查詢
            this.db.collection('video_tag_relations').createIndexes([
                { key: { fingerprint: 1 }, unique: true },
                { key: { tags: 1 } }
            ])
        ]);
    }

    async addVideo(videoData) {
        const { filename, filepath, filesize, duration, description, fingerprint, file_created_at } = videoData;
        const file_mtime = videoData.file_mtime ?? null;

        try {
            const videos = this.db.collection('videos');
            const byFp = fingerprint ? await videos.findOne({ fingerprint }) : null;
            const byPath = await videos.findOne({ filepath });

            // 同指紋的記錄在別的路徑：原檔還在 = 這是複本；原檔不見了 = 檔案被搬移
            if (byFp && byFp.filepath !== filepath) {
                if (await fs.pathExists(byFp.filepath)) {
                    if (byPath) {
                        // 複本已有自己的記錄：保留記錄與標籤，指紋改成「原指紋 + 路徑雜湊」，
                        // 之後才能從任一份找到其他複本
                        const dupFingerprint = FileFingerprint.duplicateFingerprint(fingerprint, filepath);
                        if (byPath.fingerprint && byPath.fingerprint !== dupFingerprint) {
                            await this._migrateFingerprintReferences(byPath.fingerprint, dupFingerprint);
                        }
                        await videos.updateOne(
                            { _id: byPath._id },
                            {
                                $set: {
                                    filename,
                                    filesize: filesize || 0,
                                    fingerprint: dupFingerprint,
                                    file_created_at: file_created_at || null,
                                    file_mtime,
                                    updated_at: new Date()
                                }
                            }
                        );
                        return 'duplicate';
                    }
                    // 新發現的複本：另建一筆，指紋加上路徑雜湊避免與原檔衝突
                    await this._insertVideo({
                        ...videoData,
                        fingerprint: FileFingerprint.duplicateFingerprint(fingerprint, filepath)
                    });
                    return 'duplicate';
                }

                console.log(`檔案移動檢測: ${byFp.filepath} -> ${filepath}`);
                if (byPath) {
                    // 搬到一個已有記錄的路徑：把該記錄的標籤/合集併入，再刪除它，避免路徑唯一鍵衝突
                    if (byPath.fingerprint) {
                        await this._migrateFingerprintReferences(byPath.fingerprint, fingerprint);
                    }
                    await videos.deleteOne({ _id: byPath._id });
                }
            }

            const existingVideo = byFp || byPath;
            if (existingVideo) {
                // 指紋改變時（檔案內容變動或指紋演算法升級），先把標籤關聯與合集記錄
                // 一併搬到新指紋，否則會留下孤兒關聯、標籤直接消失
                if (fingerprint && existingVideo.fingerprint && existingVideo.fingerprint !== fingerprint) {
                    await this._migrateFingerprintReferences(existingVideo.fingerprint, fingerprint);
                }
                // 掃描不讀影片長度（傳 null）：內容沒變就保留先前從 FFmpeg 取得的長度，內容變了歸零待重新取得
                const keptDuration = duration || (existingVideo.fingerprint === fingerprint ? existingVideo.duration : 0);

                // 檔案已存在，更新基本檔案資訊，保留用戶設定
                await this.db.collection('videos').updateOne(
                    { _id: existingVideo._id },
                    {
                        $set: {
                            filename,
                            filepath,
                            filesize: filesize || 0,
                            duration: keptDuration || 0,
                            fingerprint,
                            file_created_at: file_created_at || null,
                            file_mtime,
                            updated_at: new Date()
                        }
                    }
                );
                return 'updated';
            }
            return await this._insertVideo(videoData);
        } catch (error) {
            throw error;
        }
    }

    // 內容相同的其他檔案（原檔與各複本共用同一個基礎指紋）
    async getDuplicateVideos(fingerprint, excludeId) {
        if (!fingerprint) return [];
        const base = FileFingerprint.baseFingerprint(fingerprint);
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const query = {
            $or: [{ fingerprint: base }, { fingerprint: { $regex: `^${escaped}:dup:` } }]
        };
        if (excludeId && ObjectId.isValid(excludeId)) query._id = { $ne: new ObjectId(excludeId) };
        const docs = await this.db.collection('videos')
            .find(query, { projection: { filename: 1, filepath: 1, filesize: 1, is_master: 1 } })
            .sort({ filepath: 1 })
            .toArray();
        return docs.map(d => ({
            id: d._id.toString(),
            filename: d.filename,
            filepath: d.filepath,
            filesize: d.filesize,
            is_master: d.is_master !== false
        }));
    }

    async _insertVideo(videoData) {
        const { filename, filepath, filesize, duration, description, fingerprint, file_created_at } = videoData;
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
            file_mtime: videoData.file_mtime ?? null,
            created_at: new Date(),
            updated_at: new Date()
        };

        const result = await this.db.collection('videos').insertOne(video);
        console.log(`添加新影片: ${filename}`);
        return result.insertedId.toString();
    }

    // 指紋變更時，把舊指紋的標籤關聯與合集記錄搬到新指紋
    async _migrateFingerprintReferences(oldFingerprint, newFingerprint) {
        try {
            // 標籤關聯：若新指紋已有關聯（理論上不會），合併標籤後刪除舊記錄
            const oldRelation = await this.db.collection('video_tag_relations').findOne({ fingerprint: oldFingerprint });
            if (oldRelation) {
                const newRelation = await this.db.collection('video_tag_relations').findOne({ fingerprint: newFingerprint });
                if (newRelation) {
                    const mergedTags = Array.from(new Set([...(newRelation.tags || []), ...(oldRelation.tags || [])]));
                    await this.db.collection('video_tag_relations').updateOne(
                        { fingerprint: newFingerprint },
                        { $set: { tags: mergedTags, updated_at: new Date() } }
                    );
                    await this.db.collection('video_tag_relations').deleteOne({ fingerprint: oldFingerprint });
                } else {
                    await this.db.collection('video_tag_relations').updateOne(
                        { fingerprint: oldFingerprint },
                        { $set: { fingerprint: newFingerprint, updated_at: new Date() } }
                    );
                }
            }

            // 合集記錄：主影片指紋與子影片的 main_fingerprint 都要跟著改
            await this.db.collection('video_collections').updateMany(
                { fingerprint: oldFingerprint },
                { $set: { fingerprint: newFingerprint, updated_at: new Date() } }
            );
            await this.db.collection('video_collections').updateMany(
                { main_fingerprint: oldFingerprint },
                { $set: { main_fingerprint: newFingerprint, updated_at: new Date() } }
            );

            console.log(`指紋變更，已遷移關聯資料: ${oldFingerprint} -> ${newFingerprint}`);
        } catch (error) {
            console.error('遷移指紋關聯資料失敗:', error);
        }
    }

    // 取得所有影片的基本參照（id/filepath/fingerprint），不分頁、不 join。
    // 供縮圖清理、缺檔清理等需要「全部影片」的維護功能使用，
    // 不可用 getVideos()（預設分頁只回傳一頁）。
    async getAllVideoRefs() {
        const docs = await this.db.collection('videos')
            .find({}, { projection: { filepath: 1, fingerprint: 1, filesize: 1, file_mtime: 1, duration: 1 } })
            .toArray();
        return docs.map(d => ({
            id: d._id.toString(),
            filepath: d.filepath,
            fingerprint: d.fingerprint || null,
            filesize: d.filesize,
            file_mtime: d.file_mtime ?? null,
            duration: d.duration || 0
        }));
    }

    // 批次刪除影片記錄（缺檔清理用）
    async deleteVideosByIds(ids) {
        if (ids.length === 0) return;
        await this.db.collection('videos').deleteMany({
            _id: { $in: ids.map(id => new ObjectId(id)) }
        });
    }

    // 以路徑查單一影片（檔案監控的刪除事件用）
    async getVideoByPath(filepath) {
        const video = await this.db.collection('videos').findOne({ filepath });
        if (!video) return null;
        return { ...video, id: video._id.toString() };
    }

    // 只看主影片（排除合集子影片）的 $match 條件。
    // 等值比對才能配合 {is_master, file_created_at, created_at} 索引直接產生排序結果；
    // 欄位由 _backfillMasterFlag() 保證在任何查詢前就已補齊。
    _masterMatch() {
        return { is_master: true };
    }

    // join video_tag_relations 並把 tags 攤平成陣列的階段
    _tagJoinStages() {
        return [
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
    }

    // 共用的基礎聚合管道：過濾子影片、join 標籤
    _buildBasePipeline() {
        return [
            { $match: this._masterMatch() },
            ...this._tagJoinStages()
        ];
    }

    // 使用者輸入轉成字面比對的 RegExp（避免 "(" "[" 等字元讓查詢拋錯或回溯爆炸）
    _literalRegex(text) {
        return new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    // 組合篩選條件（getVideos / searchVideos / getTagCountsForFilter 共用）。
    // 標籤條件先查 video_tag_relations（有索引）換成 fingerprint $in，
    // 讓後續管道不必對全部影片做 $lookup，只在分頁後 join 一頁的標籤。
    async _buildMatch(searchTerm, tags = [], filters = {}) {
        const match = { ...this._masterMatch() };

        if (searchTerm && searchTerm.trim()) {
            const searchRegex = this._literalRegex(searchTerm.trim());
            match.$or = [
                { filename: searchRegex },
                { description: searchRegex }
            ];
            // 合集子影片（is_master = false）不會出現在列表，檔名符合時回傳其所屬合集的主影片
            const mainFingerprints = await this._findCollectionMainsByChildFilename(searchRegex);
            if (mainFingerprints.length > 0) {
                match.$or.push({ fingerprint: { $in: mainFingerprints } });
            }
        }

        if (filters.filename) {
            match.filename = this._literalRegex(filters.filename);
        }

        const allTags = [...(tags || [])];
        if (filters.tag) allTags.push(filters.tag);
        if (allTags.length > 0) {
            const relations = await this.db.collection('video_tag_relations')
                .find({ tags: { $all: allTags } })
                .project({ fingerprint: 1 })
                .toArray();
            match.fingerprint = { $in: relations.map(r => r.fingerprint) };
        }

        if (filters.rating && filters.rating > 0) {
            match.rating = filters.rating;
        }

        if (filters.drivePath && filters.drivePath.trim()) {
            // 硬碟路徑篩選：匹配第二層路徑
            // 例如：\\192.168.1.147\16tb-SN-2BH171AN\...
            const escapedDrive = filters.drivePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            match.filepath = new RegExp(`[\\\\/]{2}[^\\\\/]+[\\\\/]${escapedDrive}[\\\\/]`, 'i');
        }

        if (filters.duplicatesOnly) {
            // 標籤篩選可能已經設了 match.fingerprint，用 $and 疊加
            const { fingerprints } = await this._duplicateGroups();
            match.$and = [...(match.$and || []), { fingerprint: { $in: fingerprints } }];
        }

        if (filters.unwatchedOnly) {
            // null 也會命中沒有 play_count 欄位的舊文件
            match.play_count = { $in: [0, null] };
        }

        return match;
    }

    // 找出所有重複檔案組（只讀取，不寫入任何欄位）。
    // 每組至少有一份複本的指紋帶 ":dup:"，從這些複本回推基礎指紋，再確認原檔是否還在。
    // 回傳 sizeByBase：基礎指紋 -> 該組檔案數（>1），fingerprints：所有屬於重複組的指紋
    async _duplicateGroups() {
        const videos = this.db.collection('videos');
        const copies = await videos
            .find({ fingerprint: { $regex: ':dup:' } }, { projection: { fingerprint: 1 } })
            .toArray();

        const sizeByBase = new Map();
        const fingerprintsByBase = new Map();
        for (const { fingerprint } of copies) {
            const base = FileFingerprint.baseFingerprint(fingerprint);
            sizeByBase.set(base, (sizeByBase.get(base) || 0) + 1);
            if (!fingerprintsByBase.has(base)) fingerprintsByBase.set(base, []);
            fingerprintsByBase.get(base).push(fingerprint);
        }

        const bases = [...sizeByBase.keys()];
        if (bases.length > 0) {
            const originals = await videos
                .find({ fingerprint: { $in: bases } }, { projection: { fingerprint: 1 } })
                .toArray();
            for (const { fingerprint } of originals) {
                sizeByBase.set(fingerprint, sizeByBase.get(fingerprint) + 1);
                fingerprintsByBase.get(fingerprint).push(fingerprint);
            }
        }

        const fingerprints = [];
        for (const [base, size] of sizeByBase) {
            if (size > 1) {
                fingerprints.push(...fingerprintsByBase.get(base));
            } else {
                sizeByBase.delete(base);
            }
        }
        return { sizeByBase, fingerprints };
    }

    // 重複檔案統計：有重複的影片數（列表可見的主影片）與重複組數
    async getDuplicateSummary() {
        const { sizeByBase, fingerprints } = await this._duplicateGroups();
        const videos = fingerprints.length === 0 ? 0 : await this.db.collection('videos')
            .countDocuments({ ...this._masterMatch(), fingerprint: { $in: fingerprints } });
        return { videos, groups: sizeByBase.size };
    }

    // 排序欄位白名單；預設排序對應 {is_master, file_created_at, created_at} 索引
    _buildSort(filters = {}) {
        const allowed = ['file_created_at', 'created_at', 'filename', 'filesize', 'duration', 'rating', 'play_count', 'last_played_at'];
        const field = allowed.includes(filters.sortBy) ? filters.sortBy : 'file_created_at';
        const dir = filters.sortOrder === 'asc' ? 1 : -1;
        const sort = { [field]: dir };
        if (field !== 'created_at') sort.created_at = dir;
        return sort;
    }

    async _queryVideosPage(searchTerm, tags, filters) {
        const limit = filters.limit || 9;
        const offset = filters.offset || 0;
        const needCount = filters.count !== false;

        const match = await this._buildMatch(searchTerm, tags, filters);
        const sort = filters.duplicatesOnly
            ? { fingerprint: 1, ...this._buildSort(filters) }
            : this._buildSort(filters);
        const pipeline = [
            { $match: match },
            { $sort: sort },
            { $skip: offset },
            { $limit: limit },
            ...this._tagJoinStages(),
            { $project: { tag_relation: 0 } }
        ];
        // 檔名排序不分大小寫
        const options = filters.sortBy === 'filename' ? { collation: { locale: 'en', strength: 2 } } : {};

        const videos = await this.db.collection('videos').aggregate(pipeline, options).toArray();
        const { sizeByBase } = await this._duplicateGroups();
        const mappedVideos = videos.map(video => {
            const size = video.fingerprint ? sizeByBase.get(FileFingerprint.baseFingerprint(video.fingerprint)) : 0;
            return {
                ...video,
                id: video._id.toString(),
                tags: video.tags || [],
                duplicate_count: size ? size - 1 : 0
            };
        });

        if (!needCount) return { videos: mappedVideos };

        const total = await this.db.collection('videos').countDocuments(match);
        return {
            videos: mappedVideos,
            total,
            page: Math.floor(offset / limit) + 1,
            pageSize: limit,
            totalPages: Math.ceil(total / limit)
        };
    }

    async getVideos(filters = {}) {
        return this._queryVideosPage(null, [], filters);
    }

    // 找出「子影片檔名符合」的合集主影片指紋
    async _findCollectionMainsByChildFilename(searchRegex) {
        const matchingChildren = await this.db.collection('videos')
            .find({ is_master: false, filename: searchRegex })
            .project({ fingerprint: 1 })
            .toArray();
        if (matchingChildren.length === 0) return [];

        const childFingerprints = matchingChildren.map(v => v.fingerprint).filter(Boolean);
        const relations = await this.db.collection('video_collections')
            .find({ is_main: false, fingerprint: { $in: childFingerprints } })
            .project({ main_fingerprint: 1 })
            .toArray();
        return [...new Set(relations.map(r => r.main_fingerprint).filter(Boolean))];
    }

    async searchVideos(searchTerm, tags = [], filters = {}) {
        return this._queryVideosPage(searchTerm, tags, filters);
    }

    // 多面向篩選用：依目前篩選條件回傳每個標籤的影片計數
    // 回傳 { tagName: count } 物件，渲染端可即時更新側邊欄計數
    async getTagCountsForFilter(searchTerm, tags = [], filters = {}) {
        const match = await this._buildMatch(searchTerm, tags, filters);
        const pipeline = [
            { $match: match },
            ...this._tagJoinStages(),
            { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
            { $group: { _id: '$tags', count: { $sum: 1 } } }
        ];

        const results = await this.db.collection('videos').aggregate(pipeline).toArray();
        const counts = {};
        for (const r of results) {
            counts[r._id] = r.count;
        }
        return counts;
    }

    // 統計孤兒標籤關聯數量：video_tag_relations 中，指紋已不存在於 videos 集合者
    // （影片已刪除，或重新掃描後指紋改變所殘留）。這類關聯會讓標籤計數虛高。
    async countOrphanTagRelations() {
        const videoFingerprints = await this.db.collection('videos').distinct('fingerprint');
        return this.db.collection('video_tag_relations').countDocuments({
            fingerprint: { $nin: videoFingerprints }
        });
    }

    // 清理孤兒標籤關聯，回傳實際刪除筆數
    async cleanupOrphanTagRelations() {
        const videoFingerprints = await this.db.collection('videos').distinct('fingerprint');
        const result = await this.db.collection('video_tag_relations').deleteMany({
            fingerprint: { $nin: videoFingerprints }
        });
        return { removed: result.deletedCount };
    }

    // 只保留白名單欄位，避免 renderer 傳入任意欄位寫進資料庫（與 SQLite 版一致）
    _pickAllowed(updates, allowed) {
        const picked = {};
        for (const key of allowed) {
            if (updates[key] !== undefined) picked[key] = updates[key];
        }
        return picked;
    }

    async updateVideo(videoId, updates) {
        const objectId = new ObjectId(videoId);
        const updateDoc = {
            $set: {
                ...this._pickAllowed(updates, ['filename', 'filepath', 'filesize', 'duration', 'description', 'rating', 'is_master', 'fingerprint', 'file_created_at']),
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

    // 寫入影片長度（秒）；路徑不在資料庫時回傳 false
    async setVideoDuration(filepath, seconds) {
        const result = await this.db.collection('videos').updateOne({ filepath }, { $set: { duration: seconds } });
        return result.matchedCount > 0;
    }

    // 記錄一次開啟（開啟次數 +1、更新最後開啟時間）；路徑不在資料庫時回傳 null
    async recordVideoPlay(filepath) {
        const video = await this.db.collection('videos').findOneAndUpdate(
            { filepath },
            { $inc: { play_count: 1 }, $set: { last_played_at: new Date() } },
            { returnDocument: 'after', projection: { play_count: 1, last_played_at: 1 } }
        );
        if (!video) return null;
        return { play_count: video.play_count, last_played_at: video.last_played_at };
    }

    async addVideoTag(fingerprint, tagName) {
        await this._assertVideoExists(fingerprint);

        // 原子操作：連續快速點擊也不會互相覆蓋
        await this.db.collection('video_tag_relations').updateOne(
            { fingerprint },
            {
                $addToSet: { tags: tagName },
                $set: { updated_at: new Date() },
                $setOnInsert: { created_at: new Date() }
            },
            { upsert: true }
        );
    }

    async removeVideoTag(fingerprint, tagName) {
        await this._assertVideoExists(fingerprint);

        await this.db.collection('video_tag_relations').updateOne(
            { fingerprint },
            { $pull: { tags: tagName }, $set: { updated_at: new Date() } }
        );
        // 沒有標籤了就刪除記錄
        await this.db.collection('video_tag_relations').deleteOne({ fingerprint, tags: { $size: 0 } });
    }

    async _assertVideoExists(fingerprint) {
        const exists = await this.db.collection('videos').countDocuments({ fingerprint }, { limit: 1 });
        if (!exists) {
            throw new Error(`找不到指紋為 ${fingerprint} 的影片`);
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

    // 舊版把標籤直接存在 videos 文件的 tags 陣列，新版改用 video_tag_relations 集合。
    //
    // 舊實作的條件包含 `rating: { $exists: true }`，而 addVideo 一定會寫入 rating，
    // 等於每次啟動都撈出「全部影片的完整文件」，再對每一部影片各送一次 updateOne
    // 把 rating/description 原樣寫回自己（純 no-op，只是順便改掉 updated_at）。
    // 兩萬部影片 = 兩萬次序列化的網路來回，啟動因此要多等十幾秒。
    //
    // 現在只找真正還帶有非空 tags 陣列的舊資料，寫入改用單一 bulkWrite，
    // 並在 app_meta 記下完成旗標，之後啟動連掃描都省掉。
    async migrateLegacyTags() {
        const meta = this.db.collection('app_meta');

        // 旗標存在資料庫（而非本機設定檔），才能跟著資料一起走：
        // 換一台電腦連同一個 Mongo 不會又跑一次遷移
        const done = await meta.findOne({ _id: LEGACY_TAG_MIGRATION_KEY });
        if (done) {
            return { migrated: 0, metadataMigrated: 0 };
        }

        try {
            const videos = await this.db.collection('videos')
                .find({
                    fingerprint: { $exists: true, $ne: null },
                    tags: { $exists: true, $ne: [] }
                })
                .project({ fingerprint: 1, tags: 1 })
                .toArray();

            const now = new Date();
            const ops = [];
            for (const { fingerprint, tags } of videos) {
                const cleaned = (tags || []).filter(tag => tag && tag.trim());
                if (cleaned.length === 0) continue;
                ops.push({
                    updateOne: {
                        filter: { fingerprint },
                        update: {
                            $set: { tags: cleaned, updated_at: now },
                            $setOnInsert: { created_at: now }
                        },
                        upsert: true
                    }
                });
            }

            if (ops.length > 0) {
                console.log(`開始遷移舊標籤系統到新系統...（${ops.length} 部影片）`);
                await this.db.collection('video_tag_relations').bulkWrite(ops, { ordered: false });
                console.log(`標籤遷移完成 - 遷移了 ${ops.length} 個影片`);
            }

            await meta.updateOne(
                { _id: LEGACY_TAG_MIGRATION_KEY },
                { $set: { completed_at: new Date() } },
                { upsert: true }
            );

            return { migrated: ops.length, metadataMigrated: ops.length };

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

        // 先刪除實際檔案，成功後才刪除資料庫記錄
        // 若檔案刪不掉卻先清掉記錄，之後就無從追查這個殘留檔案
        try {
            await fs.unlink(filepath);
        } catch (fileErr) {
            console.warn('刪除檔案失敗，保留資料庫記錄:', fileErr);
            return { recordDeleted: false, fileDeleted: false, error: fileErr.message };
        }

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

        // 檔案刪除成功後，檢查資料夾是否為空
        let folderDeleted = false;
        let folderDeleteError = null;

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

    // 「合集」標籤放進「系統」群組（與 SQLite 版一致：只搬未分類的，onlyIfUsed 供啟動檢查用）
    async ensureCollectionTag({ onlyIfUsed = false } = {}) {
        const tags = this.db.collection('tags');
        const tag = await tags.findOne({ name: COLLECTION_TAG });
        if (tag && tag.group_id) return false;
        if (!tag && onlyIfUsed &&
            !await this.db.collection('video_tag_relations').findOne({ tags: COLLECTION_TAG })) {
            return false;
        }

        const group = await this.db.collection('tag_groups').findOne({ name: SYSTEM_GROUP.name });
        const groupId = group
            ? group._id
            : new ObjectId(await this.createTagGroup({ ...SYSTEM_GROUP }));

        if (tag) {
            await tags.updateOne({ _id: tag._id }, {
                $set: { group_id: groupId, sort_order: await this._nextTagSortOrder(groupId), updated_at: new Date() }
            });
        } else {
            await this.createTag({ name: COLLECTION_TAG, color: COLLECTION_TAG_COLOR, group_id: groupId.toString() });
        }
        return true;
    }

    // 影片有關聯、卻沒有標籤資料的名稱補建到未分類（與 SQLite 版一致，只看仍存在的影片）
    async backfillOrphanTags() {
        const videoFingerprints = await this.db.collection('videos').distinct('fingerprint');
        const used = await this.db.collection('video_tag_relations')
            .distinct('tags', { fingerprint: { $in: videoFingerprints } });
        const existing = new Set(await this.db.collection('tags').distinct('name'));
        const names = used.filter(name => typeof name === 'string' && name && !existing.has(name)).sort();
        for (const name of names) {
            await this.createTag({ name });
        }
        return { created: names.length, names };
    }

    // 新標籤排到所屬群組末端；若一律給 0，新標籤會全部擠在最前面
    async _nextTagSortOrder(groupId) {
        const filter = groupId
            ? { group_id: groupId }
            : { $or: [{ group_id: null }, { group_id: { $exists: false } }] };
        const last = await this.db.collection('tags').find(filter).sort({ sort_order: -1 }).limit(1).next();
        return last && typeof last.sort_order === 'number' ? last.sort_order + 1 : 0;
    }

    async createTag(tagData) {
        const { name, color, description, description_image, group_id } = tagData;
        const groupId = group_id ? new ObjectId(group_id) : null;
        const tag = {
            name,
            color: color || '#3b82f6',
            description: description || '',
            description_image: description_image || '',
            group_id: groupId,
            sort_order: await this._nextTagSortOrder(groupId),
            created_at: new Date()
        };

        const result = await this.db.collection('tags').insertOne(tag);
        return result.insertedId.toString();
    }

    // 群組內重新排序：整組重新編號 0..n-1（與 SQLite 實作一致）
    async reorderTags(groupId, orderedTagIds) {
        const filter = groupId
            ? { group_id: new ObjectId(groupId) }
            : { $or: [{ group_id: null }, { group_id: { $exists: false } }] };
        const current = await this.db.collection('tags').find(filter, { projection: { _id: 1 } }).toArray();
        const valid = new Set(current.map(t => t._id.toString()));
        const ids = (orderedTagIds || []).map(String).filter(id => valid.has(id));
        // 必須是整個群組的完整排列，否則沒列到的標籤會留著舊序號而錯位
        if (new Set(ids).size !== valid.size) {
            throw new Error('排序清單與群組內的標籤不一致');
        }
        if (ids.length === 0) return true;

        await this.db.collection('tags').bulkWrite(ids.map((id, index) => ({
            updateOne: {
                filter: { _id: new ObjectId(id) },
                update: { $set: { sort_order: index, updated_at: new Date() } }
            }
        })));
        return true;
    }

    async getTagsByGroup() {
        // 一次聚合取得所有標籤的影片計數，避免 N+1 查詢。
        // 計數須從 videos 集合出發並套用 _buildBasePipeline（排除子影片、只算實際存在的影片），
        // 才會與列表篩選 / getTagCountsForFilter 的結果一致；
        // 直接數 video_tag_relations 會把子影片與孤兒關聯也算進去，導致「總數 > 實際搜到的數量」。
        const [groups, allTags, tagCounts] = await Promise.all([
            this.db.collection('tag_groups').find().sort({ sort_order: 1, name: 1 }).toArray(),
            this.db.collection('tags').find().sort({ sort_order: 1, name: 1 }).toArray(),
            this.db.collection('videos').aggregate([
                ...this._buildBasePipeline(),
                { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
                { $group: { _id: '$tags', count: { $sum: 1 } } }
            ]).toArray()
        ]);

        // 建立 tagName -> count 的 Map
        const countMap = new Map(tagCounts.map(t => [t._id, t.count]));

        const mapTag = (tag) => ({
            id: tag._id.toString(),
            name: tag.name,
            color: tag.color,
            description: tag.description || '',
            description_image: tag.description_image || '',
            video_count: countMap.get(tag.name) || 0
        });

        const result = groups.map(group => ({
            id: group._id.toString(),
            name: group.name,
            color: group.color,
            description: group.description,
            tags: allTags
                .filter(t => t.group_id && t.group_id.toString() === group._id.toString())
                .map(mapTag)
        }));

        // 處理未分類的標籤
        const ungrouped = allTags.filter(t => !t.group_id);
        if (ungrouped.length > 0) {
            result.push({
                id: null,
                name: '未分類',
                color: '#64748b',
                description: '未指定群組的標籤',
                tags: ungrouped.map(mapTag)
            });
        }

        return result;
    }

    async getAllDrivePaths() {
        try {
            // 使用聚合管道提取所有影片的第二層路徑
            const pipeline = [
                {
                    $project: {
                        // 將路徑分割成陣列
                        pathParts: {
                            $split: [
                                // 先統一替換成反斜線
                                { $replaceAll: { input: "$filepath", find: "/", replacement: "\\" } },
                                "\\"
                            ]
                        }
                    }
                },
                {
                    $project: {
                        // 提取第二層路徑（索引 1）
                        // 對於 \\192.168.1.147\16tb-SN-2BH171AN\... 路徑
                        // 分割後: ["", "", "192.168.1.147", "16tb-SN-2BH171AN", ...]
                        // 我們需要索引 3
                        drivePath: { $arrayElemAt: ["$pathParts", 3] }
                    }
                },
                {
                    $match: {
                        drivePath: { $ne: null, $ne: "" }
                    }
                },
                {
                    $group: {
                        _id: "$drivePath",
                        count: { $sum: 1 }
                    }
                },
                {
                    $sort: { count: -1 }
                },
                {
                    $project: {
                        _id: 0,
                        path: "$_id",
                        count: 1
                    }
                }
            ];

            const drives = await this.db.collection('videos').aggregate(pipeline).toArray();
            return drives;
        } catch (error) {
            console.error('獲取硬碟路徑失敗:', error);
            return [];
        }
    }


    async deleteTag(tagId) {
        const objectId = new ObjectId(tagId);

        // 先從所有影片中移除此標籤（與 SQLite 版一致：清掉 video_tag_relations 的關聯）
        const tag = await this.db.collection('tags').findOne({ _id: objectId });
        if (tag) {
            await this.db.collection('video_tag_relations').updateMany(
                { tags: tag.name },
                { $pull: { tags: tag.name }, $set: { updated_at: new Date() } }
            );
            await this.db.collection('video_tag_relations').deleteMany({ tags: { $size: 0 } });
            // 舊版資料把標籤直接存在 videos.tags
            await this.db.collection('videos').updateMany(
                { tags: tag.name },
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

    async deleteTagGroup(groupId) {
        const objectId = new ObjectId(groupId);

        // 群組內的標籤移到未分類，而不是連帶刪除
        await this.db.collection('tags').updateMany(
            { group_id: objectId },
            { $set: { group_id: null, updated_at: new Date() } }
        );

        const result = await this.db.collection('tag_groups').deleteOne({ _id: objectId });
        if (result.deletedCount === 0) {
            throw new Error('標籤群組不存在');
        }
        return true;
    }

    async updateTagGroup(groupId, updates) {
        try {
            console.log('更新標籤群組:', { groupId, updates });

            const updateDoc = this._pickAllowed(updates, ['name', 'color', 'description', 'sort_order']);
            updateDoc.updated_at = new Date();

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

            // 先取得舊標籤，才能判斷名稱是否真的改變並同步關聯
            const existing = await this.db.collection('tags').findOne({ _id: new ObjectId(tagId) });
            if (!existing) return false;

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

            // 換群組時排到新群組末端，否則會沿用舊群組的序號插進中間
            if (updates.group_id !== undefined) {
                const oldGroupId = existing.group_id ? existing.group_id.toString() : null;
                const newGroupId = updateDoc.group_id ? updateDoc.group_id.toString() : null;
                if (oldGroupId !== newGroupId) {
                    updateDoc.sort_order = await this._nextTagSortOrder(updateDoc.group_id);
                }
            }

            const result = await this.db.collection('tags').updateOne(
                { _id: new ObjectId(tagId) },
                { $set: updateDoc }
            );

            // 名稱有變更時，同步更新所有影片的標籤關聯（關聯以名稱存放）；沒變則完全不動關聯
            const renamed = updates.name && updates.name !== existing.name;
            if (renamed) {
                const oldName = existing.name;
                const newName = updates.name;
                // 用聚合管線：把陣列中的舊名換成新名，並以 $setUnion 去重
                // （避免影片原本就同時有新舊兩個標籤而造成重複）
                const relResult = await this.db.collection('video_tag_relations').updateMany(
                    { tags: oldName },
                    [{
                        $set: {
                            tags: {
                                $setUnion: [{
                                    $map: {
                                        input: '$tags',
                                        as: 't',
                                        in: { $cond: [{ $eq: ['$$t', oldName] }, newName, '$$t'] }
                                    }
                                }, []]
                            },
                            updated_at: new Date()
                        }
                    }]
                );
                console.log('標籤改名，已同步關聯數:', relResult.modifiedCount);
            }

            console.log('更新標籤結果:', { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, renamed });
            return result.modifiedCount > 0 || renamed;
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

            // 為主影片加上「合集」標籤，並確保它在「系統」群組
            await this.addVideoTag(mainVideoFingerprint, COLLECTION_TAG);
            await this.ensureCollectionTag();

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

    close() {
        if (this.client) {
            this.client.close();
        }
    }
}

// 資料庫工廠類別
class DatabaseFactory {
    static getSQLiteDbPath() {
        // 存 userData：舊版放在程式目錄旁，重新 package 會連整個資料庫一起被覆蓋
        return path.join(getUserDataDir(), 'videonow.db');
    }

    static async create() {
        const config = new Config();
        await config.init();
        const dbConfig = await config.getDatabaseConfig();

        if (dbConfig.type === 'mongodb') {
            const connectionString = await config.getMongoDBConnectionString();
            const database = new MongoDatabase(connectionString);
            await database.init();
            return database;
        } else if (dbConfig.type === 'sqlite') {
            // 延遲載入，避免使用 MongoDB 時也要求 better-sqlite3 原生模組
            const SQLiteDatabase = require('./sqliteDatabase');
            const database = new SQLiteDatabase(DatabaseFactory.getSQLiteDbPath());
            await database.init();
            return database;
        } else {
            throw new Error(`不支援的資料庫類型: ${dbConfig.type}。請在設定中選擇 SQLite 或 MongoDB。`);
        }
    }
}

module.exports = DatabaseFactory;
module.exports.MongoDatabase = MongoDatabase;