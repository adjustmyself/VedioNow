const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const FileFingerprint = require('../src/fileFingerprint');

describe('FileFingerprint v2', () => {
  let tmpDir;
  const fp = new FileFingerprint();

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'videonow-fp-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  test('mtime 改變不影響指紋（核心：搬檔/同步工具不會弄丟標籤）', async () => {
    const file = path.join(tmpDir, 'a.mp4');
    await fs.writeFile(file, Buffer.alloc(200 * 1024, 7));

    const fp1 = await fp.calculateFingerprint(file);

    // 改 mtime，內容不變
    await fs.utimes(file, new Date('2001-01-01'), new Date('2001-01-01'));
    const fp2 = await fp.calculateFingerprint(file);

    expect(fp2).toBe(fp1);
  });

  test('檔案搬移/改名後指紋不變', async () => {
    const file1 = path.join(tmpDir, 'a.mp4');
    await fs.writeFile(file1, Buffer.alloc(200 * 1024, 7));
    const fp1 = await fp.calculateFingerprint(file1);

    const file2 = path.join(tmpDir, 'renamed.mp4');
    await fs.move(file1, file2);
    const fp2 = await fp.calculateFingerprint(file2);

    expect(fp2).toBe(fp1);
  });

  test('檔尾內容不同 → 指紋不同（區分同片頭的系列影片）', async () => {
    const sizeBytes = 300 * 1024;
    const bufA = Buffer.alloc(sizeBytes, 1);
    const bufB = Buffer.alloc(sizeBytes, 1);
    bufB[sizeBytes - 1] = 99; // 只改最後一個 byte

    const fileA = path.join(tmpDir, 'a.mp4');
    const fileB = path.join(tmpDir, 'b.mp4');
    await fs.writeFile(fileA, bufA);
    await fs.writeFile(fileB, bufB);

    expect(await fp.calculateFingerprint(fileA)).not.toBe(await fp.calculateFingerprint(fileB));
  });

  test('檔案大小不同 → 指紋不同', async () => {
    const fileA = path.join(tmpDir, 'a.mp4');
    const fileB = path.join(tmpDir, 'b.mp4');
    await fs.writeFile(fileA, Buffer.alloc(64 * 1024, 1));
    await fs.writeFile(fileB, Buffer.alloc(65 * 1024, 1));

    expect(await fp.calculateFingerprint(fileA)).not.toBe(await fp.calculateFingerprint(fileB));
  });

  test('小於 64KB 的檔案也能計算', async () => {
    const file = path.join(tmpDir, 'small.mp4');
    await fs.writeFile(file, Buffer.from('tiny video'));

    const result = await fp.calculateFingerprint(file);
    expect(result).toMatch(/^[a-f0-9]{32}$/);
  });

  test('verifyFingerprint 一致性', async () => {
    const file = path.join(tmpDir, 'a.mp4');
    await fs.writeFile(file, Buffer.alloc(100 * 1024, 3));
    const fingerprint = await fp.calculateFingerprint(file);

    expect(await fp.verifyFingerprint(file, fingerprint)).toBe(true);
    expect(await fp.verifyFingerprint(file, 'deadbeef')).toBe(false);
  });
});
