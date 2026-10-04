const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { IMAGE_SUBDIRS, validateTarget, moveSubdirs } = require('../src/storageMover');

describe('storageMover', () => {
  let root;
  let from;
  let to;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-storage-'));
    from = path.join(root, 'from');
    to = path.join(root, 'to');
    fs.outputFileSync(path.join(from, 'thumbnails', 'fp-a.jpg'), 'a');
    fs.outputFileSync(path.join(from, 'tag-images', 't.png'), 't');
    fs.outputFileSync(path.join(from, 'videonow.db'), 'db');
  });

  afterEach(() => {
    fs.removeSync(root);
  });

  test('搬移圖片子資料夾，其他檔案留在原處', async () => {
    await validateTarget(from, to, IMAGE_SUBDIRS);
    const commit = jest.fn();
    expect(await moveSubdirs(from, to, IMAGE_SUBDIRS, commit)).toBe(2);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(to, 'thumbnails', 'fp-a.jpg'), 'utf8')).toBe('a');
    expect(fs.readFileSync(path.join(to, 'tag-images', 't.png'), 'utf8')).toBe('t');
    expect(fs.pathExistsSync(path.join(from, 'thumbnails'))).toBe(false);
    expect(fs.pathExistsSync(path.join(from, 'videonow.db'))).toBe(true);
  });

  test('目的地已有同名檔案時保留目的地的', async () => {
    fs.outputFileSync(path.join(to, 'thumbnails', 'fp-a.jpg'), 'existing');
    fs.outputFileSync(path.join(to, 'thumbnails', 'fp-b.jpg'), 'b');
    await moveSubdirs(from, to, IMAGE_SUBDIRS);
    expect(fs.readFileSync(path.join(to, 'thumbnails', 'fp-a.jpg'), 'utf8')).toBe('existing');
    expect(fs.readdirSync(path.join(to, 'thumbnails')).sort()).toEqual(['fp-a.jpg', 'fp-b.jpg']);
  });

  test('commit 失敗時不刪除舊位置的檔案', async () => {
    await expect(moveSubdirs(from, to, IMAGE_SUBDIRS, async () => { throw new Error('寫入設定失敗'); }))
      .rejects.toThrow('寫入設定失敗');
    expect(fs.pathExistsSync(path.join(from, 'thumbnails', 'fp-a.jpg'))).toBe(true);
  });

  test('拒絕相同位置與互相包含的位置', async () => {
    await expect(validateTarget(from, from, IMAGE_SUBDIRS)).rejects.toThrow('相同');
    await expect(validateTarget(from, path.join(from, 'thumbnails', 'x'), IMAGE_SUBDIRS)).rejects.toThrow('裡面');
    await expect(validateTarget(from, 'relative/dir', IMAGE_SUBDIRS)).rejects.toThrow('完整路徑');
    // 選在舊位置底下的其他資料夾可以
    await expect(validateTarget(from, path.join(from, 'images'), IMAGE_SUBDIRS)).resolves.toBeUndefined();
  });
});
