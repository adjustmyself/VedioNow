const SQLiteDatabase = require('../src/sqliteDatabase');

describe('SQLiteDatabase', () => {
  let db;

  beforeEach(async () => {
    db = new SQLiteDatabase(':memory:');
    await db.init();
  });

  afterEach(() => {
    db.close();
  });

  const addVideo = (overrides = {}) => db.addVideo({
    filename: 'movie.mp4',
    filepath: '\\\\nas\\drive1\\folder\\movie.mp4',
    filesize: 1000,
    duration: 0,
    description: '',
    fingerprint: 'fp-1',
    file_created_at: new Date('2026-01-01'),
    ...overrides
  });

  describe('addVideo', () => {
    test('新增後可用分頁查詢取回', async () => {
      const id = await addVideo();
      expect(typeof id).toBe('string');

      const result = await db.getVideos({});
      expect(result.total).toBe(1);
      expect(result.videos[0].filename).toBe('movie.mp4');
      expect(result.videos[0].tags).toEqual([]);
      expect(result.videos[0].is_master).toBe(true);
    });

    test('同指紋重複加入 → 更新而非新增（檔案移動）', async () => {
      await addVideo();
      const result = await addVideo({ filepath: '\\\\nas\\drive2\\moved\\movie.mp4' });
      expect(result).toBe('updated');

      const all = await db.getVideos({});
      expect(all.total).toBe(1);
      expect(all.videos[0].filepath).toContain('drive2');
    });

    test('指紋改變時標籤關聯跟著遷移（不產生孤兒）', async () => {
      await addVideo({ fingerprint: 'fp-old' });
      await db.addVideoTag('fp-old', '動作');
      await db.addVideoTag('fp-old', '科幻');

      // 同路徑、新指紋（模擬指紋演算法升級後重新掃描）
      await addVideo({ fingerprint: 'fp-new' });

      const result = await db.getVideos({});
      expect(result.videos[0].fingerprint).toBe('fp-new');
      expect(result.videos[0].tags.sort()).toEqual(['動作', '科幻']);
      expect(await db.countOrphanTagRelations()).toBe(0);
    });
  });

  describe('分頁與搜尋', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 12; i++) {
        await addVideo({
          filename: `video-${String(i).padStart(2, '0')}.mp4`,
          filepath: `\\\\nas\\drive1\\f\\video-${i}.mp4`,
          fingerprint: `fp-${i}`,
          file_created_at: new Date(2026, 0, i)
        });
      }
    });

    test('分頁正確（9 筆一頁）', async () => {
      const page1 = await db.getVideos({ limit: 9, offset: 0 });
      expect(page1.total).toBe(12);
      expect(page1.videos).toHaveLength(9);
      expect(page1.totalPages).toBe(2);

      const page2 = await db.getVideos({ limit: 9, offset: 9 });
      expect(page2.videos).toHaveLength(3);
      expect(page2.page).toBe(2);
    });

    test('排序：file_created_at 新的在前', async () => {
      const result = await db.getVideos({ limit: 3, offset: 0 });
      expect(result.videos[0].filename).toBe('video-12.mp4');
    });

    test('檔名搜尋（含 LIKE 萬用字元跳脫）', async () => {
      const result = await db.searchVideos('video-1', [], {});
      // 檔名為 video-01..video-12（補零），子字串 "video-1" 命中 video-10/11/12
      expect(result.total).toBe(3);

      const noInjection = await db.searchVideos('%', [], {});
      expect(noInjection.total).toBe(0); // % 應視為字面字元，不是萬用字元
    });

    test('標籤 AND 篩選（全部命中才回傳）', async () => {
      await db.addVideoTag('fp-1', 'A');
      await db.addVideoTag('fp-1', 'B');
      await db.addVideoTag('fp-2', 'A');

      const both = await db.searchVideos('', ['A', 'B'], {});
      expect(both.total).toBe(1);
      expect(both.videos[0].fingerprint).toBe('fp-1');

      const onlyA = await db.searchVideos('', ['A'], {});
      expect(onlyA.total).toBe(2);
    });

    test('評分篩選', async () => {
      await db.setVideoMetadata('fp-3', { rating: 5, description: 'great' });
      const result = await db.searchVideos('', [], { rating: 5 });
      expect(result.total).toBe(1);
      expect(result.videos[0].rating).toBe(5);
    });

    test('硬碟路徑篩選（UNC 第二層）', async () => {
      await addVideo({
        filename: 'other.mp4',
        filepath: '\\\\nas\\drive9\\other.mp4',
        fingerprint: 'fp-drive9'
      });
      const result = await db.searchVideos('', [], { drivePath: 'drive9' });
      expect(result.total).toBe(1);
      expect(result.videos[0].fingerprint).toBe('fp-drive9');
    });
  });

  describe('標籤系統', () => {
    test('標籤計數與多面向篩選計數', async () => {
      await addVideo({ fingerprint: 'fp-1', filepath: 'p1', filename: 'alpha.mp4' });
      await addVideo({ fingerprint: 'fp-2', filepath: 'p2', filename: 'beta.mp4' });
      await db.addVideoTag('fp-1', '動作');
      await db.addVideoTag('fp-2', '動作');
      await db.addVideoTag('fp-2', '喜劇');

      const counts = await db.getTagCountsForFilter('', [], {});
      expect(counts['動作']).toBe(2);
      expect(counts['喜劇']).toBe(1);

      const filtered = await db.getTagCountsForFilter('beta', [], {});
      expect(filtered['動作']).toBe(1);
    });

    test('群組 CRUD + 刪除群組時標籤移到未分類', async () => {
      const groupId = await db.createTagGroup({ name: '類型', color: '#f00' });
      const tagId = await db.createTag({ name: '動作', color: '#00f', group_id: groupId });

      let byGroup = await db.getTagsByGroup();
      expect(byGroup).toHaveLength(1);
      expect(byGroup[0].name).toBe('類型');
      expect(byGroup[0].tags[0].name).toBe('動作');

      await db.deleteTagGroup(groupId);
      byGroup = await db.getTagsByGroup();
      expect(byGroup).toHaveLength(1);
      expect(byGroup[0].name).toBe('未分類');
      expect(byGroup[0].tags[0].name).toBe('動作');

      // tagId 仍有效
      const updated = await db.updateTag(tagId, { color: '#abc' });
      expect(updated).toBe(true);
    });

    test('標籤改名同步影片關聯', async () => {
      await addVideo({ fingerprint: 'fp-1', filepath: 'p1' });
      const tagId = await db.createTag({ name: '舊名', color: '#00f', group_id: null });
      await db.addVideoTag('fp-1', '舊名');

      await db.updateTag(tagId, { name: '新名' });

      const result = await db.getVideos({});
      expect(result.videos[0].tags).toEqual(['新名']);
    });

    test('刪除標籤時從所有影片移除', async () => {
      await addVideo({ fingerprint: 'fp-1', filepath: 'p1' });
      const tagId = await db.createTag({ name: '待刪', color: '#00f', group_id: null });
      await db.addVideoTag('fp-1', '待刪');

      await db.deleteTag(tagId);

      const result = await db.getVideos({});
      expect(result.videos[0].tags).toEqual([]);
    });

    test('新標籤排在群組末端，reorderTags 可重排群組內順序', async () => {
      const groupId = await db.createTagGroup({ name: '類型' });
      const a = await db.createTag({ name: 'A', group_id: groupId });
      const b = await db.createTag({ name: 'B', group_id: groupId });
      const c = await db.createTag({ name: 'C', group_id: groupId });

      const names = async () => (await db.getTagsByGroup())[0].tags.map(t => t.name);
      expect(await names()).toEqual(['A', 'B', 'C']);

      await db.reorderTags(groupId, [c, a, b]);
      expect(await names()).toEqual(['C', 'A', 'B']);

      // 之後新增的標籤仍排在最後
      await db.createTag({ name: 'D', group_id: groupId });
      expect(await names()).toEqual(['C', 'A', 'B', 'D']);
    });

    test('reorderTags 拒絕不完整的排序清單', async () => {
      const groupId = await db.createTagGroup({ name: '類型' });
      const a = await db.createTag({ name: 'A', group_id: groupId });
      await db.createTag({ name: 'B', group_id: groupId });

      await expect(db.reorderTags(groupId, [a])).rejects.toThrow();
      await expect(db.reorderTags(groupId, [a, a])).rejects.toThrow();
    });

    test('未分類標籤可排序，換群組時排到新群組末端', async () => {
      const x = await db.createTag({ name: 'X', group_id: null });
      const y = await db.createTag({ name: 'Y', group_id: null });

      await db.reorderTags(null, [y, x]);
      const ungrouped = await db.getTagsByGroup();
      expect(ungrouped[0].tags.map(t => t.name)).toEqual(['Y', 'X']);

      const groupId = await db.createTagGroup({ name: '類型' });
      await db.createTag({ name: 'A', group_id: groupId });
      await db.updateTag(x, { group_id: groupId });

      const byGroup = await db.getTagsByGroup();
      expect(byGroup[0].tags.map(t => t.name)).toEqual(['A', 'X']);
    });

    test('孤兒關聯清理', async () => {
      await addVideo({ fingerprint: 'fp-1', filepath: 'p1' });
      await db.addVideoTag('fp-1', 'X');
      await db.deleteVideo((await db.getVideos({})).videos[0].id);

      expect(await db.countOrphanTagRelations()).toBe(1);
      const { removed } = await db.cleanupOrphanTagRelations();
      expect(removed).toBe(1);
      expect(await db.countOrphanTagRelations()).toBe(0);
    });
  });

  describe('重複檔案（內容相同的複本）', () => {
    const A = 'C:\\v\\a.mp4';
    const B = 'C:\\v\\copy\\a.mp4';
    let onDisk;

    beforeEach(() => {
      onDisk = new Set([A, B]);
      db._fileExists = (p) => onDisk.has(p);
    });

    const refs = async () => (await db.getAllVideoRefs()).sort((x, y) => x.filepath.localeCompare(y.filepath));

    test('兩份都已有記錄：回傳 duplicate，兩筆都保留，複本指紋改為連結原檔且標籤跟著走', async () => {
      await addVideo({ filepath: A, fingerprint: 'fp-x' });
      await addVideo({ filepath: B, fingerprint: 'fp-old' });
      await db.addVideoTag('fp-old', '複本標籤');

      const result = await addVideo({ filepath: B, fingerprint: 'fp-x', file_mtime: 123 });
      expect(result).toBe('duplicate');

      const all = await refs();
      expect(all.map(v => v.filepath)).toEqual([A, B]);
      expect(all[0].fingerprint).toBe('fp-x');
      expect(all[1].fingerprint).toMatch(/^fp-x:dup:[0-9a-f]{12}$/);
      expect(all[1].file_mtime).toBe(123); // 記下修改時間，下次掃描可略過
      expect((await db.searchVideos('', ['複本標籤'], {})).videos.map(v => v.filepath)).toEqual([B]);
      expect(await db.countOrphanTagRelations()).toBe(0);

      // 再掃一次同一份複本：指紋不再變動
      expect(await addVideo({ filepath: B, fingerprint: 'fp-x' })).toBe('duplicate');
      expect((await refs())[1].fingerprint).toBe(all[1].fingerprint);
    });

    test('getDuplicateVideos：從原檔或任一複本都能找到其他份', async () => {
      const C = 'C:\\v\\other\\a.mp4';
      onDisk.add(C);
      await addVideo({ filepath: A, fingerprint: 'fp-x' });
      await addVideo({ filepath: B, fingerprint: 'fp-x' });
      await addVideo({ filepath: C, fingerprint: 'fp-x' });
      await addVideo({ filepath: 'C:\\v\\unrelated.mp4', fingerprint: 'fp-y' });

      const [a, b, c] = await Promise.all([A, B, C].map(p => db.getVideoByPath(p)));
      expect((await db.getDuplicateVideos(a.fingerprint, a.id)).map(v => v.filepath)).toEqual([B, C]);
      expect((await db.getDuplicateVideos(b.fingerprint, b.id)).map(v => v.filepath)).toEqual([A, C]);
      expect((await db.getDuplicateVideos(c.fingerprint, c.id)).map(v => v.filepath)).toEqual([A, B]);

      const unrelated = await db.getVideoByPath('C:\\v\\unrelated.mp4');
      expect(await db.getDuplicateVideos(unrelated.fingerprint, unrelated.id)).toEqual([]);
    });

    test('新發現的複本：另建一筆，原檔記錄不被搬走', async () => {
      await addVideo({ filepath: A, fingerprint: 'fp-x' });
      await db.addVideoTag('fp-x', '原檔標籤');

      const result = await addVideo({ filepath: B, fingerprint: 'fp-x' });
      expect(result).toBe('duplicate');

      const all = await refs();
      expect(all.map(v => v.filepath)).toEqual([A, B]);
      expect(all[0].fingerprint).toBe('fp-x');
      expect(all[1].fingerprint).toMatch(/^fp-x:dup:[0-9a-f]{12}$/);
      // 原檔標籤仍在原檔上
      expect((await db.searchVideos('', ['原檔標籤'], {})).videos.map(v => v.filepath)).toEqual([A]);

      // 重掃複本：路徑已有記錄 → 仍是 duplicate，不會再多建
      expect(await addVideo({ filepath: B, fingerprint: 'fp-x' })).toBe('duplicate');
      expect((await refs()).length).toBe(2);
    });

    test('原檔已不存在：視為搬移，標籤跟著走', async () => {
      await addVideo({ filepath: A, fingerprint: 'fp-x' });
      await db.addVideoTag('fp-x', '動作');
      onDisk.delete(A);

      expect(await addVideo({ filepath: B, fingerprint: 'fp-x' })).toBe('updated');
      const all = await refs();
      expect(all.map(v => [v.filepath, v.fingerprint])).toEqual([[B, 'fp-x']]);
      expect((await db.getVideos({})).videos[0].tags).toEqual(['動作']);
    });

    test('搬到已有記錄的路徑：合併該記錄的標籤後取代它，不會撞唯一鍵', async () => {
      await addVideo({ filepath: A, fingerprint: 'fp-x' });
      await addVideo({ filepath: B, fingerprint: 'fp-old' });
      await db.addVideoTag('fp-x', '動作');
      await db.addVideoTag('fp-old', '科幻');
      onDisk.delete(A);

      expect(await addVideo({ filepath: B, fingerprint: 'fp-x' })).toBe('updated');
      const all = await refs();
      expect(all.map(v => [v.filepath, v.fingerprint])).toEqual([[B, 'fp-x']]);
      expect((await db.getVideos({})).videos[0].tags.sort()).toEqual(['動作', '科幻']);
      expect(await db.countOrphanTagRelations()).toBe(0);
    });

    test('批次寫入分開統計重複檔案', async () => {
      await addVideo({ filepath: A, fingerprint: 'fp-x' });
      const result = await db.addVideosBatch([
        { filename: 'a.mp4', filepath: B, filesize: 1, fingerprint: 'fp-x' },
        { filename: 'n.mp4', filepath: 'C:\\v\\n.mp4', filesize: 1, fingerprint: 'fp-n' }
      ]);
      expect(result).toEqual({ added: 1, updated: 0, duplicates: 1 });
    });
  });

  describe('排序', () => {
    beforeEach(async () => {
      await addVideo({ fingerprint: 'a', filename: 'b.mp4', filepath: 'C:\\v\\b.mp4', filesize: 300, file_created_at: new Date('2026-01-02') });
      await addVideo({ fingerprint: 'b', filename: 'A.mp4', filepath: 'C:\\v\\A.mp4', filesize: 100, file_created_at: new Date('2026-01-03') });
      await addVideo({ fingerprint: 'c', filename: 'c.mp4', filepath: 'C:\\v\\c.mp4', filesize: 200, file_created_at: new Date('2026-01-01') });
    });

    test('預設依檔案建立時間降序', async () => {
      const result = await db.getVideos({});
      expect(result.videos.map(v => v.fingerprint)).toEqual(['b', 'a', 'c']);
    });

    test('排序作用於全部結果而非單頁', async () => {
      const page1 = await db.getVideos({ sortBy: 'filesize', sortOrder: 'asc', limit: 2, offset: 0 });
      const page2 = await db.getVideos({ sortBy: 'filesize', sortOrder: 'asc', limit: 2, offset: 2 });
      expect([...page1.videos, ...page2.videos].map(v => v.filesize)).toEqual([100, 200, 300]);
    });

    test('檔名排序不分大小寫', async () => {
      const result = await db.searchVideos('', [], { sortBy: 'filename', sortOrder: 'asc' });
      expect(result.videos.map(v => v.filename)).toEqual(['A.mp4', 'b.mp4', 'c.mp4']);
    });

    test('不在白名單的排序欄位退回預設', async () => {
      const result = await db.getVideos({ sortBy: 'id; DROP TABLE videos', sortOrder: 'asc' });
      expect(result.videos.map(v => v.fingerprint)).toEqual(['c', 'a', 'b']);
    });
  });

  describe('合集', () => {
    beforeEach(async () => {
      await addVideo({ fingerprint: 'fp-main', filepath: '\\\\nas\\d\\series\\ep1.mp4', filename: 'ep1.mp4' });
      await addVideo({ fingerprint: 'fp-c1', filepath: '\\\\nas\\d\\series\\ep2.mp4', filename: 'ep2.mp4' });
      await addVideo({ fingerprint: 'fp-c2', filepath: '\\\\nas\\d\\series\\ep3.mp4', filename: 'ep3.mp4' });
    });

    test('建立合集：子影片隱藏、主影片帶「合集」標籤', async () => {
      const result = await db.createVideoCollection('fp-main', ['fp-c1', 'fp-c2'], '我的系列', '\\\\nas\\d\\series');
      expect(result.success).toBe(true);

      // 列表只顯示主影片
      const videos = await db.getVideos({});
      expect(videos.total).toBe(1);
      expect(videos.videos[0].fingerprint).toBe('fp-main');
      expect(videos.videos[0].tags).toContain('合集');

      // 合集內容正確且按順序
      const collection = await db.getVideoCollection('fp-main');
      expect(collection.name).toBe('我的系列');
      expect(collection.child_videos.map(v => v.fingerprint)).toEqual(['fp-c1', 'fp-c2']);
    });

    test('刪除合集：連同子影片記錄一併刪除', async () => {
      await db.createVideoCollection('fp-main', ['fp-c1', 'fp-c2'], '我的系列', '\\\\nas\\d\\series');
      const result = await db.removeVideoCollection('fp-main');
      expect(result.totalVideosDeleted).toBe(3);

      const videos = await db.getVideos({});
      expect(videos.total).toBe(0);
      expect(await db.getVideoCollection('fp-main')).toBeNull();
    });

    test('搜尋子影片檔名可找到合集主影片', async () => {
      await db.createVideoCollection('fp-main', ['fp-c1', 'fp-c2'], '我的系列', '\\\\nas\\d\\series');

      // ep2 是子影片，搜尋它應回傳主影片 ep1
      const result = await db.searchVideos('ep2', [], {});
      expect(result.total).toBe(1);
      expect(result.videos[0].fingerprint).toBe('fp-main');

      // 主影片同時符合時不重複
      const all = await db.searchVideos('ep', [], {});
      expect(all.total).toBe(1);
      expect(all.videos[0].fingerprint).toBe('fp-main');

      // 不符合的關鍵字仍搜不到
      const none = await db.searchVideos('不存在', [], {});
      expect(none.total).toBe(0);
    });

    test('刪除合集主影片檔案：子影片恢復顯示、合集記錄清除', async () => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-del-'));
      const mainPath = path.join(dir, 'ep1.mp4');
      fs.writeFileSync(mainPath, 'x');
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'x'); // 資料夾不為空，不會被刪
      try {
        // 同指紋 → 更新既有主影片的路徑為真實暫存檔
        await addVideo({ fingerprint: 'fp-main', filepath: mainPath, filename: 'ep1.mp4' });
        const { id } = await db.getVideoByPath(mainPath);
        await db.createVideoCollection('fp-main', ['fp-c1', 'fp-c2'], '我的系列', dir);
        await db.addVideoTag('fp-main', '動作');

        const result = await db.deleteVideoWithFile(id);
        expect(result.fileDeleted).not.toBe(false);
        expect(fs.existsSync(mainPath)).toBe(false);

        const videos = await db.getVideos({});
        expect(videos.videos.map(v => v.fingerprint).sort()).toEqual(['fp-c1', 'fp-c2']);
        expect(await db.getVideoCollection('fp-main')).toBeNull();
        const { n } = db.db.prepare('SELECT COUNT(*) AS n FROM video_collections').get();
        expect(n).toBe(0);
        expect(await db.countOrphanTagRelations()).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('getVideosByFolder 只回傳同層影片', async () => {
      await addVideo({ fingerprint: 'fp-sub', filepath: '\\\\nas\\d\\series\\sub\\ep4.mp4', filename: 'ep4.mp4' });
      const videos = await db.getVideosByFolder('\\\\nas\\d\\series');
      expect(videos.map(v => v.filename).sort()).toEqual(['ep1.mp4', 'ep2.mp4', 'ep3.mp4']);
    });
  });

  describe('維護用查詢', () => {
    test('getAllVideoRefs 回傳全部（不分頁）', async () => {
      for (let i = 0; i < 25; i++) {
        await addVideo({ fingerprint: `fp-${i}`, filepath: `p${i}` });
      }
      const refs = await db.getAllVideoRefs();
      expect(refs).toHaveLength(25);
      expect(refs[0]).toHaveProperty('id');
      expect(refs[0]).toHaveProperty('filepath');
    });

    test('getVideoByPath', async () => {
      await addVideo();
      const video = await db.getVideoByPath('\\\\nas\\drive1\\folder\\movie.mp4');
      expect(video.filename).toBe('movie.mp4');
      expect(await db.getVideoByPath('not-exists')).toBeNull();
    });

    test('getAllDrivePaths 統計 UNC 第二層', async () => {
      await addVideo({ fingerprint: 'f1', filepath: '\\\\nas\\driveA\\a.mp4' });
      await addVideo({ fingerprint: 'f2', filepath: '\\\\nas\\driveA\\b.mp4' });
      await addVideo({ fingerprint: 'f3', filepath: '\\\\nas\\driveB\\c.mp4' });

      const drives = await db.getAllDrivePaths();
      expect(drives[0]).toEqual({ path: 'driveA', count: 2 });
      expect(drives[1]).toEqual({ path: 'driveB', count: 1 });
    });
  });
});
