const sqlite3 = require('sqlite3').verbose();
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

// SQLite 資料庫實作
class SQLiteDatabase extends DatabaseInterface {
    constructor(dbPath) {
        super();
        this.dbPath = dbPath || path.join(__dirname, '../data/videos.db');
        this.db = null;
    }

    async init() {
        await fs.ensureDir(path.dirname(this.dbPath));

        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    reject(err);
                } else {
                    this.createTables().then(resolve).catch(reject);
                }
            });
        });
    }

    async createTables() {
        const createVideosTable = `
            CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL UNIQUE,
                filesize INTEGER,
                duration INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                description TEXT,
                rating INTEGER DEFAULT 0
            )
        `;

        const createTagGroupsTable = `
            CREATE TABLE IF NOT EXISTS tag_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                color TEXT DEFAULT '#6366f1',
                description TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;

        const createTagsTableOld = `
            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                color TEXT DEFAULT '#3b82f6',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;

        const createVideoTagsTable = `
            CREATE TABLE IF NOT EXISTS video_tags (
                video_id INTEGER,
                tag_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (video_id, tag_id),
                FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            )
        `;

        const createIndexes = [
            'CREATE INDEX IF NOT EXISTS idx_videos_filepath ON videos(filepath)',
            'CREATE INDEX IF NOT EXISTS idx_videos_filename ON videos(filename)',
            'CREATE INDEX IF NOT EXISTS idx_tag_groups_name ON tag_groups(name)',
            'CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)',
            'CREATE INDEX IF NOT EXISTS idx_tags_group ON tags(group_id)',
            'CREATE INDEX IF NOT EXISTS idx_video_tags_video ON video_tags(video_id)',
            'CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_id)'
        ];

        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(createVideosTable);
                this.db.run(createTagGroupsTable);
                this.db.run(createTagsTableOld);
                this.db.run(createVideoTagsTable);

                this.db.run(`ALTER TABLE tags ADD COLUMN group_id INTEGER`, (err) => {
                    // 忽略錯誤，可能是欄位已經存在
                });

                this.db.run(`DROP INDEX IF EXISTS sqlite_autoindex_tags_1`);

                createIndexes.forEach(indexSql => {
                    this.db.run(indexSql);
                });

                resolve();
            });
        });
    }

    async addVideo(videoData) {
        const { filename, filepath, filesize, duration, description } = videoData;

        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR REPLACE INTO videos (filename, filepath, filesize, duration, description, updated_at)
                VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `;

            this.db.run(sql, [filename, filepath, filesize, duration, description], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }

    async getVideos(filters = {}) {
        let sql = `
            SELECT v.*, GROUP_CONCAT(t.name) as tags
            FROM videos v
            LEFT JOIN video_tags vt ON v.id = vt.video_id
            LEFT JOIN tags t ON vt.tag_id = t.id
        `;

        const params = [];
        const conditions = [];

        if (filters.filename) {
            conditions.push('v.filename LIKE ?');
            params.push(`%${filters.filename}%`);
        }

        if (filters.tag) {
            conditions.push('t.name = ?');
            params.push(filters.tag);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        sql += ' GROUP BY v.id ORDER BY v.created_at DESC';

        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    const videos = rows.map(row => ({
                        ...row,
                        tags: row.tags ? row.tags.split(',') : []
                    }));
                    resolve(videos);
                }
            });
        });
    }

    async addTag(videoId, tagName) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                reject(new Error('Database not initialized'));
                return;
            }

            this.db.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [tagName], (err) => {
                if (err) {
                    reject(err);
                    return;
                }

                this.db.get('SELECT id FROM tags WHERE name = ?', [tagName], (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (!row) {
                        const error = new Error(`Tag '${tagName}' not found after insert`);
                        reject(error);
                        return;
                    }

                    const tagId = row.id;
                    this.db.run('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)',
                        [videoId, tagId], (err) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                });
            });
        });
    }

    async removeTag(videoId, tagName) {
        return new Promise((resolve, reject) => {
            const sql = `
                DELETE FROM video_tags
                WHERE video_id = ? AND tag_id = (
                    SELECT id FROM tags WHERE name = ?
                )
            `;

            this.db.run(sql, [videoId, tagName], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async getAllTags() {
        return new Promise((resolve, reject) => {
            const sql = `
                SELECT t.*, COUNT(vt.video_id) as video_count
                FROM tags t
                LEFT JOIN video_tags vt ON t.id = vt.tag_id
                GROUP BY t.id
                ORDER BY t.name
            `;

            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    async searchVideos(searchTerm, tags = []) {
        let sql = `
            SELECT DISTINCT v.*, GROUP_CONCAT(t.name) as tags
            FROM videos v
            LEFT JOIN video_tags vt ON v.id = vt.video_id
            LEFT JOIN tags t ON vt.tag_id = t.id
        `;

        const params = [];
        const conditions = [];

        if (searchTerm && searchTerm.trim()) {
            conditions.push('(v.filename LIKE ? OR v.description LIKE ?)');
            params.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }

        if (tags.length > 0) {
            const tagPlaceholders = tags.map(() => '?').join(',');
            conditions.push(`v.id IN (
                SELECT DISTINCT vt2.video_id
                FROM video_tags vt2
                JOIN tags t2 ON vt2.tag_id = t2.id
                WHERE t2.name IN (${tagPlaceholders})
            )`);
            params.push(...tags);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        sql += ' GROUP BY v.id ORDER BY v.created_at DESC';

        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    const videos = rows.map(row => ({
                        ...row,
                        tags: row.tags ? row.tags.split(',') : []
                    }));
                    resolve(videos);
                }
            });
        });
    }

    async deleteVideo(videoId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM videos WHERE id = ?', [videoId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async updateVideo(videoId, updates) {
        const fields = Object.keys(updates);
        const values = Object.values(updates);

        if (fields.length === 0) return;

        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const sql = `UPDATE videos SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;

        return new Promise((resolve, reject) => {
            this.db.run(sql, [...values, videoId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async createTagGroup(groupData) {
        const { name, color, description, sort_order } = groupData;
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO tag_groups (name, color, description, sort_order)
                VALUES (?, ?, ?, ?)
            `;
            this.db.run(sql, [name, color || '#6366f1', description || '', sort_order || 0], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }

    async getAllTagGroups() {
        return new Promise((resolve, reject) => {
            this.db.all("PRAGMA table_info(tags)", (err, columns) => {
                if (err) {
                    reject(err);
                    return;
                }

                const hasGroupId = columns.some(col => col.name === 'group_id');

                let sql;
                if (hasGroupId) {
                    sql = `
                        SELECT tg.*, COUNT(t.id) as tag_count
                        FROM tag_groups tg
                        LEFT JOIN tags t ON tg.id = t.group_id
                        GROUP BY tg.id
                        ORDER BY tg.sort_order, tg.name
                    `;
                } else {
                    sql = `
                        SELECT *, 0 as tag_count
                        FROM tag_groups
                        ORDER BY sort_order, name
                    `;
                }

                this.db.all(sql, [], (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows);
                    }
                });
            });
        });
    }

    async updateTagGroup(groupId, updates) {
        const fields = Object.keys(updates);
        const values = Object.values(updates);

        if (fields.length === 0) return;

        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const sql = `UPDATE tag_groups SET ${setClause} WHERE id = ?`;

        return new Promise((resolve, reject) => {
            this.db.run(sql, [...values, groupId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async deleteTagGroup(groupId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM tag_groups WHERE id = ?', [groupId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async createTag(tagData) {
        const { name, color, group_id } = tagData;
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT INTO tags (name, color, group_id)
                VALUES (?, ?, ?)
            `;
            this.db.run(sql, [name, color || '#3b82f6', group_id || null], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            });
        });
    }

    async getTagsByGroup() {
        return new Promise((resolve, reject) => {
            this.db.all("PRAGMA table_info(tags)", (err, columns) => {
                if (err) {
                    reject(err);
                    return;
                }

                const hasGroupId = columns.some(col => col.name === 'group_id');

                let sql;
                if (hasGroupId) {
                    sql = `
                        SELECT
                            tg.id as group_id,
                            tg.name as group_name,
                            tg.color as group_color,
                            tg.description as group_description,
                            t.id as tag_id,
                            t.name as tag_name,
                            t.color as tag_color,
                            COUNT(vt.video_id) as video_count
                        FROM tag_groups tg
                        LEFT JOIN tags t ON tg.id = t.group_id
                        LEFT JOIN video_tags vt ON t.id = vt.tag_id
                        GROUP BY tg.id, t.id

                        UNION ALL

                        SELECT
                            NULL as group_id,
                            '未分類' as group_name,
                            '#64748b' as group_color,
                            '未指定群組的標籤' as group_description,
                            t.id as tag_id,
                            t.name as tag_name,
                            t.color as tag_color,
                            COUNT(vt.video_id) as video_count
                        FROM tags t
                        LEFT JOIN video_tags vt ON t.id = vt.tag_id
                        WHERE t.group_id IS NULL
                        GROUP BY t.id

                        ORDER BY group_id, tag_name
                    `;
                } else {
                    sql = `
                        SELECT
                            NULL as group_id,
                            '未分類' as group_name,
                            '#64748b' as group_color,
                            '未指定群組的標籤' as group_description,
                            t.id as tag_id,
                            t.name as tag_name,
                            t.color as tag_color,
                            COUNT(vt.video_id) as video_count
                        FROM tags t
                        LEFT JOIN video_tags vt ON t.id = vt.tag_id
                        GROUP BY t.id
                        ORDER BY t.name
                    `;
                }

                this.db.all(sql, [], (err, rows) => {
                    if (err) {
                        reject(err);
                    } else {
                        const groups = {};

                        rows.forEach(row => {
                            const groupKey = row.group_id || 'uncategorized';

                            if (!groups[groupKey]) {
                                groups[groupKey] = {
                                    id: row.group_id,
                                    name: row.group_name,
                                    color: row.group_color,
                                    description: row.group_description,
                                    tags: []
                                };
                            }

                            if (row.tag_id) {
                                groups[groupKey].tags.push({
                                    id: row.tag_id,
                                    name: row.tag_name,
                                    color: row.tag_color,
                                    video_count: row.video_count
                                });
                            }
                        });

                        resolve(Object.values(groups));
                    }
                });
            });
        });
    }

    async updateTag(tagId, updates) {
        const fields = Object.keys(updates);
        const values = Object.values(updates);

        if (fields.length === 0) return;

        const setClause = fields.map(field => `${field} = ?`).join(', ');
        const sql = `UPDATE tags SET ${setClause} WHERE id = ?`;

        return new Promise((resolve, reject) => {
            this.db.run(sql, [...values, tagId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async deleteTag(tagId) {
        return new Promise((resolve, reject) => {
            this.db.run('DELETE FROM tags WHERE id = ?', [tagId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    close() {
        if (this.db) {
            this.db.close();
        }
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
        await this.db.collection('videos').createIndex({ filename: 'text', description: 'text' });
        await this.db.collection('videos').createIndex({ created_at: -1 });

        // 為tags集合創建索引
        await this.db.collection('tags').createIndex({ name: 1 }, { unique: true });
        await this.db.collection('tag_groups').createIndex({ name: 1 }, { unique: true });
    }

    async addVideo(videoData) {
        const { filename, filepath, filesize, duration, description } = videoData;

        const video = {
            filename,
            filepath,
            filesize: filesize || 0,
            duration: duration || 0,
            description: description || '',
            rating: 0,
            tags: [],
            created_at: new Date(),
            updated_at: new Date()
        };

        try {
            const result = await this.db.collection('videos').replaceOne(
                { filepath },
                video,
                { upsert: true }
            );
            return result.upsertedId ? result.upsertedId.toString() : result.matchedCount > 0 ? 'updated' : null;
        } catch (error) {
            throw error;
        }
    }

    async getVideos(filters = {}) {
        let query = {};

        if (filters.filename) {
            query.filename = new RegExp(filters.filename, 'i');
        }

        if (filters.tag) {
            query.tags = filters.tag;
        }

        const videos = await this.db.collection('videos')
            .find(query)
            .sort({ created_at: -1 })
            .toArray();

        return videos.map(video => ({
            ...video,
            id: video._id.toString(),
            tags: video.tags || []
        }));
    }

    async searchVideos(searchTerm, tags = []) {
        let query = {};

        if (searchTerm && searchTerm.trim()) {
            query.$or = [
                { filename: new RegExp(searchTerm, 'i') },
                { description: new RegExp(searchTerm, 'i') }
            ];
        }

        if (tags.length > 0) {
            query.tags = { $in: tags };
        }

        const videos = await this.db.collection('videos')
            .find(query)
            .sort({ created_at: -1 })
            .toArray();

        return videos.map(video => ({
            ...video,
            id: video._id.toString(),
            tags: video.tags || []
        }));
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

    async deleteVideo(videoId) {
        const objectId = new ObjectId(videoId);
        await this.db.collection('videos').deleteOne({ _id: objectId });
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

            // 計算每個標籤的影片數量
            const tagsWithCount = await Promise.all(tags.map(async (tag) => {
                const count = await this.db.collection('videos').countDocuments({ tags: tag.name });
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
                const count = await this.db.collection('videos').countDocuments({ tags: tag.name });
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
            // 預設使用 SQLite
            const dbPath = dbConfig.sqlite?.path || path.join(__dirname, '../data/videos.db');
            const database = new SQLiteDatabase(dbPath);
            await database.init();
            return database;
        }
    }
}

module.exports = DatabaseFactory;