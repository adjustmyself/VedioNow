const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const SQLiteDatabase = require('../src/sqliteDatabase');
const BackupManager = require('../src/backupManager');
const { formatTimestamp, AUTO_BACKUP_KEEP } = BackupManager;

describe('BackupManager', () => {
  let userDataDir;
  let outDir;
  let db;
  let manager;

  const dbPath = () => path.join(userDataDir, 'videonow.db');
  const addVideo = (n) => db.addVideo({
    filename: `v${n}.mp4`, filepath: `C:\\v\\v${n}.mp4`, filesize: n, fingerprint: `fp-${n}`
  });

  beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-userdata-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-backup-out-'));
    db = new SQLiteDatabase(dbPath());
    await db.init();
    manager = new BackupManager({ userDataDir, appVersion: '9.9.9' });
  });

  afterEach(() => {
    if (db && db.db) db.close();
    fs.removeSync(userDataDir);
    fs.removeSync(outDir);
  });

  test('時間戳記用本地時間、可依字典序排序', () => {
    expect(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
  });

  test('備份包含資料庫、設定、標籤圖片與 manifest，不留暫存資料夾', async () => {
    await addVideo(1);
    await addVideo(2);
    await db.createTag({ name: '動作', group_id: null });
    fs.writeJsonSync(path.join(userDataDir, 'config.json'), { app: { theme: 'dark' } });
    fs.outputFileSync(path.join(userDataDir, 'tag-images', 'a.png'), 'png');

    const dir = await manager.createBackup(db, outDir, { now: new Date(2026, 9, 3, 12, 0, 0) });

    expect(path.basename(dir)).toBe('VideoNow-backup-20261003-120000');
    expect(fs.readdirSync(outDir)).toEqual([path.basename(dir)]);
    expect(fs.readJsonSync(path.join(dir, 'config.json'))).toEqual({ app: { theme: 'dark' } });
    expect(fs.readFileSync(path.join(dir, 'tag-images', 'a.png'), 'utf8')).toBe('png');
    const manifest = fs.readJsonSync(path.join(dir, 'manifest.json'));
    expect(manifest).toMatchObject({ app: 'VideoNow', appVersion: '9.9.9', videos: 2, tags: 1 });

    const info = await manager.inspectBackup(dir);
    expect(info).toMatchObject({ videos: 2, tags: 1, hasTagImages: true });
  });

  test('includeThumbnails 時備份縮圖（不含暫存檔），預設不備份', async () => {
    fs.outputFileSync(path.join(userDataDir, 'thumbnails', 'fp-a.jpg'), 'a');
    fs.outputFileSync(path.join(userDataDir, 'thumbnails', 'fp-b.jpg.tmp.jpg'), 'partial');

    const without = await manager.createBackup(db, outDir, { now: new Date(2026, 9, 3, 12, 0, 0) });
    expect(fs.pathExistsSync(path.join(without, 'thumbnails'))).toBe(false);
    expect((await manager.inspectBackup(without)).thumbnails).toBe(0);

    const withThumbs = await manager.createBackup(db, outDir, { now: new Date(2026, 9, 3, 13, 0, 0), includeThumbnails: true });
    expect(fs.readdirSync(path.join(withThumbs, 'thumbnails'))).toEqual(['fp-a.jpg']);
    expect(fs.readJsonSync(path.join(withThumbs, 'manifest.json')).thumbnails).toBe(1);
    expect((await manager.inspectBackup(withThumbs)).thumbnails).toBe(1);
  });

  test('圖片與備份放在自訂位置', async () => {
    const imagesDir = path.join(outDir, 'images');
    const backupsDir = path.join(outDir, 'backups');
    manager = new BackupManager({ userDataDir, imagesDir, backupsDir });
    fs.outputFileSync(path.join(imagesDir, 'tag-images', 'a.png'), 'png');
    fs.outputFileSync(path.join(imagesDir, 'thumbnails', 'fp-a.jpg'), 'a');

    const dir = await manager.autoBackup(db, { includeThumbnails: true });
    expect(path.dirname(dir)).toBe(path.join(backupsDir, 'auto'));
    expect(fs.readFileSync(path.join(dir, 'tag-images', 'a.png'), 'utf8')).toBe('png');
    expect(fs.readdirSync(path.join(dir, 'thumbnails'))).toEqual(['fp-a.jpg']);

    // 還原到自訂的圖片位置：標籤圖片取代，縮圖只補缺少的
    fs.removeSync(path.join(imagesDir, 'tag-images'));
    fs.removeSync(path.join(imagesDir, 'thumbnails', 'fp-a.jpg'));
    fs.outputFileSync(path.join(imagesDir, 'thumbnails', 'fp-new.jpg'), 'new');
    db.close();
    await manager.restoreFiles(dir);
    db = null;
    expect(fs.readdirSync(path.join(imagesDir, 'tag-images'))).toEqual(['a.png']);
    expect(fs.readdirSync(path.join(imagesDir, 'thumbnails')).sort()).toEqual(['fp-a.jpg', 'fp-new.jpg']);
    expect(fs.pathExistsSync(path.join(userDataDir, 'tag-images'))).toBe(false);
  });

  test('同一秒重複備份不覆蓋，改加序號', async () => {
    const now = new Date(2026, 9, 3, 12, 0, 0);
    const a = await manager.createBackup(db, outDir, { now });
    const b = await manager.createBackup(db, outDir, { now });
    expect(a).not.toBe(b);
    expect(path.basename(b)).toBe('VideoNow-backup-20261003-120000-2');
  });

  test('MongoDB 等不支援備份的資料庫直接拒絕', async () => {
    await expect(manager.createBackup({}, outDir)).rejects.toThrow('僅支援 SQLite');
    expect(await manager.autoBackup({})).toBeNull();
  });

  test('自動備份一天只做一次，只保留最近幾份', async () => {
    const start = new Date(2026, 9, 1, 9, 0, 0).getTime();
    const hours = (h) => new Date(start + h * 3600 * 1000);

    expect(await manager.autoBackup(db, { now: hours(0) })).not.toBeNull();
    expect(await manager.autoBackup(db, { now: hours(5) })).toBeNull();
    expect(await manager.autoBackup(db, { now: hours(25) })).not.toBeNull();

    for (let day = 2; day <= 10; day++) {
      await manager.autoBackup(db, { now: hours(day * 25) });
    }
    const backups = await manager.listBackups(manager.autoDir);
    expect(backups).toHaveLength(AUTO_BACKUP_KEEP);
    // 新的在前
    expect(new Date(backups[0].createdAt).getTime()).toBe(hours(250).getTime());
  });

  test('還原覆蓋資料庫與標籤圖片，設定檔保留目前的資料庫連線區段', async () => {
    await addVideo(1);
    fs.writeJsonSync(path.join(userDataDir, 'config.json'), {
      database: { type: 'sqlite', mongodb: { host: 'old-host' } },
      app: { theme: 'dark' }
    });
    fs.outputFileSync(path.join(userDataDir, 'tag-images', 'old.png'), 'old');
    const backupDir = await manager.createBackup(db, outDir);

    // 備份之後資料又變動
    await addVideo(2);
    await addVideo(3);
    fs.removeSync(path.join(userDataDir, 'tag-images', 'old.png'));
    fs.outputFileSync(path.join(userDataDir, 'tag-images', 'new.png'), 'new');
    fs.writeJsonSync(path.join(userDataDir, 'config.json'), {
      database: { type: 'sqlite', mongodb: { host: 'new-host' } },
      app: { theme: 'light' },
      storage: { imagesDir: 'D:\\images', backupDir: '' }
    });

    db.close();
    await manager.restoreFiles(backupDir);

    db = new SQLiteDatabase(dbPath());
    await db.init();
    expect((await db.getVideos({})).total).toBe(1);
    expect(fs.readdirSync(path.join(userDataDir, 'tag-images'))).toEqual(['old.png']);
    const config = fs.readJsonSync(path.join(userDataDir, 'config.json'));
    expect(config.app.theme).toBe('dark');
    expect(config.database.mongodb.host).toBe('new-host');
    // 存放位置維持目前的設定
    expect(config.storage).toEqual({ imagesDir: 'D:\\images', backupDir: '' });
  });

  test('還原前備份存在 pre-restore', async () => {
    await addVideo(1);
    const dir = await manager.backupBeforeRestore(db);
    expect(path.dirname(dir)).toBe(manager.preRestoreDir);
    expect((await manager.inspectBackup(dir)).videos).toBe(1);
  });

  test('不是 VideoNow 備份的資料夾無法還原', async () => {
    await expect(manager.inspectBackup(outDir)).rejects.toThrow('不是 VideoNow 備份');

    const Database = require('better-sqlite3');
    const other = new Database(path.join(outDir, 'videonow.db'));
    other.exec('CREATE TABLE foo (id INTEGER)');
    other.close();
    await expect(manager.inspectBackup(outDir)).rejects.toThrow('缺少 videos / tags');
  });
});
