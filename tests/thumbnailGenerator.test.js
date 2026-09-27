const fs = require('fs');
const os = require('os');
const path = require('path');
const ThumbnailGenerator = require('../src/thumbnailGenerator');
const { buildOffsets, parseDurationSeconds } = ThumbnailGenerator;

describe('ThumbnailGenerator', () => {
  let gen;
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-thumb-'));
    gen = new ThumbnailGenerator();
    gen.thumbnailsDir = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('-ss 放在 -i 之前（快速定位），並停用音訊/字幕串流', () => {
    const args = gen.buildFfmpegArgs('C:\\videos\\a.mkv', 'C:\\thumbs\\x.jpg', 42);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('42');
    expect(args).toEqual(expect.arrayContaining(['-an', '-sn', '-dn']));
    expect(args[args.length - 1]).toBe('C:/thumbs/x.jpg');
  });

  test('UNC 路徑保留反斜線', () => {
    const args = gen.buildFfmpegArgs('\\\\nas\\share\\a.avi', 'C:\\thumbs\\x.jpg', 30);
    expect(args[args.indexOf('-i') + 1]).toBe('\\\\nas\\share\\a.avi');
  });

  test('擷取時間點：指定秒數優先，失敗往較早時間點退', () => {
    expect(buildOffsets(undefined)).toEqual([30, 10, 3, 0]);
    expect(buildOffsets(120)).toEqual([120, 30, 10, 3, 0]);
    expect(buildOffsets(5)).toEqual([5, 3, 0]);
    expect(buildOffsets(0)).toEqual([0]);
  });

  test('從 FFmpeg 輸出解析影片長度', () => {
    expect(parseDurationSeconds('  Duration: 00:01:02.50, start: 0.000000')).toBeCloseTo(62.5);
    expect(parseDurationSeconds('no duration here')).toBeNull();
  });

  test('0 byte 殘檔不算有效縮圖', async () => {
    const videoPath = 'C:\\videos\\a.mkv';
    fs.writeFileSync(gen.getThumbnailPath(videoPath), '');
    expect(await gen.thumbnailExists(videoPath)).toBeNull();

    fs.writeFileSync(gen.getThumbnailPath(videoPath), 'jpg');
    expect(await gen.thumbnailExists(videoPath)).toBe(gen.getThumbnailPath(videoPath));
  });

  test('同一支影片同時請求只產生一次', async () => {
    let resolveGen;
    const spy = jest.spyOn(gen, 'generateWithFFmpeg').mockImplementation((videoPath, thumbPath) =>
      new Promise(resolve => { resolveGen = () => resolve(thumbPath); })
    );

    const p1 = gen.generateThumbnail('C:\\videos\\a.mkv');
    const p2 = gen.generateThumbnail('C:\\videos\\a.mkv');
    // 等第一個請求真的開始產生（前面有 fs 檢查）
    while (!resolveGen) await new Promise(r => setTimeout(r, 5));
    resolveGen();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('FFmpeg 未輸出畫面時改試下一個時間點，成功才寫入正式檔', async () => {
    const thumbPath = gen.getThumbnailPath('C:\\videos\\short.mp4');
    const offsetsTried = [];
    jest.spyOn(gen, '_runFfmpeg').mockImplementation(async (args) => {
      const offset = Number(args[args.indexOf('-ss') + 1]);
      offsetsTried.push(offset);
      // 影片只有 8 秒：超過長度時結束碼 0 但沒有輸出
      if (offset < 8) fs.writeFileSync(args[args.length - 1], 'jpg');
      return { code: 0, stderr: 'Duration: 00:00:08.00' };
    });

    const result = await gen.generateWithFFmpeg('C:\\videos\\short.mp4', thumbPath, 30);
    expect(result).toBe(thumbPath);
    expect(fs.readFileSync(thumbPath, 'utf8')).toBe('jpg');
    expect(fs.existsSync(`${thumbPath}.tmp.jpg`)).toBe(false);
    // 第一次得知長度後，直接改用影片 20% 處
    expect(offsetsTried).toEqual([30, 1]);
  });

  test('全部失敗時不留下任何檔案', async () => {
    const thumbPath = gen.getThumbnailPath('C:\\videos\\bad.mp4');
    jest.spyOn(gen, '_runFfmpeg').mockResolvedValue({ code: 1, stderr: 'Invalid data' });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gen.generateWithFFmpeg('C:\\videos\\bad.mp4', thumbPath, 30)).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
