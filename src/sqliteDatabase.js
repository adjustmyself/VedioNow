const path = require('path');
const fs = require('fs-extra');

// SQLite 資料庫實作（better-sqlite3，行程內、零安裝依賴）
//
// 與 MongoDatabase 介面與回傳格式完全相容：
// - id 一律回傳字串
// - 影片列表帶 tags 陣列（標籤名稱字串）
// - 分頁查詢回傳 { videos, total, page, pageSize, totalPages }
//
// 標籤關聯使用正規化的 video_tags 表（fingerprint + tag_name），
// 對應 Mongo 的 video_tag_relations（tags 陣列文件）。
class SQLiteDatabase {
    constructor(dbPath) {
        this.dbPath = dbPath;
        this.db = null;
    }

    async init() {
        const Database = require('better-sqlite3');
        await fs.ensureDir(path.dirname(this.dbPath));
        this.db = new Database(this.dbPath);

        // WAL 模式：讀寫不互鎖、崩潰安全、效能更好
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');

        // 提供 REGEXP 給硬碟路徑等需要正則的查詢（不分大小寫）
        this.db.function('regexp', { deterministic: true }, (pattern, value) => {
            if (value == null || pattern == null) return 0;
            try {
                return new RegExp(pattern, 'i').test(value) ? 1 : 0;
            } catch {
                return 0;
            }
        });

        this._createSchema();
    }

    _createSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL UNIQUE,
                filesize INTEGER DEFAULT 0,
                duration REAL DEFAULT 0,
                description TEXT DEFAULT '',
                rating INTEGER DEFAULT 0,
                fingerprint TEXT UNIQUE,
                is_master INTEGER DEFAULT 1,
                file_created_at TEXT,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_videos_filename ON videos(filename);
            CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_videos_master_filecreated ON videos(is_master, file_created_at DESC);

            CREATE TABLE IF NOT EXISTS tag_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                color TEXT DEFAULT '#6366f1',
                description TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                color TEXT DEFAULT '#3b82f6',
                group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_tags_group ON tags(group_id);

