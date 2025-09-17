const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs-extra');

class Database {
  constructor() {
    this.dbPath = path.join(__dirname, '../data/videos.db');
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

    // 先創建舊版本的 tags 表格
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

        // 升級 tags 表格，增加 group_id 欄位
        this.db.run(`ALTER TABLE tags ADD COLUMN group_id INTEGER`, (err) => {
          // 忽略錯誤，可能是欄位已經存在
        });

        // 移除舊的 UNIQUE 約束並創建新的
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

      console.log('Database addTag method called with:', { videoId, tagName });

      // 先插入標籤（如果不存在）
      this.db.run('INSERT OR IGNORE INTO tags (name) VALUES (?)', [tagName], (err) => {
        if (err) {
          console.error('Error inserting tag:', err);
          reject(err);
          return;
        }

        console.log('Tag insert completed, now finding tag ID');

        // 查詢標籤ID
        this.db.get('SELECT id FROM tags WHERE name = ?', [tagName], (err, row) => {
          if (err) {
            console.error('Error finding tag:', err);
            reject(err);
            return;
          }

          if (!row) {
            const error = new Error(`Tag '${tagName}' not found after insert`);
            console.error(error.message);
            reject(error);
            return;
          }

          const tagId = row.id;
          console.log('Found tag ID:', tagId);

          // 插入影片-標籤關聯
          this.db.run('INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)',
            [videoId, tagId], (err) => {
              if (err) {
                console.error('Error linking video to tag:', err);
                reject(err);
              } else {
                console.log(`Successfully linked video ${videoId} to tag ${tagId}`);
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

  // 標籤群組管理方法
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
      // 先檢查 group_id 欄位是否存在
      this.db.all("PRAGMA table_info(tags)", (err, columns) => {
        if (err) {
          reject(err);
          return;
        }

        const hasGroupId = columns.some(col => col.name === 'group_id');

        let sql;
        if (hasGroupId) {
          // 有 group_id 欄位，使用完整查詢
          sql = `
            SELECT tg.*, COUNT(t.id) as tag_count
            FROM tag_groups tg
            LEFT JOIN tags t ON tg.id = t.group_id
            GROUP BY tg.id
            ORDER BY tg.sort_order, tg.name
          `;
        } else {
          // 沒有 group_id 欄位，只查詢群組表
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

  // 修改現有的標籤方法支援群組
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
      // 先檢查 group_id 欄位是否存在
      this.db.get("PRAGMA table_info(tags)", (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        // 檢查是否有 group_id 欄位
        this.db.all("PRAGMA table_info(tags)", (err, columns) => {
          if (err) {
            reject(err);
            return;
          }

          const hasGroupId = columns.some(col => col.name === 'group_id');

          let sql;
          if (hasGroupId) {
            // 有 group_id 欄位，使用完整查詢
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
            // 沒有 group_id 欄位，使用簡化查詢
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
              // 將結果組織成群組結構
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

module.exports = Database;