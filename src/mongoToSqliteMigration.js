const { MongoClient } = require('mongodb');
const fs = require('fs-extra');
const path = require('path');

// 把 MongoDB 的資料一次性搬進 SQLite。
// 設計成可重複執行（INSERT OR IGNORE / upsert），中斷後重跑不會產生重複資料。
async function migrateMongoToSqlite(mongoConnectionString, sqliteDbPath) {
    const SQLiteDatabase = require('./sqliteDatabase');

    const client = new MongoClient(mongoConnectionString, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000
    });
    await client.connect();

    const dbNameMatch = mongoConnectionString.match(/\/([^/?]+)(\?|$)/);
    const mongoDb = client.db(dbNameMatch ? dbNameMatch[1] : 'videonow');

    const sqlite = new SQLiteDatabase(sqliteDbPath);
    await sqlite.init();
    const db = sqlite.db;

    const toIso = (v) => {
        if (!v) return null;
        const d = v instanceof Date ? v : new Date(v);
        return isNaN(d.getTime()) ? null : d.toISOString();
    };

    const counts = { videos: 0, tagGroups: 0, tags: 0, tagRelations: 0, collections: 0 };

    try {
        // 1. 標籤群組（先建，記住 Mongo ObjectId -> SQLite id 的映射）
        const groups = await mongoDb.collection('tag_groups').find().toArray();
        const groupIdMap = new Map();
        const insertGroup = db.prepare(`
            INSERT INTO tag_groups (name, color, description, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET color = excluded.color, description = excluded.description, sort_order = excluded.sort_order
        `);
        const getGroupId = db.prepare('SELECT id FROM tag_groups WHERE name = ?');
        for (const g of groups) {
            insertGroup.run(g.name, g.color || '#6366f1', g.description || '', g.sort_order || 0, toIso(g.created_at), toIso(g.updated_at));
            const row = getGroupId.get(g.name);
            if (row) groupIdMap.set(g._id.toString(), row.id);
            counts.tagGroups++;
        }

        // 2. 標籤
        const tags = await mongoDb.collection('tags').find().toArray();
        const insertTag = db.prepare(`
            INSERT INTO tags (name, color, group_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET color = excluded.color, group_id = excluded.group_id
        `);
        for (const t of tags) {
            const groupId = t.group_id ? (groupIdMap.get(t.group_id.toString()) || null) : null;
            insertTag.run(t.name, t.color || '#3b82f6', groupId, toIso(t.created_at), toIso(t.updated_at));
            counts.tags++;
        }

        // 3. 影片
        const videos = await mongoDb.collection('videos').find().toArray();
        const insertVideo = db.prepare(`
            INSERT INTO videos (filename, filepath, filesize, duration, description, rating,
                fingerprint, is_master, file_created_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(filepath) DO UPDATE SET
                filename = excluded.filename, filesize = excluded.filesize,
                description = excluded.description, rating = excluded.rating,
                fingerprint = excluded.fingerprint, is_master = excluded.is_master,
                file_created_at = excluded.file_created_at
        `);
        const insertVideos = db.transaction((items) => {
            for (const v of items) {
                try {
                    insertVideo.run(
                        v.filename, v.filepath, v.filesize || 0, v.duration || 0,
                        v.description || '', v.rating || 0,
                        v.fingerprint || null, v.is_master === false ? 0 : 1,
                        toIso(v.file_created_at), toIso(v.created_at), toIso(v.updated_at)
                    );
                    counts.videos++;
                } catch (e) {
                    // 重複指紋等個別失敗不中斷整體遷移
                    console.warn(`遷移影片失敗（略過）: ${v.filepath}`, e.message);
                }
            }
        });
        insertVideos(videos);

        // 4. 標籤關聯（Mongo: 一筆文件帶 tags 陣列 -> SQLite: 一列一關聯）
        const relations = await mongoDb.collection('video_tag_relations').find().toArray();
        const insertRelation = db.prepare(
            'INSERT OR IGNORE INTO video_tags (fingerprint, tag_name, created_at) VALUES (?, ?, ?)'
        );
        const insertRelations = db.transaction((items) => {
            for (const r of items) {
                const tagList = Array.isArray(r.tags) ? r.tags : [];
                for (const tagName of tagList) {
                    if (tagName && String(tagName).trim()) {
                        insertRelation.run(r.fingerprint, String(tagName), toIso(r.created_at));
                        counts.tagRelations++;
                    }
                }
            }
        });
        insertRelations(relations);

        // 5. 合集
        const collections = await mongoDb.collection('video_collections').find().toArray();
        const hasCollection = db.prepare(
            'SELECT id FROM video_collections WHERE fingerprint = ? AND is_main = ? AND (main_fingerprint IS ? OR main_fingerprint = ?)'
        );
        const insertCollection = db.prepare(`
            INSERT INTO video_collections (fingerprint, is_main, main_fingerprint, collection_name, folder_path, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertCollections = db.transaction((items) => {
            for (const c of items) {
                const isMain = c.is_main ? 1 : 0;
                const mainFp = c.main_fingerprint || null;
                const existing = hasCollection.get(c.fingerprint, isMain, mainFp, mainFp);
                if (!existing) {
                    insertCollection.run(
                        c.fingerprint, isMain, mainFp,
                        c.collection_name || null, c.folder_path || null, c.sort_order || 0,
                        toIso(c.created_at), toIso(c.updated_at)
                    );
                    counts.collections++;
                }
            }
        });
        insertCollections(collections);

        return counts;
    } finally {
        sqlite.close();
        await client.close();
    }
}

module.exports = { migrateMongoToSqlite };
