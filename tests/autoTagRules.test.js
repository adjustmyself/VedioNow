const SQLiteDatabase = require('../src/sqliteDatabase');
const { normalizeRule, validateRule, compileRules, matchTags, applyRules, previewRules } = require('../src/autoTagRules');

describe('autoTagRules', () => {
  test('正規化：去掉空白與重複標籤，未知欄位與方式退回預設', () => {
    const rule = normalizeRule({ pattern: ' 1080p ', tags: ['高畫質', ' 高畫質 ', ''], field: 'x', type: 'y' });
    expect(rule).toEqual({ id: expect.any(String), field: 'filename', type: 'keyword', pattern: '1080p', tags: ['高畫質'], enabled: true });
    expect(normalizeRule({ enabled: false }).enabled).toBe(false);
  });

  test('驗證：空內容、沒有標籤、錯誤的正規表示式', () => {
    expect(validateRule(normalizeRule({ tags: ['a'] }))).toMatch('比對的文字');
    expect(validateRule(normalizeRule({ pattern: 'x' }))).toMatch('至少指定一個標籤');
    expect(validateRule(normalizeRule({ pattern: '(', type: 'regex', tags: ['a'] }))).toMatch('正規表示式有誤');
    expect(validateRule(normalizeRule({ pattern: 'x', tags: ['a'] }))).toBeNull();
  });

  test('關鍵字不分大小寫；檔名規則不看資料夾、路徑規則會看', () => {
    const compiled = compileRules([
      { pattern: '1080P', tags: ['高畫質'] },
      { pattern: '\\動畫\\', field: 'path', tags: ['動畫'] },
      { pattern: '動畫', tags: ['檔名有動畫'] }
    ]);
    expect(matchTags(compiled, '\\\\nas\\動畫\\Show.1080p.mkv').sort()).toEqual(['動畫', '高畫質']);
    expect(matchTags(compiled, 'D:\\movies\\動畫電影.mp4')).toEqual(['檔名有動畫']);
  });

  test('正規表示式規則；停用與不合法的規則略過', () => {
    const compiled = compileRules([
      { pattern: 'S\\d{2}E\\d{2}', type: 'regex', tags: ['影集'] },
      { pattern: 'show', tags: ['停用'], enabled: false },
      { pattern: '(', type: 'regex', tags: ['壞掉'] }
    ]);
    expect(compiled).toHaveLength(1);
    expect(matchTags(compiled, 'C:\\v\\Show.S01E02.mp4')).toEqual(['影集']);
    expect(matchTags(compiled, 'C:\\v\\Show.mp4')).toEqual([]);
  });

  test('預覽每條規則的符合數，錯誤的規則帶錯誤訊息', () => {
    const refs = [{ filepath: 'C:\\a.1080p.mp4' }, { filepath: 'C:\\b.mp4' }];
    const rules = [
      normalizeRule({ id: 'r1', pattern: '1080p', tags: ['x'], enabled: false }),
      normalizeRule({ id: 'r2', pattern: '', tags: ['x'] })
    ];
    expect(previewRules(rules, refs)).toEqual([
      { id: 'r1', matched: 1, error: null },
      { id: 'r2', matched: 0, error: expect.stringContaining('比對的文字') }
    ]);
  });

  describe('applyRules（SQLite）', () => {
    let db;
    beforeEach(async () => {
      db = new SQLiteDatabase(':memory:');
      await db.init();
      await db.addVideo({ filename: 'a.1080p.mp4', filepath: 'C:\\v\\a.1080p.mp4', filesize: 1, fingerprint: 'a' });
      await db.addVideo({ filename: 'b.mp4', filepath: 'C:\\v\\b.mp4', filesize: 1, fingerprint: 'b' });
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
      db.close();
      jest.restoreAllMocks();
    });

    test('加上標籤、新標籤補進標籤表；重複套用不再增加', async () => {
      const rules = [{ pattern: '1080p', tags: ['高畫質'] }];
      const refs = await db.getAllVideoRefs();

      expect(await applyRules(db, rules, refs)).toEqual({ matchedVideos: 1, added: 1 });
      const byFp = Object.fromEntries((await db.getVideos({})).videos.map(v => [v.fingerprint, v.tags]));
      expect(byFp).toEqual({ a: ['高畫質'], b: [] });
      const tagNames = (await db.getTagsByGroup()).flatMap(g => g.tags.map(t => t.name));
      expect(tagNames).toContain('高畫質');

      expect(await applyRules(db, rules, refs)).toEqual({ matchedVideos: 1, added: 0 });
    });
  });
});
