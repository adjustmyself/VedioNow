const path = require('path');
const fs = require('fs-extra');
const FileFingerprint = require('./fileFingerprint');

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
        this._stmtCache = new Map();
    }

    // 取得（並快取）prepared statement。動態 SQL（IN 清單長度不同）也會進快取，超過上限就整批清掉
    _stmt(sql) {
        let stmt = this._stmtCache.get(sql);
        if (!stmt) {
            if (this._stmtCache.size >= 300) this._stmtCache.clear();
            stmt = this.db.prepare(sql);
            this._stmtCache.set(sql, stmt);
        }
        return stmt;
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
        let lastPattern = null;
        let lastRegex = null;
        this.db.function('regexp', { deterministic: true }, (pattern, value) => {
            if (value == null || pattern == null) return 0;
            if (pattern !== lastPattern) {
                lastPattern = pattern;
                try {
                    lastRegex = new RegExp(pattern, 'i');
                } catch {
                    lastRegex = null;
                }
            }
            return lastRegex && lastRegex.test(value) ? 1 : 0;
        });

        this._createSchema();
        this._migrateSchema();
    }

    // 為既有資料庫補上後來新增的欄位（CREATE TABLE IF NOT EXISTS 不會改動既有表）
    _migrateSchema() {
        const hasColumn = (table, column) =>
            this._stmt(`PRAGMA table_info(${table})`).all().some(c => c.name === column);

        if (!hasColumn('videos', 'file_mtime')) {
            // 重新掃描時用「大小 + 修改時間」判斷檔案沒變、略過指紋計算
            this.db.exec('ALTER TABLE videos ADD COLUMN file_mtime INTEGER');
        }
        this.db.exec(`
            DROP INDEX IF EXISTS idx_videos_master_filecreated;
            CREATE INDEX IF NOT EXISTS idx_videos_master_filecreated_v2 ON videos(is_master, file_created_at DESC, created_at DESC);
        `);

        if (!hasColumn('videos', 'content_fingerprint')) {
            // 內容相同的檔案（原檔與各複本）共用的基礎指紋，由 SQLite 依 fingerprint 自動計算
            this.db.exec(`
                ALTER TABLE videos ADD COLUMN content_fingerprint TEXT
                GENERATED ALWAYS AS (
                    CASE WHEN instr(fingerprint, ':dup:') > 0
                         THEN substr(fingerprint, 1, instr(fingerprint, ':dup:') - 1)
                         ELSE fingerprint END
                ) VIRTUAL
            `);
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_videos_content_fp ON videos(content_fingerprint)');

        if (!hasColumn('tags', 'description')) {
            this.db.exec("ALTER TABLE tags ADD COLUMN description TEXT DEFAULT ''");
        }
        if (!hasColumn('tags', 'description_image')) {
            this.db.exec("ALTER TABLE tags ADD COLUMN description_image TEXT DEFAULT ''");
        }
        if (!hasColumn('tags', 'sort_order')) {
            this.db.exec('ALTER TABLE tags ADD COLUMN sort_order INTEGER DEFAULT 0');
            // 依「群組內的既有 id 順序」回填 0,1,2...：舊版沒有 ORDER BY，畫面上就是這個順序，
            // 改用名稱回填會讓升級後的順序無故變動
            this.db.exec(`
                UPDATE tags SET sort_order = (
                    SELECT COUNT(*) FROM tags t2
                    WHERE IFNULL(t2.group_id, -1) = IFNULL(tags.group_id, -1)
                      AND t2.id < tags.id
                )
            `);
        }
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
                file_mtime INTEGER,
                created_at TEXT,
                updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_videos_filename ON videos(filename);
            CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_videos_master_filecreated_v2 ON videos(is_master, file_created_at DESC, created_at DESC);

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
                description TEXT DEFAULT '',
                description_image TEXT DEFAULT '',
                group_id INTEGER REFERENCES tag_groups(id) ON DELETE SET NULL,
                sort_order INTEGER DEFAULT 0,
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
        return this.db.transaction(() => this._addVideoSync(videoData))();
    }

    // 批次寫入（掃描用）：每 500 筆一個 transaction，批次之間讓出事件迴圈，避免主程序長時間卡住
    async addVideosBatch(videos, onProgress = null) {
        const CHUNK = 500;
        let added = 0;
        let updated = 0;
        let duplicates = 0;
        const runChunk = this.db.transaction((chunk) => {
            for (const video of chunk) {
                try {
                    const result = this._addVideoSync(video);
                    if (result === 'updated') {
                        updated++;
                    } else if (result === 'duplicate') {
                        duplicates++;
                    } else {
                        added++;
                    }
                } catch (error) {
                    console.error(`添加影片失敗: ${video.filepath}`, error);
                }
            }
        });

        for (let i = 0; i < videos.length; i += CHUNK) {
            runChunk(videos.slice(i, i + CHUNK));
            if (onProgress) onProgress(Math.min(i + CHUNK, videos.length));
            await new Promise(resolve => setImmediate(resolve));
        }
        return { added, updated, duplicates };
    }

    _addVideoSync(videoData) {
        const { filename, filepath, filesize, duration, description, fingerprint, file_created_at } = videoData;
        const fileMtime = videoData.file_mtime ?? null;
        const fileCreatedAtIso = file_created_at ? new Date(file_created_at).toISOString() : null;

        {
            const byFp = fingerprint ? this._stmt('SELECT * FROM videos WHERE fingerprint = ?').get(fingerprint) : null;
            const byPath = this._stmt('SELECT * FROM videos WHERE filepath = ?').get(filepath);

            // 同指紋的記錄在別的路徑：原檔還在 = 這是複本；原檔不見了 = 檔案被搬移
            if (byFp && byFp.filepath !== filepath) {
                if (this._fileExists(byFp.filepath)) {
                    if (byPath) {
                        // 複本已有自己的記錄：保留記錄與標籤，指紋改成「原指紋 + 路徑雜湊」，
                        // 之後才能從任一份找到其他複本
                        const dupFingerprint = FileFingerprint.duplicateFingerprint(fingerprint, filepath);
                        if (byPath.fingerprint && byPath.fingerprint !== dupFingerprint) {
                            this._migrateFingerprintReferencesSync(byPath.fingerprint, dupFingerprint);
                        }
                        this._stmt(`
                            UPDATE videos SET filename = ?, filesize = ?, fingerprint = ?, file_created_at = ?, file_mtime = ?, updated_at = ?
                            WHERE id = ?
                        `).run(filename, filesize || 0, dupFingerprint, fileCreatedAtIso, fileMtime, this._now(), byPath.id);
                        return 'duplicate';
                    }
                    // 新發現的複本：另建一筆，指紋加上路徑雜湊避免與原檔衝突
                    this._insertVideoSync({
                        ...videoData,
                        fingerprint: FileFingerprint.duplicateFingerprint(fingerprint, filepath)
                    });
                    return 'duplicate';
                }

                console.log(`檔案移動檢測: ${byFp.filepath} -> ${filepath}`);
                if (byPath) {
                    // 搬到一個已有記錄的路徑：把該記錄的標籤/合集併入，再刪除它，避免路徑唯一鍵衝突
                    if (byPath.fingerprint) {
                        this._migrateFingerprintReferencesSync(byPath.fingerprint, fingerprint);
                    }
                    this._stmt('DELETE FROM videos WHERE id = ?').run(byPath.id);
                }
            }

            const existing = byFp || byPath;
            if (existing) {
                // 指紋改變時（檔案內容變動或指紋演算法升級），先把標籤關聯與合集記錄
                // 一併搬到新指紋，否則會留下孤兒關聯、標籤直接消失
                if (fingerprint && existing.fingerprint && existing.fingerprint !== fingerprint) {
                    this._migrateFingerprintReferencesSync(existing.fingerprint, fingerprint);
                }

                this._stmt(`
                    UPDATE videos SET filename = ?, filepath = ?, filesize = ?, duration = ?,
                        fingerprint = ?, file_created_at = ?, file_mtime = ?, updated_at = ?
                    WHERE id = ?
                `).run(
                    filename, filepath, filesize || 0, duration || 0,
                    fingerprint, fileCreatedAtIso, fileMtime, this._now(), existing.id
                );
                return 'updated';
            }

            return this._insertVideoSync(videoData);
        }
    }

    _insertVideoSync(videoData) {
        const { filename, filepath, filesize, duration, description, fingerprint, file_created_at } = videoData;
        const result = this._stmt(`
            INSERT INTO videos (filename, filepath, filesize, duration, description, rating,
                fingerprint, is_master, file_created_at, file_mtime, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)
        `).run(
            filename, filepath, filesize || 0, duration || 0, description || '',
            fingerprint, file_created_at ? new Date(file_created_at).toISOString() : null,
            videoData.file_mtime ?? null, this._now(), this._now()
        );
        return String(result.lastInsertRowid);
    }

    // 內容相同的其他檔案（原檔與各複本共用同一個基礎指紋）
    async getDuplicateVideos(fingerprint, excludeId) {
        if (!fingerprint) return [];
        const base = FileFingerprint.baseFingerprint(fingerprint);
        const rows = this._stmt(`
            SELECT id, filename, filepath, filesize, is_master FROM videos
            WHERE content_fingerprint = ? AND id != ?
            ORDER BY filepath
        `).all(base, Number(excludeId) || 0);
        return rows.map(r => ({ ...r, id: String(r.id), is_master: r.is_master !== 0 }));
    }

    // 重複檔案統計：有重複的影片數（列表可見的主影片）與重複組數
    async getDuplicateSummary() {
        return this._stmt(`
            WITH groups AS (
                SELECT content_fingerprint FROM videos
                WHERE content_fingerprint IS NOT NULL
                GROUP BY content_fingerprint HAVING COUNT(*) > 1
            )
            SELECT
                (SELECT COUNT(*) FROM videos WHERE is_master = 1 AND content_fingerprint IN (SELECT content_fingerprint FROM groups)) AS videos,
                (SELECT COUNT(*) FROM groups) AS groups
        `).get();
    }

    // 判斷檔案是否存在（同步；只在「同指紋出現在不同路徑」時呼叫，測試可替換）
    _fileExists(filepath) {
        return fs.existsSync(filepath);
    }

    // 指紋變更時，把舊指紋的標籤關聯與合集記錄搬到新指紋（同步版，於 transaction 內呼叫）
    _migrateFingerprintReferencesSync(oldFingerprint, newFingerprint) {
        // 標籤關聯：INSERT OR IGNORE 進新指紋（自動合併重複），再刪掉舊的
        this._stmt(`
            INSERT OR IGNORE INTO video_tags (fingerprint, tag_name, created_at)
            SELECT ?, tag_name, created_at FROM video_tags WHERE fingerprint = ?
        `).run(newFingerprint, oldFingerprint);
        this._stmt('DELETE FROM video_tags WHERE fingerprint = ?').run(oldFingerprint);

        // 合集記錄
        this._stmt('UPDATE video_collections SET fingerprint = ?, updated_at = ? WHERE fingerprint = ?')
            .run(newFingerprint, this._now(), oldFingerprint);
        this._stmt('UPDATE video_collections SET main_fingerprint = ?, updated_at = ? WHERE main_fingerprint = ?')
            .run(newFingerprint, this._now(), oldFingerprint);

        console.log(`指紋變更，已遷移關聯資料: ${oldFingerprint} -> ${newFingerprint}`);
    }

    // 組合篩選條件（getVideos / searchVideos / getTagCountsForFilter 共用）
    _buildFilterClauses(searchTerm, tags, filters) {
        const where = ['v.is_master = 1'];
        const params = [];

        if (searchTerm && searchTerm.trim()) {
            const like = `%${this._escapeLike(searchTerm.trim())}%`;
            // 合集子影片（is_master = 0）不會出現在列表，檔名符合時回傳其所屬合集的主影片
            where.push(`(v.filename LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\'
                OR v.fingerprint IN (
                    SELECT c.main_fingerprint FROM video_collections c
                    JOIN videos child ON child.fingerprint = c.fingerprint
                    WHERE c.is_main = 0 AND child.filename LIKE ? ESCAPE '\\'
                ))`);
            params.push(like, like, like);
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

        if (filters.duplicatesOnly) {
            where.push(`v.content_fingerprint IN (
                SELECT content_fingerprint FROM videos
                WHERE content_fingerprint IS NOT NULL
                GROUP BY content_fingerprint HAVING COUNT(*) > 1
            )`);
        }

        if (filters.drivePath && filters.drivePath.trim()) {
            // 硬碟路徑篩選：匹配 UNC 第二層路徑，例如 \\192.168.1.147\16tb-SN-xxx\...
            const escapedDrive = filters.drivePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            where.push('v.filepath REGEXP ?');
            params.push(`[\\\\/]{2}[^\\\\/]+[\\\\/]${escapedDrive}[\\\\/]`);
        }

        return { whereSql: where.join(' AND '), params };
    }

    // 排序欄位白名單；預設排序對應 idx_videos_master_filecreated 索引
    _buildOrderBy(filters = {}) {
        const columns = {
            file_created_at: 'v.file_created_at',
            created_at: 'v.created_at',
            filename: 'v.filename COLLATE NOCASE',
            filesize: 'v.filesize',
            rating: 'v.rating'
        };
        const field = columns[filters.sortBy] ? filters.sortBy : 'file_created_at';
        const dir = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
        const order = [`${columns[field]} ${dir}`];
        if (filters.duplicatesOnly) order.unshift('v.content_fingerprint');
        if (field !== 'created_at') order.push(`v.created_at ${dir}`);
        return order.join(', ');
    }

    _queryVideosPage(searchTerm, tags, filters) {
        const limit = filters.limit || 9;
        const offset = filters.offset || 0;
        const needCount = filters.count !== false;

        const { whereSql, params } = this._buildFilterClauses(searchTerm, tags, filters);

        const rows = this._stmt(`
            SELECT v.*, (
                SELECT json_group_array(tag_name) FROM video_tags vt WHERE vt.fingerprint = v.fingerprint
            ) AS tags_json, (
                SELECT COUNT(*) FROM videos d WHERE d.content_fingerprint = v.content_fingerprint AND d.id != v.id
            ) AS duplicate_count
            FROM videos v
            WHERE ${whereSql}
            ORDER BY ${this._buildOrderBy(filters)}
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);

        const videos = rows.map(row => this._mapVideo(row));

        if (needCount) {
            const { total } = this._stmt(`SELECT COUNT(*) AS total FROM videos v WHERE ${whereSql}`).get(...params);
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
        const rows = this._stmt(`
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
        const { total } = this._stmt(`
            SELECT COUNT(DISTINCT fingerprint) AS total FROM video_tags
            WHERE fingerprint NOT IN (SELECT fingerprint FROM videos WHERE fingerprint IS NOT NULL)
        `).get();
        return total;
    }

    async cleanupOrphanTagRelations() {
        const result = this._stmt(`
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

        this._stmt(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }

    async setVideoMetadata(fingerprint, metadata) {
        const { rating = 0, description = '' } = metadata;
        this._stmt('UPDATE videos SET rating = ?, description = ?, updated_at = ? WHERE fingerprint = ?')
            .run(rating, description, this._now(), fingerprint);
    }

    async addVideoTag(fingerprint, tagName) {
        const video = this._stmt('SELECT id FROM videos WHERE fingerprint = ?').get(fingerprint);
        if (!video) {
            throw new Error(`找不到指紋為 ${fingerprint} 的影片`);
        }
        this._stmt('INSERT OR IGNORE INTO video_tags (fingerprint, tag_name, created_at) VALUES (?, ?, ?)')
            .run(fingerprint, tagName, this._now());
    }

    async removeVideoTag(fingerprint, tagName) {
        const video = this._stmt('SELECT id FROM videos WHERE fingerprint = ?').get(fingerprint);
        if (!video) {
            throw new Error(`找不到指紋為 ${fingerprint} 的影片`);
        }
        this._stmt('DELETE FROM video_tags WHERE fingerprint = ? AND tag_name = ?').run(fingerprint, tagName);
    }

    async deleteVideoMetadata(fingerprint) {
        this._stmt('DELETE FROM video_tags WHERE fingerprint = ?').run(fingerprint);
        this._stmt('UPDATE videos SET rating = 0, description = \'\', updated_at = ? WHERE fingerprint = ?')
            .run(this._now(), fingerprint);
    }

    // SQLite 是新後端，沒有舊制標籤資料需要遷移
    async migrateLegacyTags() {
        return { migrated: 0, metadataMigrated: 0 };
    }

    async deleteVideo(videoId) {
        this._stmt('DELETE FROM videos WHERE id = ?').run(Number(videoId));
    }

    // 刪除影片記錄及其標籤、合集關聯（單一 transaction）。
    // 若刪的是合集主影片，子影片恢復為一般影片，避免它們永遠被隱藏
    _deleteVideoRecordSync(id, fingerprint) {
        const run = this.db.transaction(() => {
            this._stmt('DELETE FROM videos WHERE id = ?').run(id);
            if (!fingerprint) return;

            this._stmt('DELETE FROM video_tags WHERE fingerprint = ?').run(fingerprint);

            const children = this._stmt(
                'SELECT fingerprint FROM video_collections WHERE main_fingerprint = ? AND is_main = 0'
            ).all(fingerprint).map(r => r.fingerprint);
            if (children.length > 0) {
                const placeholders = children.map(() => '?').join(',');
                this._stmt(`UPDATE videos SET is_master = 1, updated_at = ? WHERE fingerprint IN (${placeholders})`)
                    .run(this._now(), ...children);
            }
            this._stmt('DELETE FROM video_collections WHERE fingerprint = ? OR main_fingerprint = ?')
                .run(fingerprint, fingerprint);
        });
        run();
    }

    async deleteVideoWithFile(videoId) {
        const video = this._stmt('SELECT * FROM videos WHERE id = ?').get(Number(videoId));
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

        this._deleteVideoRecordSync(Number(videoId), fingerprint);

        // 檔案刪除成功後，檢查資料夾是否為空
        let folderDeleted = false;
        let folderDeleteError = null;

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
    }

    async createTagGroup(groupData) {
        const { name, color, description, sort_order } = groupData;
        const result = this._stmt(`
            INSERT INTO tag_groups (name, color, description, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(name, color || '#6366f1', description || '', sort_order || 0, this._now());
        return String(result.lastInsertRowid);
    }

    async getAllTagGroups() {
        const rows = this._stmt(`
            SELECT g.*, (SELECT COUNT(*) FROM tags t WHERE t.group_id = g.id) AS tag_count
            FROM tag_groups g
            ORDER BY g.sort_order, g.name
        `).all();
        return rows.map(g => ({ ...g, id: String(g.id) }));
    }

    async deleteTagGroup(groupId) {
        // 群組內的標籤移到未分類，而不是連帶刪除
        this._stmt('UPDATE tags SET group_id = NULL, updated_at = ? WHERE group_id = ?')
            .run(this._now(), Number(groupId));
        const result = this._stmt('DELETE FROM tag_groups WHERE id = ?').run(Number(groupId));
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

        const result = this._stmt(`UPDATE tag_groups SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        return result.changes > 0;
    }

    // 新標籤排到所屬群組末端；若一律給 0，新標籤會全部擠在最前面
    _nextTagSortOrder(groupId) {
        const row = groupId == null
            ? this._stmt('SELECT MAX(sort_order) AS max_order FROM tags WHERE group_id IS NULL').get()
            : this._stmt('SELECT MAX(sort_order) AS max_order FROM tags WHERE group_id = ?').get(groupId);
        return (row && row.max_order != null ? row.max_order : -1) + 1;
    }

    async createTag(tagData) {
        const { name, color, description, description_image, group_id } = tagData;
        const groupId = group_id ? Number(group_id) : null;
        const result = this._stmt(`
            INSERT INTO tags (name, color, description, description_image, group_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(name, color || '#3b82f6', description || '', description_image || '', groupId, this._nextTagSortOrder(groupId), this._now());
        return String(result.lastInsertRowid);
    }

    // 群組內重新排序：整組重新編號 0..n-1。標籤數量小，全量重編比維護間隙值單純，
    // 也不會有多次拖曳後序號用盡的問題。
    async reorderTags(groupId, orderedTagIds) {
        const gid = (groupId == null || groupId === '') ? null : Number(groupId);
        const run = this.db.transaction(() => {
            const current = gid == null
                ? this._stmt('SELECT id FROM tags WHERE group_id IS NULL').all()
                : this._stmt('SELECT id FROM tags WHERE group_id = ?').all(gid);
            const valid = new Set(current.map(r => r.id));
            const ids = (orderedTagIds || []).map(Number).filter(id => valid.has(id));
            // 必須是整個群組的完整排列，否則沒列到的標籤會留著舊序號而錯位
            if (new Set(ids).size !== valid.size) {
                throw new Error('排序清單與群組內的標籤不一致');
            }
            const stmt = this._stmt('UPDATE tags SET sort_order = ?, updated_at = ? WHERE id = ?');
            const now = this._now();
            ids.forEach((id, index) => stmt.run(index, now, id));
            return true;
        });
        return run();
    }

    async updateTag(tagId, updates) {
        // 改名時要同步 video_tags 的關聯（關聯以名稱存放）
        const run = this.db.transaction(() => {
            const tag = this._stmt('SELECT * FROM tags WHERE id = ?').get(Number(tagId));
            if (!tag) return false;

            const allowed = ['name', 'color', 'description', 'description_image'];
            const sets = [];
            const params = [];
            for (const key of allowed) {
                if (updates[key] !== undefined) {
                    sets.push(`${key} = ?`);
                    params.push(updates[key]);
                }
            }
            if (updates.group_id !== undefined) {
                const newGroupId = updates.group_id ? Number(updates.group_id) : null;
                sets.push('group_id = ?');
                params.push(newGroupId);
                // 換群組時排到新群組末端，否則會沿用舊群組的序號插進中間
                if (newGroupId !== (tag.group_id == null ? null : tag.group_id)) {
                    sets.push('sort_order = ?');
                    params.push(this._nextTagSortOrder(newGroupId));
                }
            }
            if (sets.length === 0) return false;
            sets.push('updated_at = ?');
            params.push(this._now(), Number(tagId));

            const result = this._stmt(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).run(...params);

            if (updates.name && updates.name !== tag.name) {
                this._stmt('UPDATE OR IGNORE video_tags SET tag_name = ? WHERE tag_name = ?')
                    .run(updates.name, tag.name);
                this._stmt('DELETE FROM video_tags WHERE tag_name = ?').run(tag.name);
            }
            return result.changes > 0;
        });
        return run();
    }

    async deleteTag(tagId) {
        const run = this.db.transaction(() => {
            const tag = this._stmt('SELECT * FROM tags WHERE id = ?').get(Number(tagId));
            if (!tag) {
                throw new Error('標籤不存在');
            }
            // 從所有影片移除此標籤的關聯
            this._stmt('DELETE FROM video_tags WHERE tag_name = ?').run(tag.name);
            this._stmt('DELETE FROM tags WHERE id = ?').run(Number(tagId));
            return true;
        });
        return run();
    }

    async getTagsByGroup() {
        const groups = this._stmt('SELECT * FROM tag_groups ORDER BY sort_order, name').all();
        const allTags = this._stmt('SELECT * FROM tags ORDER BY sort_order, name').all();
        // 一次查詢取得所有標籤的影片計數（只算 master、實際存在的影片，與列表篩選一致）
        const countRows = this._stmt(`
            SELECT vt.tag_name AS name, COUNT(*) AS count
            FROM video_tags vt
            JOIN videos v ON v.fingerprint = vt.fingerprint AND v.is_master = 1
            GROUP BY vt.tag_name
        `).all();
        const countMap = new Map(countRows.map(r => [r.name, r.count]));

        const mapTag = (tag) => ({
            id: String(tag.id),
            name: tag.name,
            color: tag.color,
            description: tag.description || '',
            description_image: tag.description_image || '',
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
            const rows = this._stmt('SELECT filepath FROM videos').all();
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
        const rows = this._stmt('SELECT id, filepath, fingerprint, filesize, file_mtime FROM videos').all();
        return rows.map(r => ({
            id: String(r.id),
            filepath: r.filepath,
            fingerprint: r.fingerprint || null,
            filesize: r.filesize,
            file_mtime: r.file_mtime
        }));
    }

    // 批次刪除影片記錄（缺檔清理用）
    async deleteVideosByIds(ids) {
        const del = this._stmt('DELETE FROM videos WHERE id = ?');
        this.db.transaction(() => {
            for (const id of ids) del.run(Number(id));
        })();
    }

    async getVideoByPath(filepath) {
        const row = this._stmt('SELECT * FROM videos WHERE filepath = ?').get(filepath);
        return row ? this._mapVideo(row) : null;
    }

    // ========== 影片合集相關方法 ==========

    async getVideosByFolder(folderPath) {
        // 標準化路徑：統一使用反斜線，並確保結尾沒有分隔符
        const normalizedPath = folderPath.replace(/\//g, '\\').replace(/\\+$/, '');
        const prefixLower = normalizedPath.toLowerCase();

        const rows = this._stmt(
            "SELECT * FROM videos WHERE replace(filepath, '/', '\\') LIKE ? ESCAPE '\\'"
        ).all(this._escapeLike(normalizedPath + '\\') + '%');
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
            const insert = this._stmt(`
                INSERT INTO video_collections (fingerprint, is_main, main_fingerprint, collection_name, folder_path, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);

            insert.run(mainVideoFingerprint, 1, null, collectionName, folderPath, 0, this._now(), this._now());
            childVideoFingerprints.forEach((fingerprint, index) => {
                insert.run(fingerprint, 0, mainVideoFingerprint, null, null, index, this._now(), this._now());
            });

            const placeholders = childVideoFingerprints.map(() => '?').join(',');
            if (childVideoFingerprints.length > 0) {
                this._stmt(`UPDATE videos SET is_master = 0, updated_at = ? WHERE fingerprint IN (${placeholders})`)
                    .run(this._now(), ...childVideoFingerprints);
            }
            this._stmt('UPDATE videos SET is_master = 1, updated_at = ? WHERE fingerprint = ?')
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
            const childRecords = this._stmt(
                'SELECT fingerprint FROM video_collections WHERE main_fingerprint = ? AND is_main = 0'
            ).all(mainVideoFingerprint);
            const childFingerprints = childRecords.map(r => r.fingerprint);

            const collectionResult = this._stmt(`
                DELETE FROM video_collections
                WHERE (fingerprint = ? AND is_main = 1) OR (main_fingerprint = ? AND is_main = 0)
            `).run(mainVideoFingerprint, mainVideoFingerprint);

            if (childFingerprints.length > 0) {
                const placeholders = childFingerprints.map(() => '?').join(',');
                this._stmt(`DELETE FROM videos WHERE fingerprint IN (${placeholders})`).run(...childFingerprints);
                this._stmt(`DELETE FROM video_tags WHERE fingerprint IN (${placeholders})`).run(...childFingerprints);
                console.log(`已刪除 ${childFingerprints.length} 個子影片的資料庫記錄`);
            }

            this._stmt('DELETE FROM videos WHERE fingerprint = ?').run(mainVideoFingerprint);
            this._stmt('DELETE FROM video_tags WHERE fingerprint = ?').run(mainVideoFingerprint);

            return {
                success: collectionResult.changes > 0,
                deletedCount: collectionResult.changes,
                totalVideosDeleted: childFingerprints.length + 1
            };
        });
        return run();
    }

    async getVideoCollection(mainVideoFingerprint) {
        const mainRecord = this._stmt(
            'SELECT * FROM video_collections WHERE fingerprint = ? AND is_main = 1'
        ).get(mainVideoFingerprint);

        if (!mainRecord) return null;

        const childVideos = this._stmt(`
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

    close() {
        this._stmtCache.clear();
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

module.exports = SQLiteDatabase;
