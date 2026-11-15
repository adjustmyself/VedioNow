const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const Config = require('../src/config');

describe('Config', () => {
  let dir;
  let config;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-config-'));
    config = new Config();
    config.configPath = path.join(dir, 'config.json');
    await config.init();
  });

  afterEach(() => {
    fs.removeSync(dir);
  });

  test('預設沒有監看資料夾', async () => {
    expect(await config.getWatchedFolders()).toEqual([]);
  });

  test('新增時路徑不分大小寫去重，已存在就更新是否含子資料夾', async () => {
    await config.addWatchedFolder('D:\\Videos', true);
    await config.addWatchedFolder('\\\\nas\\share', false);
    await config.addWatchedFolder('d:\\videos', false);

    expect(await config.getWatchedFolders()).toEqual([
      { path: '\\\\nas\\share', recursive: false },
      { path: 'd:\\videos', recursive: false }
    ]);
  });

  test('移除回傳被移除的設定，找不到回傳 null，其他設定不受影響', async () => {
    await config.addRecentScanPath('D:\\Videos');
    await config.addWatchedFolder('D:\\Videos', true);

    expect(await config.removeWatchedFolder('d:\\VIDEOS')).toEqual({ path: 'D:\\Videos', recursive: true });
    expect(await config.removeWatchedFolder('D:\\Videos')).toBeNull();
    expect(await config.getWatchedFolders()).toEqual([]);
    expect(await config.getRecentScanPaths()).toEqual(['D:\\Videos']);
  });

  test('舊版設定檔沒有 watchedFolders 欄位也能讀寫', async () => {
    fs.writeJsonSync(config.configPath, { scan: { recentPaths: ['C:\\a'] } });
    expect(await config.getWatchedFolders()).toEqual([]);
    await config.addWatchedFolder('C:\\a');
    expect(await config.getWatchedFolders()).toEqual([{ path: 'C:\\a', recursive: true }]);
  });

  test('自動標籤規則：整批正規化後儲存，任何一條不合法就整批拒絕', async () => {
    expect(await config.getAutoTagRules()).toEqual([]);
    const saved = await config.saveAutoTagRules([{ pattern: ' 1080p ', tags: ['高畫質'] }]);
    expect(saved).toEqual([expect.objectContaining({ pattern: '1080p', field: 'filename', type: 'keyword', enabled: true })]);

    await expect(config.saveAutoTagRules([...saved, { pattern: '(', type: 'regex', tags: ['x'] }]))
      .rejects.toThrow('正規表示式有誤');
    expect(await config.getAutoTagRules()).toEqual(saved);
  });

  test('設定頁儲存只替換 database / app，其他資料保留', async () => {
    await config.addRecentScanPath('D:\Videos');
    await config.addWatchedFolder('D:\Videos');
    await config.saveSearch({ name: '常用' });
    await config.saveAutoTagRules([{ pattern: '1080p', tags: ['高畫質'] }]);

    await config.updateSettings({ database: { type: 'sqlite' }, app: { theme: 'dark', pageSize: 12 } });

    const saved = await config.load();
    expect(saved.app).toMatchObject({ theme: 'dark', pageSize: 12, language: 'zh-TW' });
    expect(saved.database.mongodb).toBeDefined();
    expect(await config.getRecentScanPaths()).toEqual(['D:\Videos']);
    expect(await config.getWatchedFolders()).toHaveLength(1);
    expect(await config.getSavedSearches()).toHaveLength(1);
    expect(await config.getAutoTagRules()).toHaveLength(1);
  });

  describe('儲存的搜尋', () => {
    const base = { searchTerm: ' 海 ', tags: ['動作', '動作', ''], rating: 3, drivePath: '\\nas\d1', unwatchedOnly: 1, sortBy: 'duration', sortOrder: 'asc' };

    test('儲存時修正型別、去掉多餘欄位，並配發 id', async () => {
      const [saved] = await config.saveSearch({ ...base, name: '  海邊  ', evil: 'x' });
      expect(saved).toEqual({
        id: expect.any(String),
        name: '海邊',
        searchTerm: '海',
        tags: ['動作'],
        rating: 3,
        drivePath: '\\nas\d1',
        duplicatesOnly: false,
        unwatchedOnly: true,
        sortBy: 'duration',
        sortOrder: 'asc'
      });
      expect(await config.getSavedSearches()).toEqual([saved]);
    });

    test('不合法的評分與排序退回預設，沒有名稱拒絕儲存', async () => {
      const [saved] = await config.saveSearch({ name: 'x', rating: 9, sortBy: 'id; DROP', sortOrder: 'sideways' });
      expect(saved).toMatchObject({ rating: 0, sortBy: 'file_created_at', sortOrder: 'desc' });
      await expect(config.saveSearch({ name: '   ' })).rejects.toThrow('請輸入名稱');
    });

    test('同名（不分大小寫）覆蓋原本那筆，保留 id 與位置', async () => {
      const [first] = await config.saveSearch({ ...base, name: 'Beach' });
      await config.saveSearch({ name: '其他' });
      const list = await config.saveSearch({ name: 'beach', rating: 5 });
      expect(list.map(s => s.name)).toEqual(['beach', '其他']);
      expect(list[0]).toMatchObject({ id: first.id, rating: 5, tags: [] });
    });

    test('刪除', async () => {
      const [a] = await config.saveSearch({ name: 'a' });
      await config.saveSearch({ name: 'b' });
      expect((await config.deleteSavedSearch(a.id)).map(s => s.name)).toEqual(['b']);
    });
  });

  describe('預設值合併', () => {
    test('舊版設定檔缺少的欄位補上預設值，已有的值不被蓋掉', async () => {
      fs.writeJsonSync(config.configPath, {
        database: { type: 'mongodb', mongodb: { host: '10.0.0.5' } },
        app: { theme: 'dark', pageSize: 6 }
      });
      const loaded = await config.load();
      expect(loaded.database).toMatchObject({ type: 'mongodb', mongodb: { host: '10.0.0.5', port: 27017, authSource: 'admin' } });
      expect(loaded.app).toMatchObject({ theme: 'dark', pageSize: 6, hoverPreview: true, autoBackupKeep: 7 });
      expect(loaded.storage).toEqual({ imagesDir: '', backupDir: '' });
      expect(loaded.scan).toEqual({ recentPaths: [], watchedFolders: [] });
    });

    test('改動 load() 的回傳值不會污染預設值', async () => {
      fs.removeSync(config.configPath);
      const loaded = await config.load();
      loaded.scan.recentPaths.push('D:\\x');
      loaded.database.type = 'mongodb';
      expect((await config.load()).scan.recentPaths).toEqual([]);
      expect(config.defaultConfig.database.type).toBe('sqlite');
    });
  });

  describe('MongoDB 連線字串', () => {
    test('依主機、帳密與參數組出連線字串，帳密會編碼', () => {
      expect(Config.buildMongoConnectionString({
        host: 'nas', port: 27017, database: 'videonow', username: 'me', password: 'p@ss/word', authSource: 'admin', ssl: true
      })).toBe('mongodb://me:p%40ss%2Fword@nas:27017/videonow?authSource=admin&ssl=true');
      expect(Config.buildMongoConnectionString({ host: 'localhost', port: 27017, database: 'videonow', authSource: 'admin' }))
        .toBe('mongodb://localhost:27017/videonow');
    });

    test('有自訂連線字串時直接使用', () => {
      expect(Config.buildMongoConnectionString({ host: 'x', connectionString: 'mongodb://custom/db' })).toBe('mongodb://custom/db');
    });
  });
});
