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
