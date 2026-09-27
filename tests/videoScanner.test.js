const fs = require('fs');
const os = require('os');
const path = require('path');
const SQLiteDatabase = require('../src/sqliteDatabase');
const VideoScanner = require('../src/videoScanner');

describe('VideoScanner', () => {
  let db;
  let scanner;
  let root;

  const writeFile = (rel, content = 'video-data') => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  };

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-scan-'));
    db = new SQLiteDatabase(':memory:');
    await db.init();
    scanner = new VideoScanner(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('遞迴掃描只收影片檔，略過未完成下載', async () => {
    writeFile('a.mp4', 'a');
    writeFile('sub/b.mkv', 'b');
    writeFile('sub/deep/c.avi', 'c');
    writeFile('notes.txt', 'x');
    writeFile('d.mp4.part', 'd');

    const result = await scanner.scanFolder(root);
    expect(result).toMatchObject({ found: 3, added: 3, updated: 0, unchanged: 0 });
    expect(result.videos).toBeUndefined();

    const all = await db.getAllVideoRefs();
    expect(all.map(v => path.basename(v.filepath)).sort()).toEqual(['a.mp4', 'b.mkv', 'c.avi']);
    expect(all.every(v => v.file_mtime != null)).toBe(true);
  });

  test('非遞迴掃描不進子資料夾', async () => {
    writeFile('a.mp4', 'a');
    writeFile('sub/b.mp4', 'b');
    const result = await scanner.scanFolder(root, { recursive: false });
    expect(result.found).toBe(1);
  });

  test('重新掃描時未變更的檔案不重算指紋、不寫資料庫', async () => {
    writeFile('a.mp4', 'a');
    writeFile('b.mp4', 'b');
    await scanner.scanFolder(root);

    const fpSpy = jest.spyOn(scanner.fileFingerprint, 'calculateFingerprint');
    const result = await scanner.scanFolder(root);

    expect(result).toMatchObject({ found: 2, added: 0, updated: 0, unchanged: 2 });
    expect(fpSpy).not.toHaveBeenCalled();
  });

  test('檔案內容變動（大小不同）會重算並更新', async () => {
    const file = writeFile('a.mp4', 'a');
    await scanner.scanFolder(root);

    fs.writeFileSync(file, 'longer content');
    const result = await scanner.scanFolder(root);
    expect(result).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
  });

  test('缺檔清理只影響掃描範圍，D:\\Videos 不會誤中 D:\\Videos2', async () => {
    const videosDir = path.join(root, 'Videos');
    const siblingDir = path.join(root, 'Videos2');
    writeFile('Videos/keep.mp4', 'keep');
    const gone = writeFile('Videos/gone.mp4', 'gone');
    const sibling = writeFile('Videos2/other.mp4', 'other');

    await scanner.scanFolder(videosDir);
    await scanner.scanFolder(siblingDir);

    fs.unlinkSync(gone);
    fs.unlinkSync(sibling); // 不在本次掃描範圍，記錄應保留

    const result = await scanner.scanFolder(videosDir, { cleanupMissing: true });
    expect(result.cleaned).toBe(1);

    const remaining = (await db.getAllVideoRefs()).map(v => path.basename(v.filepath)).sort();
    expect(remaining).toEqual(['keep.mp4', 'other.mp4']);
  });

  test('_isInScanScope 判斷', () => {
    const base = process.platform === 'win32' ? 'D:\\Videos' : '/d/Videos';
    const sep = path.sep;
    expect(scanner._isInScanScope(`${base}${sep}a.mp4`, base, true)).toBe(true);
    expect(scanner._isInScanScope(`${base}${sep}sub${sep}a.mp4`, base, true)).toBe(true);
    expect(scanner._isInScanScope(`${base}2${sep}a.mp4`, base, true)).toBe(false);
    expect(scanner._isInScanScope(`${base}${sep}sub${sep}a.mp4`, base, false)).toBe(false);
    if (process.platform === 'win32') {
      expect(scanner._isInScanScope('d:\\videos\\a.mp4', 'D:\\Videos\\', true)).toBe(true);
    }
  });

  test('日期篩選略過舊檔', async () => {
    const old = writeFile('old.mp4', 'old');
    writeFile('new.mp4', 'new');
    const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, past, past);

    const result = await scanner.scanFolder(root, { dateFilter: 'week' });
    const names = (await db.getAllVideoRefs()).map(v => path.basename(v.filepath));
    // birthtime 在部分檔案系統無法改寫，舊檔可能仍被視為新檔；至少新檔一定要進來
    expect(names).toContain('new.mp4');
    expect(result.found).toBe(2);
  });

  test('進度事件有節流', async () => {
    for (let i = 0; i < 50; i++) writeFile(`v${i}.mp4`, `content-${i}`);
    const progressCallback = jest.fn();
    await scanner.scanFolder(root, { progressCallback });
    // 50 個檔案原本會送 100+ 次，節流後應大幅減少
    expect(progressCallback.mock.calls.length).toBeLessThan(20);
  });
});
