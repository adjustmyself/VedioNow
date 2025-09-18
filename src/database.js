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
                fingerprint TEXT,
                rating INTEGER DEFAULT 0,
                description TEXT DEFAULT '',
                file_created_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;


        const createVideoTagRelationsTable = `
            CREATE TABLE IF NOT EXISTS video_tag_relations (
                fingerprint TEXT PRIMARY KEY,
                tags TEXT DEFAULT '[]',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
                this.db.run(createVideoTagRelationsTable);
                this.db.run(createTagGroupsTable);
                this.db.run(createTagsTableOld);
                this.db.run(createVideoTagsTable);

                this.db.run(`ALTER TABLE tags ADD COLUMN group_id INTEGER`, (err) => {
                    // 忽略錯誤，可能是欄位已經存在
                });

                // 添加 fingerprint 欄位遷移（針對舊資料庫）
                this.db.run(`ALTER TABLE videos ADD COLUMN fingerprint TEXT`, (err) => {
                    // 忽略錯誤，可能是欄位已經存在
                    if (err && !err.message.includes('duplicate column')) {
                        console.warn('添加 fingerprint 欄位時發生錯誤:', err.message);
                    }
                });

                // 添加 rating 和 description 欄位到 videos 表格
                this.db.run(`ALTER TABLE videos ADD COLUMN rating INTEGER DEFAULT 0`, (err) => {
                    // 忽略錯誤，可能是欄位已經存在
                });
                this.db.run(`ALTER TABLE videos ADD COLUMN description TEXT DEFAULT ''`, (err) => {
                    // 忽略錯誤，可能是欄位已經存在
                });
                this.db.run(`ALTER TABLE videos ADD COLUMN file_created_at DATETIME`, (err) => {
                    // 忽略錯誤，可能是欄位已經存在
                });

                // 移除舊的 rating, description 欄位（如果存在）
                // SQLite 不支援直接刪除欄位，我們保留它們以確保向後兼容

                this.db.run(`DROP INDEX IF EXISTS sqlite_autoindex_tags_1`);

                createIndexes.forEach(indexSql => {
                    this.db.run(indexSql);
                });

                // 添加新表的索引
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_video_tag_relations_fingerprint ON video_tag_relations(fingerprint)`);
                this.db.run(`CREATE INDEX IF NOT EXISTS idx_videos_fingerprint ON videos(fingerprint)`);

                resolve();
            });
        });
    }

    async addVideo(videoData) {
        const { filename, filepath, filesize, duration, fingerprint, file_created_at } = videoData;

        return new Promise((resolve, reject) => {
            let existingVideo = null;

            // 第一步：優先使用指紋查找
            const findByFingerprint = () => {
                if (!fingerprint) {
                    // 沒有指紋，直接用路徑查找
                    findByFilepath();
                    return;
                }

                this.db.get('SELECT id, filepath FROM videos WHERE fingerprint = ?', [fingerprint], (err, video) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (video) {
                        existingVideo = video;
                        // 檔案找到了，可能路徑改變了
                        if (video.filepath !== filepath) {
                            console.log(`檔案移動檢測: ${video.filepath} -> ${filepath}`);
                        }
                        updateExistingVideo();
                    } else {
                        // 指紋沒找到，用路徑再找一次
                        findByFilepath();
                    }
                });
            };

            // 第二步：用路徑查找
            const findByFilepath = () => {
                this.db.get('SELECT id, fingerprint FROM videos WHERE filepath = ?', [filepath], (err, video) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (video) {
                        existingVideo = video;
                        updateExistingVideo();
                    } else {
                        insertNewVideo();
                    }
                });
            };

            // 更新現有影片
            const updateExistingVideo = () => {
                const updateSql = `
                    UPDATE videos
                    SET filename = ?, filepath = ?, filesize = ?, duration = ?, fingerprint = ?, file_created_at = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `;

                this.db.run(updateSql, [filename, filepath, filesize, duration, fingerprint, file_created_at, existingVideo.id], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        console.log(`更新現有影片資訊: ${filename}`);
                        resolve('updated');
                    }
                });
            };

            // 插入新影片
            const insertNewVideo = () => {
                const insertSql = `
                    INSERT INTO videos (filename, filepath, filesize, duration, fingerprint, file_created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `;

                this.db.run(insertSql, [filename, filepath, filesize, duration, fingerprint, file_created_at], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        console.log(`添加新影片: ${filename}`);
                        resolve(this.lastID);
                    }
                });
            };

            // 開始查找流程
            findByFingerprint();
        });
    }

    async getVideos(filters = {}) {
        // 分頁參數
        const limit = filters.limit || 9; // 每頁顯示9個影片
        const offset = filters.offset || 0;
        const needCount = filters.count !== false; // 預設需要計算總數

        let sql = `
            SELECT
                v.*,
                vtr.tags as tag_json
            FROM videos v
            LEFT JOIN video_tag_relations vtr ON v.fingerprint = vtr.fingerprint
        `;

        const params = [];
        const conditions = [];

        if (filters.filename) {
            conditions.push('v.filename LIKE ?');
            params.push(`%${filters.filename}%`);
        }

        if (filters.tag) {
            conditions.push('vtr.tags LIKE ?');
            params.push(`%"${filters.tag}"%`);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        sql += ' ORDER BY v.file_created_at DESC, v.created_at DESC';
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        return new Promise((resolve, reject) => {
            this.db.all(sql, params, async (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    // 為每個視頻獲取標籤的完整信息（包括顏色）
                    const videos = await Promise.all(rows.map(async row => {
                        let tagNames = [];
                        try {
                            if (row.tag_json && row.tag_json !== 'null' && row.tag_json !== '') {
                                tagNames = JSON.parse(row.tag_json);
                            }
                        } catch (e) {
                            console.warn(`解析標籤 JSON 失敗: ${row.tag_json}`, e);
                            tagNames = [];
                        }

                        // 獲取標籤的完整信息
                        let tagsWithColors = [];
                        if (Array.isArray(tagNames) && tagNames.length > 0) {
                            const tagPlaceholders = tagNames.map(() => '?').join(',');
                            const tagSql = `SELECT name, color FROM tags WHERE name IN (${tagPlaceholders})`;

                            try {
                                const tagRows = await new Promise((resolve, reject) => {
                                    this.db.all(tagSql, tagNames, (err, rows) => {
                                        if (err) reject(err);
                                        else resolve(rows);
                                    });
                                });

                                tagsWithColors = tagNames.map(tagName => {
                                    const tagInfo = tagRows.find(t => t.name === tagName);
                                    return {
                                        name: tagName,
                                        color: tagInfo ? tagInfo.color : '#3b82f6' // 預設顏色
                                    };
                                });
                            } catch (e) {
                                console.warn(`獲取標籤顏色失敗:`, e);
                                tagsWithColors = tagNames.map(name => ({
                                    name,
                                    color: '#3b82f6'
                                }));
                            }
                        }

                        return {
                            ...row,
                            rating: row.rating || 0,
                            description: row.description || '',
                            tags: tagsWithColors
                        };
                    }));

                    // 如果需要計算總數，執行額外查詢
                    if (needCount) {
                        let countSql = `
                            SELECT COUNT(*) as total
                            FROM videos v
                            LEFT JOIN video_tag_relations vtr ON v.fingerprint = vtr.fingerprint
                        `;

                        const countParams = [];
                        if (conditions.length > 0) {
                            countSql += ' WHERE ' + conditions.join(' AND ');
                            // 複製條件參數（不包含 LIMIT/OFFSET）
                            for (let i = 0; i < params.length - 2; i++) {
                                countParams.push(params[i]);
                            }
                        }

                        this.db.get(countSql, countParams, (countErr, countRow) => {
                            if (countErr) {
                                reject(countErr);
                            } else {
                                resolve({
                                    videos: videos,
                                    total: countRow.total,
                                    page: Math.floor(offset / limit) + 1,
                                    pageSize: limit,
                                    totalPages: Math.ceil(countRow.total / limit)
                                });
                            }
                        });
                    } else {
                        resolve({ videos: videos });
                    }
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

    async searchVideos(searchTerm, tags = [], filters = {}) {
        // 分頁參數
        const limit = filters.limit || 9;
        const offset = filters.offset || 0;
        const needCount = filters.count !== false;

        let sql = `
            SELECT v.*, vtr.tags as tag_json
            FROM videos v
            LEFT JOIN video_tag_relations vtr ON v.fingerprint = vtr.fingerprint
        `;

        const params = [];
        const conditions = [];

        if (searchTerm && searchTerm.trim()) {
            conditions.push('(v.filename LIKE ? OR v.description LIKE ?)');
            params.push(`%${searchTerm}%`, `%${searchTerm}%`);
        }

        if (tags.length > 0) {
            // 改為 AND 查詢：必須包含所有選中的標籤
            tags.forEach(tag => {
                conditions.push('vtr.tags LIKE ?');
                params.push(`%"${tag}"%`);
            });
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        sql += ' ORDER BY v.file_created_at DESC, v.created_at DESC';
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);

        return new Promise((resolve, reject) => {
            this.db.all(sql, params, async (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    // 為每個視頻獲取標籤的完整信息（包括顏色）
                    const videos = await Promise.all(rows.map(async row => {
                        let tagNames = [];
                        try {
                            if (row.tag_json && row.tag_json !== 'null' && row.tag_json !== '') {
                                tagNames = JSON.parse(row.tag_json);
                            }
                        } catch (e) {
                            console.warn(`解析標籤 JSON 失敗: ${row.tag_json}`, e);
                            tagNames = [];
                        }

                        // 獲取標籤的完整信息
                        let tagsWithColors = [];
                        if (Array.isArray(tagNames) && tagNames.length > 0) {
                            const tagPlaceholders = tagNames.map(() => '?').join(',');
                            const tagSql = `SELECT name, color FROM tags WHERE name IN (${tagPlaceholders})`;

                            try {
                                const tagRows = await new Promise((resolve, reject) => {
                                    this.db.all(tagSql, tagNames, (err, rows) => {
                                        if (err) reject(err);
                                        else resolve(rows);
                                    });
                                });

                                tagsWithColors = tagNames.map(tagName => {
                                    const tagInfo = tagRows.find(t => t.name === tagName);
                                    return {
                                        name: tagName,
                                        color: tagInfo ? tagInfo.color : '#3b82f6' // 預設顏色
                                    };
                                });
                            } catch (e) {
                                console.warn(`獲取標籤顏色失敗:`, e);
                                tagsWithColors = tagNames.map(name => ({
                                    name,
                                    color: '#3b82f6'
                                }));
                            }
                        }

                        return {
                            ...row,
                            rating: row.rating || 0,
                            description: row.description || '',
                            tags: tagsWithColors
                        };
                    }));

                    // 如果需要計算總數，執行額外查詢
                    if (needCount) {
                        let countSql = `
                            SELECT COUNT(*) as total
                            FROM videos v
                            LEFT JOIN video_tag_relations vtr ON v.fingerprint = vtr.fingerprint
                        `;

                        const countParams = [];
                        if (conditions.length > 0) {
                            countSql += ' WHERE ' + conditions.join(' AND ');
                            // 複製條件參數（不包含 LIMIT/OFFSET）
                            for (let i = 0; i < params.length - 2; i++) {
                                countParams.push(params[i]);
                            }
                        }

                        this.db.get(countSql, countParams, (countErr, countRow) => {
                            if (countErr) {
                                reject(countErr);
                            } else {
                                resolve({
                                    videos: videos,
                                    total: countRow.total,
                                    page: Math.floor(offset / limit) + 1,
                                    pageSize: limit,
                                    totalPages: Math.ceil(countRow.total / limit)
                                });
                            }
                        });
                    } else {
                        resolve({ videos: videos });
                    }
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

    async deleteVideoWithFile(videoId) {
        return new Promise((resolve, reject) => {
            // 先獲取影片檔案路徑和指紋
            this.db.get('SELECT filepath, fingerprint FROM videos WHERE id = ?', [videoId], (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (!row) {
                    reject(new Error('找不到指定的影片'));
                    return;
                }

                const filepath = row.filepath;
                const fingerprint = row.fingerprint;

                // 刪除資料庫記錄
                this.db.run('DELETE FROM videos WHERE id = ?', [videoId], (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    // 級聯刪除相關元數據（如果有指紋）
                    if (fingerprint) {
                        this.deleteVideoMetadata(fingerprint).catch(metadataErr => {
                            console.warn('刪除影片元數據失敗:', metadataErr);
                        });
                    }

                    // 刪除實際檔案
                    fs.unlink(filepath, (fileErr) => {
                        if (fileErr) {
                            console.warn('刪除檔案失敗:', fileErr);
                            // 即使檔案刪除失敗，也視為部分成功（記錄已刪除）
                            resolve({ recordDeleted: true, fileDeleted: false, error: fileErr.message });
                        } else {
                            resolve({ recordDeleted: true, fileDeleted: true });
                        }
                    });
                });
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

    async setVideoMetadata(fingerprint, metadata) {
        const { rating = 0, description = '' } = metadata;

        return new Promise((resolve, reject) => {
            const sql = `
                UPDATE videos
                SET rating = ?, description = ?, updated_at = CURRENT_TIMESTAMP
                WHERE fingerprint = ?
            `;

            this.db.run(sql, [rating, description, fingerprint], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async addVideoTag(fingerprint, tagName) {
        return new Promise((resolve, reject) => {
            // 先獲取當前標籤
            this.db.get('SELECT tags FROM video_tag_relations WHERE fingerprint = ?', [fingerprint], (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }

                let tags = [];
                if (row && row.tags) {
                    try {
                        tags = JSON.parse(row.tags);
                    } catch (e) {
                        tags = [];
                    }
                }

                // 添加新標籤（如果不存在）
                if (!tags.includes(tagName)) {
                    tags.push(tagName);
                }

                const tagsJson = JSON.stringify(tags);
                const sql = `
                    INSERT OR REPLACE INTO video_tag_relations (fingerprint, tags, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                `;

                this.db.run(sql, [fingerprint, tagsJson], function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        });
    }

    async removeVideoTag(fingerprint, tagName) {
        return new Promise((resolve, reject) => {
            // 先獲取當前標籤
            this.db.get('SELECT tags FROM video_tag_relations WHERE fingerprint = ?', [fingerprint], (err, row) => {
                if (err) {
                    reject(err);
                    return;
                }

                let tags = [];
                if (row && row.tags) {
                    try {
                        tags = JSON.parse(row.tags);
                    } catch (e) {
                        tags = [];
                    }
                }

                // 移除標籤
                tags = tags.filter(tag => tag !== tagName);

                if (tags.length === 0) {
                    // 如果沒有標籤了，刪除記錄
                    const sql = `DELETE FROM video_tag_relations WHERE fingerprint = ?`;
                    this.db.run(sql, [fingerprint], function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                } else {
                    // 更新標籤陣列
                    const tagsJson = JSON.stringify(tags);
                    const sql = `
                        UPDATE video_tag_relations
                        SET tags = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE fingerprint = ?
                    `;

                    this.db.run(sql, [tagsJson, fingerprint], function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                }
            });
        });
    }

    async deleteVideoMetadata(fingerprint) {
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                // 刪除標籤關聯
                this.db.run('DELETE FROM video_tag_relations WHERE fingerprint = ?', [fingerprint], (err) => {
                    if (err) {
                        console.warn('刪除標籤關聯失敗:', err);
                    }
                });

                // 清除 videos 表格中的元數據
                this.db.run('UPDATE videos SET rating = 0, description = "" WHERE fingerprint = ?', [fingerprint], (err) => {
                    if (err) {
                        console.warn('清除影片元數據失敗:', err);
                    }
                });

                resolve();
            });
        });
    }

    async migrateLegacyTags() {
        return new Promise((resolve, reject) => {
            console.log('開始遷移舊標籤系統到新系統...');

            // 查詢所有舊的標籤關聯
            const sql = `
                SELECT v.id, v.fingerprint, v.rating, v.description, t.name as tag_name
                FROM videos v
                JOIN video_tags vt ON v.id = vt.video_id
                JOIN tags t ON vt.tag_id = t.id
                WHERE v.fingerprint IS NOT NULL
            `;

            this.db.all(sql, [], (err, rows) => {
                if (err) {
                    console.error('查詢舊標籤數據失敗:', err);
                    reject(err);
                    return;
                }

                if (rows.length === 0) {
                    console.log('沒有找到需要遷移的舊標籤數據');
                    resolve({ migrated: 0, metadataMigrated: 0 });
                    return;
                }

                console.log(`找到 ${rows.length} 個標籤關聯需要遷移`);

                // 按 fingerprint 組織數據
                const videoMap = new Map();
                rows.forEach(row => {
                    if (!videoMap.has(row.fingerprint)) {
                        videoMap.set(row.fingerprint, {
                            rating: row.rating || 0,
                            description: row.description || '',
                            tags: []
                        });
                    }
                    videoMap.get(row.fingerprint).tags.push(row.tag_name);
                });

                let migratedVideos = 0;
                let processedCount = 0;
                const totalVideos = videoMap.size;

                const processNextVideo = () => {
                    if (processedCount >= totalVideos) {
                        console.log(`標籤遷移完成 - 遷移了 ${migratedVideos} 個影片`);
                        resolve({ migrated: migratedVideos, metadataMigrated: migratedVideos });
                        return;
                    }

                    const [fingerprint, data] = Array.from(videoMap.entries())[processedCount];
                    processedCount++;

                    // 更新 videos 表格中的 rating 和 description
                    const updateVideoSql = `
                        UPDATE videos
                        SET rating = ?, description = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE fingerprint = ?
                    `;

                    this.db.run(updateVideoSql, [data.rating, data.description, fingerprint], (err) => {
                        if (err) {
                            console.warn(`遷移影片元數據失敗 ${fingerprint}:`, err.message);
                        }

                        // 遷移標籤關聯（使用 JSON 陣列）
                        const tagsJson = JSON.stringify(data.tags);
                        const tagRelationSql = `
                            INSERT OR REPLACE INTO video_tag_relations (fingerprint, tags, updated_at)
                            VALUES (?, ?, CURRENT_TIMESTAMP)
                        `;

                        this.db.run(tagRelationSql, [fingerprint, tagsJson], (err) => {
                            if (err) {
                                console.warn(`遷移標籤關聯失敗 ${fingerprint}:`, err.message);
                            } else {
                                migratedVideos++;
                            }

                            // 處理下一個
                            setImmediate(processNextVideo);
                        });
                    });
                };

                // 開始處理
                processNextVideo();
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
        if (Object.keys(updates).length === 0) return;

        if (this.config.database.type === 'mongodb') {
            try {
                const { ObjectId } = require('mongodb');
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

        // SQLite implementation
        const fields = Object.keys(updates);
        const values = Object.values(updates);

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
                            (SELECT COUNT(*) FROM video_tag_relations vtr
                             WHERE vtr.tags LIKE '%"' || t.name || '"%') as video_count
                        FROM tag_groups tg
                        LEFT JOIN tags t ON tg.id = t.group_id

                        UNION ALL

                        SELECT
                            NULL as group_id,
                            '未分類' as group_name,
                            '#64748b' as group_color,
                            '未指定群組的標籤' as group_description,
                            t.id as tag_id,
                            t.name as tag_name,
                            t.color as tag_color,
                            (SELECT COUNT(*) FROM video_tag_relations vtr
                             WHERE vtr.tags LIKE '%"' || t.name || '"%') as video_count
                        FROM tags t
                        WHERE t.group_id IS NULL

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
                            (SELECT COUNT(*) FROM video_tag_relations vtr
                             WHERE vtr.tags LIKE '%"' || t.name || '"%') as video_count
                        FROM tags t
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
        if (Object.keys(updates).length === 0) return;

        if (this.config.database.type === 'mongodb') {
            const { ObjectId } = require('mongodb');
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
            return result.modifiedCount > 0;
        }

        // SQLite implementation
        const fields = Object.keys(updates);
        const values = Object.values(updates);

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
        await this.db.collection('videos').createIndex({ fingerprint: 1 }, { unique: true, sparse: true });
        await this.db.collection('videos').createIndex({ filename: 'text', description: 'text' });
        await this.db.collection('videos').createIndex({ created_at: -1 });

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

        // 第一步：左連接 video_tag_relations
        pipeline.push({
            $lookup: {
                from: 'video_tag_relations',
                localField: 'fingerprint',
                foreignField: 'fingerprint',
                as: 'tag_relation'
            }
        });

        // 第二步：添加標籤欄位
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

        // 第三步：篩選條件
        const matchStage = {};
        if (filters.filename) {
            matchStage.filename = new RegExp(filters.filename, 'i');
        }
        if (filters.tag) {
            matchStage.tags = filters.tag;
        }
        if (Object.keys(matchStage).length > 0) {
            pipeline.push({ $match: matchStage });
        }

        // 第四步：排序
        pipeline.push({
            $sort: { file_created_at: -1, created_at: -1 }
        });

        // 第五步：分頁
        pipeline.push({ $skip: offset });
        pipeline.push({ $limit: limit });

        // 第六步：清理欄位
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

        // 第一步：左連接 video_tag_relations
        pipeline.push({
            $lookup: {
                from: 'video_tag_relations',
                localField: 'fingerprint',
                foreignField: 'fingerprint',
                as: 'tag_relation'
            }
        });

        // 第二步：添加標籤欄位
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

        // 第三步：篩選條件
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

        if (Object.keys(matchStage).length > 0) {
            pipeline.push({ $match: matchStage });
        }

        // 第四步：排序
        pipeline.push({
            $sort: { file_created_at: -1, created_at: -1 }
        });

        // 第五步：分頁
        pipeline.push({ $skip: offset });
        pipeline.push({ $limit: limit });

        // 第六步：清理欄位
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
        try {
            await fs.unlink(filepath);
            return { recordDeleted: true, fileDeleted: true };
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