            CREATE TABLE IF NOT EXISTS video_tags (
                fingerprint TEXT NOT NULL,
                tag_name TEXT NOT NULL,
                created_at TEXT,
                PRIMARY KEY (fingerprint, tag_name)
            );
            CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_name);

            CREATE TABLE IF NOT EXISTS video_collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fingerprint TEXT NOT NULL,
                is_main INTEGER DEFAULT 0,
                main_fingerprint TEXT,
                collection_name TEXT,
                folder_path TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_collections_fp ON video_collections(fingerprint);
            CREATE INDEX IF NOT EXISTS idx_collections_main_fp ON video_collections(main_fingerprint);
        `);
    }

    _now() {
        return new Date().toISOString();
    }

    _mapVideo(row) {
        if (!row) return null;
        const video = {
            ...row,
            id: String(row.id),
            is_master: row.is_master !== 0,
            tags: []
        };
        if (row.tags_json !== undefined) {
            try {
                video.tags = JSON.parse(row.tags_json) || [];
            } catch {
                video.tags = [];
            }
            delete video.tags_json;
        }
        return video;
    }

    // 把 LIKE 的萬用字元跳脫，搭配 ESCAPE '\' 使用
    _escapeLike(term) {
        return term.replace(/[\\%_]/g, ch => '\\' + ch);
    }

    async addVideo(videoData) {
        const { filename, filepath, filesize, duration, description, fingerprint, file_created_at } = videoData;
        const fileCreatedAtIso = file_created_at ? new Date(file_created_at).toISOString() : null;

        const run = this.db.transaction(() => {
            let existing = null;
            if (fingerprint) {
                existing = this.db.prepare('SELECT * FROM videos WHERE fingerprint = ?').get(fingerprint);
                if (existing && existing.filepath !== filepath) {
                    console.log(`檔案移動檢測: ${existing.filepath} -> ${filepath}`);
                }
            }
            if (!existing) {
                existing = this.db.prepare('SELECT * FROM videos WHERE filepath = ?').get(filepath);
            }

            if (existing) {
                // 指紋改變時（檔案內容變動或指紋演算法升級），先把標籤關聯與合集記錄
                // 一併搬到新指紋，否則會留下孤兒關聯、標籤直接消失
                if (fingerprint && existing.fingerprint && existing.fingerprint !== fingerprint) {
                    this._migrateFingerprintReferencesSync(existing.fingerprint, fingerprint);
                }

                this.db.prepare(`
                    UPDATE videos SET filename = ?, filepath = ?, filesize = ?, duration = ?,
                        fingerprint = ?, file_created_at = ?, updated_at = ?
                    WHERE id = ?
                `).run(
                    filename, filepath, filesize || 0, duration || 0,
                    fingerprint, fileCreatedAtIso, this._now(), existing.id
                );
                return 'updated';
            }

            const result = this.db.prepare(`
                INSERT INTO videos (filename, filepath, filesize, duration, description, rating,
                    fingerprint, is_master, file_created_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?)
            `).run(
                filename, filepath, filesize || 0, duration || 0, description || '',
                fingerprint, fileCreatedAtIso, this._now(), this._now()
            );
            return String(result.lastInsertRowid);
        });

        return run();
    }

    // 指紋變更時，把舊指紋的標籤關聯與合集記錄搬到新指紋（同步版，於 transaction 內呼叫）
    _migrateFingerprintReferencesSync(oldFingerprint, newFingerprint) {
        // 標籤關聯：INSERT OR IGNORE 進新指紋（自動合併重複），再刪掉舊的
        this.db.prepare(`
            INSERT OR IGNORE INTO video_tags (fingerprint, tag_name, created_at)
            SELECT ?, tag_name, created_at FROM video_tags WHERE fingerprint = ?
        `).run(newFingerprint, oldFingerprint);
        this.db.prepare('DELETE FROM video_tags WHERE fingerprint = ?').run(oldFingerprint);

        // 合集記錄
        this.db.prepare('UPDATE video_collections SET fingerprint = ?, updated_at = ? WHERE fingerprint = ?')
            .run(newFingerprint, this._now(), oldFingerprint);
        this.db.prepare('UPDATE video_collections SET main_fingerprint = ?, updated_at = ? WHERE main_fingerprint = ?')
            .run(newFingerprint, this._now(), oldFingerprint);

        console.log(`指紋變更，已遷移關聯資料: ${oldFingerprint} -> ${newFingerprint}`);
    }

    // 組合篩選條件（getVideos / searchVideos / getTagCountsForFilter 共用）
    _buildFilterClauses(searchTerm, tags, filters) {
        const where = ['v.is_master != 0'];
        const params = [];

        if (searchTerm && searchTerm.trim()) {
            const like = `%${this._escapeLike(searchTerm.trim())}%`;
            where.push(`(v.filename LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')`);
            params.push(like, like);
        }

        if (filters.filename) {
            where.push(`v.filename LIKE ? ESCAPE '\\'`);
            params.push(`%${this._escapeLike(filters.filename)}%`);
        }

        if (filters.tag) {
            where.push('v.fingerprint IN (SELECT fingerprint FROM video_tags WHERE tag_name = ?)');
            params.push(filters.tag);
        }

        if (tags && tags.length > 0) {
            // 所有指定標籤都要有（對應 Mongo 的 $all）
            const placeholders = tags.map(() => '?').join(',');
            where.push(`v.fingerprint IN (
                SELECT fingerprint FROM video_tags
                WHERE tag_name IN (${placeholders})
                GROUP BY fingerprint
                HAVING COUNT(DISTINCT tag_name) = ?
            )`);
            params.push(...tags, tags.length);
        }

        if (filters.rating && filters.rating > 0) {
            where.push('v.rating = ?');
            params.push(filters.rating);
        }

        if (filters.drivePath && filters.drivePath.trim()) {
            // 硬碟路徑篩選：匹配 UNC 第二層路徑，例如 \\192.168.1.147\16tb-SN-xxx\...
            const escapedDrive = filters.drivePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            where.push('v.filepath REGEXP ?');
            params.push(`[\\\\/]{2}[^\\\\/]+[\\\\/]${escapedDrive}[\\\\/]`);
        }

        return { whereSql: where.join(' AND '), params };
    }

    _queryVideosPage(searchTerm, tags, filters) {
        const limit = filters.limit || 9;
        const offset = filters.offset || 0;
        const needCount = filters.count !== false;

        const { whereSql, params } = this._buildFilterClauses(searchTerm, tags, filters);

        const rows = this.db.prepare(`
            SELECT v.*, (
                SELECT json_group_array(tag_name) FROM video_tags vt WHERE vt.fingerprint = v.fingerprint
            ) AS tags_json
            FROM videos v
            WHERE ${whereSql}
            ORDER BY v.file_created_at DESC, v.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        const videos = rows.map(row => this._mapVideo(row));

        if (needCount) {
            const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM videos v WHERE ${whereSql}`).get(...params);
            return {
                videos,
                total,
                page: Math.floor(offset / limit) + 1,
                pageSize: limit,
                totalPages: Math.ceil(total / limit)
            };
        }
        return { videos };
    }

    async getVideos(filters = {}) {
        return this._queryVideosPage(null, [], filters);
    }

    async searchVideos(searchTerm, tags = [], filters = {}) {
        return this._queryVideosPage(searchTerm, tags, filters);
    }

    // 多面向篩選用：依目前篩選條件回傳每個標籤的影片計數 { tagName: count }
    async getTagCountsForFilter(searchTerm, tags = [], filters = {}) {
        const { whereSql, params } = this._buildFilterClauses(searchTerm, tags, filters);
        const rows = this.db.prepare(`
            SELECT vt.tag_name AS name, COUNT(*) AS count
            FROM videos v
            JOIN video_tags vt ON vt.fingerprint = v.fingerprint
            WHERE ${whereSql}
            GROUP BY vt.tag_name
        `).all(...params);

        const counts = {};
        for (const r of rows) counts[r.name] = r.count;
        return counts;
    }

    async countOrphanTagRelations() {
        const { total } = this.db.prepare(`
            SELECT COUNT(DISTINCT fingerprint) AS total FROM video_tags
            WHERE fingerprint NOT IN (SELECT fingerprint FROM videos WHERE fingerprint IS NOT NULL)
        `).get();
        return total;
    }

    async cleanupOrphanTagRelations() {
        const result = this.db.prepare(`
            DELETE FROM video_tags
            WHERE fingerprint NOT IN (SELECT fingerprint FROM videos WHERE fingerprint IS NOT NULL)
        `).run();
        return { removed: result.changes };
    }

    async updateVideo(videoId, updates) {
        // 白名單欄位，避免任意欄位注入
        const allowed = ['filename', 'filepath', 'filesize', 'duration', 'description', 'rating', 'is_master', 'fingerprint', 'file_created_at'];
        const sets = [];
        const params = [];
        for (const key of allowed) {
            if (updates[key] !== undefined) {
                sets.push(`${key} = ?`);
                let value = updates[key];
                if (key === 'is_master') value = value ? 1 : 0;
                if (value instanceof Date) value = value.toISOString();
                params.push(value);
            }
        }
        sets.push('updated_at = ?');
        params.push(this._now(), Number(videoId));

        this.db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }

    async setVideoMetadata(fingerprint, metadata) {
        const { rating = 0, description = '' } = metadata;
        this.db.prepare('UPDATE videos SET rating = ?, description = ?, updated_at = ? WHERE fingerprint = ?')
            .run(rating, description, this._now(), fingerprint);
    }

    async addVideoTag(fingerprint, tagName) {
        const video = this.db.prepare('SELECT id FROM videos WHERE fingerprint = ?').get(fingerprint);
        if (!video) {
            throw new Error(`找不到指紋為 ${fingerprint} 的影片`);
        }
        this.db.prepare('INSERT OR IGNORE INTO video_tags (fingerprint, tag_name, created_at) VALUES (?, ?, ?)')
            .run(fingerprint, tagName, this._now());
    }

    async removeVideoTag(fingerprint, tagName) {
        const video = this.db.prepare('SELECT id FROM videos WHERE fingerprint = ?').get(fingerprint);
        if (!video) {
            throw new Error(`找不到指紋為 ${fingerprint} 的影片`);
        }
        this.db.prepare('DELETE FROM video_tags WHERE fingerprint = ? AND tag_name = ?').run(fingerprint, tagName);
    }

    async deleteVideoMetadata(fingerprint) {
        this.db.prepare('DELETE FROM video_tags WHERE fingerprint = ?').run(fingerprint);
        this.db.prepare('UPDATE videos SET rating = 0, description = \'\', updated_at = ? WHERE fingerprint = ?')
            .run(this._now(), fingerprint);
    }

    // SQLite 是新後端，沒有舊制標籤資料需要遷移
    async migrateLegacyTags() {
        return { migrated: 0, metadataMigrated: 0 };
    }

    async deleteVideo(videoId) {
        this.db.prepare('DELETE FROM videos WHERE id = ?').run(Number(videoId));
    }

    async deleteVideoWithFile(videoId) {
        const video = this.db.prepare('SELECT * FROM videos WHERE id = ?').get(Number(videoId));
        if (!video) {
            throw new Error('找不到指定的影片');
        }

        const filepath = video.filepath;
        const fingerprint = video.fingerprint;
        const folderPath = path.dirname(filepath);

        this.db.prepare('DELETE FROM videos WHERE id = ?').run(Number(videoId));

        if (fingerprint) {
            try {
                await this.deleteVideoMetadata(fingerprint);
            } catch (metadataErr) {
                console.warn('刪除影片元數據失敗:', metadataErr);
            }
        }

        let folderDeleted = false;
        let folderDeleteError = null;

        try {
            await fs.unlink(filepath);

            try {
                const filesInFolder = await fs.readdir(folderPath);
                const visibleFiles = filesInFolder.filter(file =>
                    !file.startsWith('.') &&
                    file !== 'Thumbs.db' &&
                    file !== 'desktop.ini'
                );

                if (visibleFiles.length === 0) {
                    for (const file of filesInFolder) {
                        await fs.unlink(path.join(folderPath, file));
                    }
                    await fs.rmdir(folderPath);
                    folderDeleted = true;
                }
            } catch (folderErr) {
                console.warn('檢查或刪除資料夾失敗:', folderErr);
                folderDeleteError = folderErr.message;
            }

            return { recordDeleted: true, fileDeleted: true, folderDeleted, folderDeleteError };
        } catch (fileErr) {
            console.warn('刪除檔案失敗:', fileErr);
            return { recordDeleted: true, fileDeleted: false, error: fileErr.message };
        }
    }

    // 舊制 API（依影片 id 加減標籤）：轉為指紋制操作
    async addTag(videoId, tagName) {
        this.db.prepare(`
            INSERT INTO tags (name, color, group_id, created_at)
            VALUES (?, '#3b82f6', NULL, ?)
            ON CONFLICT(name) DO NOTHING
        `).run(tagName, this._now());

        const video = this.db.prepare('SELECT fingerprint FROM videos WHERE id = ?').get(Number(videoId));
        if (video && video.fingerprint) {
            await this.addVideoTag(video.fingerprint, tagName);
        }
    }

    async removeTag(videoId, tagName) {
        const video = this.db.prepare('SELECT fingerprint FROM videos WHERE id = ?').get(Number(videoId));
        if (video && video.fingerprint) {
            await this.removeVideoTag(video.fingerprint, tagName);
        }
    }

    async getAllTags() {
        const rows = this.db.prepare(`
            SELECT t.*, (
                SELECT COUNT(*) FROM video_tags vt
                JOIN videos v ON v.fingerprint = vt.fingerprint AND v.is_master != 0
                WHERE vt.tag_name = t.name
            ) AS video_count
            FROM tags t
            ORDER BY t.name
        `).all();
        return rows.map(t => ({ ...t, id: String(t.id), group_id: t.group_id != null ? String(t.group_id) : null }));
    }

    async createTagGroup(groupData) {
        const { name, color, description, sort_order } = groupData;
        const result = this.db.prepare(`
            INSERT INTO tag_groups (name, color, description, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(name, color || '#6366f1', description || '', sort_order || 0, this._now());
        return String(result.lastInsertRowid);
    }

    async getAllTagGroups() {
        const rows = this.db.prepare(`
            SELECT g.*, (SELECT COUNT(*) FROM tags t WHERE t.group_id = g.id) AS tag_count
            FROM tag_groups g
            ORDER BY g.sort_order, g.name
        `).all();
        return rows.map(g => ({ ...g, id: String(g.id) }));
    }

    async deleteTagGroup(groupId) {
        // 群組內的標籤移到未分類，而不是連帶刪除
        this.db.prepare('UPDATE tags SET group_id = NULL, updated_at = ? WHERE group_id = ?')
            .run(this._now(), Number(groupId));
        const result = this.db.prepare('DELETE FROM tag_groups WHERE id = ?').run(Number(groupId));
        if (result.changes === 0) {
            throw new Error('標籤群組不存在');
        }
        return true;
    }

    async updateTagGroup(groupId, updates) {
        const allowed = ['name', 'color', 'description', 'sort_order'];
        const sets = [];
        const params = [];
        for (const key of allowed) {
            if (updates[key] !== undefined) {
                sets.push(`${key} = ?`);
                params.push(updates[key]);
            }
        }
        if (sets.length === 0) return false;
        sets.push('updated_at = ?');
        params.push(this._now(), Number(groupId));

        const result = this.db.prepare(`UPDATE tag_groups SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        return result.changes > 0;
    }

    async createTag(tagData) {
        const { name, color, group_id } = tagData;
        const result = this.db.prepare(`
            INSERT INTO tags (name, color, group_id, created_at) VALUES (?, ?, ?, ?)
        `).run(name, color || '#3b82f6', group_id ? Number(group_id) : null, this._now());
        return String(result.lastInsertRowid);
    }

    async updateTag(tagId, updates) {
        // 改名時要同步 video_tags 的關聯（關聯以名稱存放）
        const run = this.db.transaction(() => {
            const tag = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(tagId));
            if (!tag) return false;

            const allowed = ['name', 'color'];
            const sets = [];
            const params = [];
            for (const key of allowed) {
                if (updates[key] !== undefined) {
                    sets.push(`${key} = ?`);
                    params.push(updates[key]);
                }
            }
            if (updates.group_id !== undefined) {
                sets.push('group_id = ?');
                params.push(updates.group_id ? Number(updates.group_id) : null);
            }
            if (sets.length === 0) return false;
            sets.push('updated_at = ?');
            params.push(this._now(), Number(tagId));

            const result = this.db.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).run(...params);

            if (updates.name && updates.name !== tag.name) {
                this.db.prepare('UPDATE OR IGNORE video_tags SET tag_name = ? WHERE tag_name = ?')
                    .run(updates.name, tag.name);
                this.db.prepare('DELETE FROM video_tags WHERE tag_name = ?').run(tag.name);
            }
            return result.changes > 0;
        });
        return run();
    }

    async deleteTag(tagId) {
        const run = this.db.transaction(() => {
            const tag = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(Number(tagId));
            if (!tag) {
                throw new Error('標籤不存在');
            }
            // 從所有影片移除此標籤的關聯
            this.db.prepare('DELETE FROM video_tags WHERE tag_name = ?').run(tag.name);
            this.db.prepare('DELETE FROM tags WHERE id = ?').run(Number(tagId));
            return true;
        });
        return run();
    }

    async getTagsByGroup() {
        const groups = this.db.prepare('SELECT * FROM tag_groups ORDER BY sort_order, name').all();
        const allTags = this.db.prepare('SELECT * FROM tags').all();
        // 一次查詢取得所有標籤的影片計數（只算 master、實際存在的影片，與列表篩選一致）
        const countRows = this.db.prepare(`
            SELECT vt.tag_name AS name, COUNT(*) AS count
            FROM video_tags vt
            JOIN videos v ON v.fingerprint = vt.fingerprint AND v.is_master != 0
            GROUP BY vt.tag_name
        `).all();
        const countMap = new Map(countRows.map(r => [r.name, r.count]));

        const mapTag = (tag) => ({
            id: String(tag.id),
            name: tag.name,
            color: tag.color,
            video_count: countMap.get(tag.name) || 0
        });

        const result = groups.map(group => ({
            id: String(group.id),
            name: group.name,
            color: group.color,
            description: group.description,
            tags: allTags.filter(t => t.group_id === group.id).map(mapTag)
        }));

        const ungrouped = allTags.filter(t => t.group_id == null);
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
            const rows = this.db.prepare('SELECT filepath FROM videos').all();
            // 提取 UNC 路徑第二層（\\server\share\... 的 share 名稱），與 Mongo 實作一致
            const counts = new Map();
            for (const { filepath } of rows) {
                const parts = filepath.replace(/\//g, '\\').split('\\');
                const drivePath = parts[3];
                if (drivePath) {
                    counts.set(drivePath, (counts.get(drivePath) || 0) + 1);
                }
            }
            return Array.from(counts.entries())
                .map(([p, count]) => ({ path: p, count }))
                .sort((a, b) => b.count - a.count);
        } catch (error) {
            console.error('獲取硬碟路徑失敗:', error);
            return [];
        }
    }

    async getAllVideoRefs() {
        const rows = this.db.prepare('SELECT id, filepath, fingerprint FROM videos').all();
        return rows.map(r => ({
            id: String(r.id),
            filepath: r.filepath,
            fingerprint: r.fingerprint || null
        }));
    }

    async getVideoByPath(filepath) {
        const row = this.db.prepare('SELECT * FROM videos WHERE filepath = ?').get(filepath);
        return row ? this._mapVideo(row) : null;
    }

    // ========== 影片合集相關方法 ==========

    async getVideosByFolder(folderPath) {
        // 標準化路徑：統一使用反斜線，並確保結尾沒有分隔符
        const normalizedPath = folderPath.replace(/\//g, '\\').replace(/\\+$/, '');
        const prefixLower = normalizedPath.toLowerCase();

        const rows = this.db.prepare('SELECT * FROM videos').all();
        const matched = rows.filter(row => {
            const p = row.filepath.replace(/\//g, '\\');
            const lower = p.toLowerCase();
            if (!lower.startsWith(prefixLower + '\\')) return false;
            // 不含子資料夾：前綴之後不能再有分隔符
            return !p.slice(normalizedPath.length + 1).includes('\\');
        });

        return matched.map(row => this._mapVideo(row));
    }

    async createVideoCollection(mainVideoFingerprint, childVideoFingerprints, collectionName, folderPath) {
        const run = this.db.transaction(() => {
            const insert = this.db.prepare(`
                INSERT INTO video_collections (fingerprint, is_main, main_fingerprint, collection_name, folder_path, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            insert.run(mainVideoFingerprint, 1, null, collectionName, folderPath, 0, this._now(), this._now());
            childVideoFingerprints.forEach((fingerprint, index) => {
                insert.run(fingerprint, 0, mainVideoFingerprint, null, null, index, this._now(), this._now());
            });

            const placeholders = childVideoFingerprints.map(() => '?').join(',');
            if (childVideoFingerprints.length > 0) {
                this.db.prepare(`UPDATE videos SET is_master = 0, updated_at = ? WHERE fingerprint IN (${placeholders})`)
                    .run(this._now(), ...childVideoFingerprints);
            }
            this.db.prepare('UPDATE videos SET is_master = 1, updated_at = ? WHERE fingerprint = ?')
                .run(this._now(), mainVideoFingerprint);

            return childVideoFingerprints.length + 1;
        });

        const insertedCount = run();
        // 為主影片加上「合集」標籤
        await this.addVideoTag(mainVideoFingerprint, '合集');
        return { success: true, insertedCount };
    }

    async removeVideoCollection(mainVideoFingerprint) {
        const run = this.db.transaction(() => {
            const childRecords = this.db.prepare(
                'SELECT fingerprint FROM video_collections WHERE main_fingerprint = ? AND is_main = 0'
            ).all(mainVideoFingerprint);
            const childFingerprints = childRecords.map(r => r.fingerprint);

            const collectionResult = this.db.prepare(`
                DELETE FROM video_collections
                WHERE (fingerprint = ? AND is_main = 1) OR (main_fingerprint = ? AND is_main = 0)
            `).run(mainVideoFingerprint, mainVideoFingerprint);

            if (childFingerprints.length > 0) {
                const placeholders = childFingerprints.map(() => '?').join(',');
                this.db.prepare(`DELETE FROM videos WHERE fingerprint IN (${placeholders})`).run(...childFingerprints);
                this.db.prepare(`DELETE FROM video_tags WHERE fingerprint IN (${placeholders})`).run(...childFingerprints);
                console.log(`已刪除 ${childFingerprints.length} 個子影片的資料庫記錄`);
            }

            this.db.prepare('DELETE FROM videos WHERE fingerprint = ?').run(mainVideoFingerprint);
            this.db.prepare('DELETE FROM video_tags WHERE fingerprint = ?').run(mainVideoFingerprint);

            return {
                success: collectionResult.changes > 0,
                deletedCount: collectionResult.changes,
                totalVideosDeleted: childFingerprints.length + 1
            };
        });
        return run();
    }

    async getVideoCollection(mainVideoFingerprint) {
        const mainRecord = this.db.prepare(
            'SELECT * FROM video_collections WHERE fingerprint = ? AND is_main = 1'
        ).get(mainVideoFingerprint);

        if (!mainRecord) return null;

        const childVideos = this.db.prepare(`
            SELECT v.*, c.sort_order
            FROM video_collections c
            JOIN videos v ON v.fingerprint = c.fingerprint
            WHERE c.main_fingerprint = ? AND c.is_main = 0
            ORDER BY c.sort_order
        `).all(mainVideoFingerprint);

        return {
            name: mainRecord.collection_name,
            child_videos: childVideos.map(row => {
                const { sort_order, ...video } = row;
                return { ...this._mapVideo(video), sort_order };
            })
        };
    }

    async updateVideoCollection(mainVideoFingerprint, updates) {
        const allowed = ['collection_name', 'folder_path', 'sort_order'];
        const sets = [];
        const params = [];
        for (const key of allowed) {
            if (updates[key] !== undefined) {
                sets.push(`${key} = ?`);
                params.push(updates[key]);
            }
        }
        if (sets.length === 0) return { success: false };
        sets.push('updated_at = ?');
        params.push(this._now(), mainVideoFingerprint);

        const result = this.db.prepare(
            `UPDATE video_collections SET ${sets.join(', ')} WHERE fingerprint = ? AND is_main = 1`
        ).run(...params);
        return { success: result.changes > 0 };
    }

    async removeVideoFromCollection(mainVideoFingerprint, childFingerprint) {
        const result = this.db.prepare(`
            DELETE FROM video_collections
            WHERE fingerprint = ? AND is_main = 0 AND main_fingerprint = ?
        `).run(childFingerprint, mainVideoFingerprint);
        return { success: result.changes > 0 };
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

module.exports = SQLiteDatabase;
