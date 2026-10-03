const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const Config = require('../src/config');

describe('Config 監看資料夾', () => {
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
});
