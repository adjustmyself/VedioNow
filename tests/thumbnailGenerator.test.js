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

  test('產縮圖時解析到長度就回呼 onDuration（只回呼一次）', async () => {
    const thumbPath = gen.getThumbnailPath('C:\\videos\\short.mp4');
    const onDuration = jest.fn();
    gen.onDuration = onDuration;
    jest.spyOn(gen, '_runFfmpeg').mockImplementation(async (args) => {
      const offset = Number(args[args.indexOf('-ss') + 1]);
      if (offset < 8) fs.writeFileSync(args[args.length - 1], 'jpg');
      return { code: 0, stderr: '', duration: 8 };
    });

    await gen.generateWithFFmpeg('C:\\videos\\short.mp4', thumbPath, 30);
    expect(onDuration).toHaveBeenCalledTimes(1);
    expect(onDuration).toHaveBeenCalledWith('C:\\videos\\short.mp4', 8);
  });

  test('probeDuration 只帶 -i 讀檔頭，UNC 路徑保留反斜線', async () => {
    const spy = jest.spyOn(gen, '_runFfmpeg').mockResolvedValue({ code: 1, stderr: 'At least one output file must be specified', duration: 75.2 });
    expect(await gen.probeDuration('\\\\nas\\share\\a.mkv')).toBeCloseTo(75.2);
    expect(spy).toHaveBeenCalledWith(['-hide_banner', '-i', '\\\\nas\\share\\a.mkv']);

    spy.mockResolvedValue({ code: 1, stderr: 'No such file', duration: null });
    expect(await gen.probeDuration('C:\\missing.mp4')).toBeNull();
  });

  describe('以內容指紋命名', () => {
    const FP = '0123456789abcdef0123456789abcdef';

    test('有指紋用 fp-<基礎指紋>，複本共用同一張，沒有指紋退回路徑雜湊', () => {
      const a = gen.getThumbnailPath('C:\\videos\\a.mp4', FP);
      expect(path.basename(a)).toBe(`fp-${FP}.jpg`);
      // 搬移後路徑不同、指紋相同 → 同一張
      expect(gen.getThumbnailPath('D:\\moved\\renamed.mp4', FP)).toBe(a);
      // 內容相同的複本
      expect(gen.getThumbnailPath('E:\\copy\\a.mp4', `${FP}:dup:abcdef123456`)).toBe(a);
      expect(gen.getThumbnailPath('C:\\videos\\a.mp4', null)).toBe(gen.getLegacyThumbnailPath('C:\\videos\\a.mp4'));
    });

    test('不是 32 位十六進位的指紋再雜湊一次，不能組出目錄外的路徑', () => {
      const p = gen.getThumbnailPath('C:\\videos\\a.mp4', '..\\..\\evil');
      expect(path.dirname(p)).toBe(dir);
      expect(path.basename(p)).toMatch(/^fp-[0-9a-f]{32}\.jpg$/);
    });

    test('只有舊版路徑命名的縮圖時改名沿用，不重新產生', async () => {
      const videoPath = 'C:\\videos\\a.mp4';
      fs.writeFileSync(gen.getLegacyThumbnailPath(videoPath), 'old-jpg');

      const found = await gen.thumbnailExists(videoPath, FP);
      expect(found).toBe(gen.getThumbnailPath(videoPath, FP));
      expect(fs.readFileSync(found, 'utf8')).toBe('old-jpg');
      expect(fs.existsSync(gen.getLegacyThumbnailPath(videoPath))).toBe(false);

      const spy = jest.spyOn(gen, 'generateWithFFmpeg');
      expect(await gen.generateThumbnail(videoPath, undefined, FP)).toBe(found);
      expect(spy).not.toHaveBeenCalled();
    });

    test('新舊檔名都在時以新檔為準', async () => {
      const videoPath = 'C:\\videos\\a.mp4';
      fs.writeFileSync(gen.getLegacyThumbnailPath(videoPath), 'old');
      fs.writeFileSync(gen.getThumbnailPath(videoPath, FP), 'new');
      const found = await gen.thumbnailExists(videoPath, FP);
      expect(fs.readFileSync(found, 'utf8')).toBe('new');
    });

    test('清理保留指紋命名與尚未改名的舊縮圖，刪除其他', async () => {
      const keepFp = gen.getThumbnailPath('C:\\v\\a.mp4', FP);
      const keepLegacy = gen.getLegacyThumbnailPath('C:\\v\\b.mp4');
      const orphanFp = gen.getThumbnailPath('C:\\v\\gone.mp4', 'ffffffffffffffffffffffffffffffff');
      const orphanLegacy = gen.getLegacyThumbnailPath('C:\\v\\gone.mp4');
      [keepFp, keepLegacy, orphanFp, orphanLegacy].forEach(f => fs.writeFileSync(f, 'jpg'));

      await gen.cleanupThumbnails([
        { filepath: 'C:\\v\\a.mp4', fingerprint: FP },
        { filepath: 'C:\\v\\b.mp4', fingerprint: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }
      ]);

      expect(fs.readdirSync(dir).sort()).toEqual([path.basename(keepFp), path.basename(keepLegacy)].sort());
    });
  });

  describe('滑過預覽', () => {
    beforeEach(() => {
      gen.previewsDir = path.join(dir, 'previews');
    });

    test('擷取時間點平均分布在 5%～95%', () => {
      const offsets = ThumbnailGenerator.previewOffsets(100);
      // 畫面端靠 get-preview 回傳的 PREVIEW_FRAMES 切格，必須與實際格數一致
      expect(offsets).toHaveLength(ThumbnailGenerator.PREVIEW_FRAMES);
      expect(offsets[0]).toBe(5);
      expect(offsets[offsets.length - 1]).toBe(95);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    });

    test('每個時間點一個快速定位的輸入，橫向拼接成一張', () => {
      const args = gen.buildPreviewArgs('\\\\nas\\share\\a.mkv', 'C:\\out\\p.jpg', [1, 2, 3]);
      expect(args.filter(a => a === '-i')).toHaveLength(3);
      // -ss 都在對應的 -i 前面
      expect(args.slice(1, 5)).toEqual(['-ss', '1', '-i', '\\\\nas\\share\\a.mkv']);
      const filter = args[args.indexOf('-filter_complex') + 1];
      expect(filter).toContain('hstack=inputs=3');
      expect(filter).toContain('pad=320:180');
      expect(args[args.length - 1]).toBe('C:/out/p.jpg');
    });

    test('已有預覽就不再產生；沒有長度時先讀檔頭並回報', async () => {
      const onDuration = jest.fn();
      gen.onDuration = onDuration;
      jest.spyOn(gen, 'probeDuration').mockResolvedValue(60);
      const run = jest.spyOn(gen, '_runFfmpeg').mockImplementation(async (args) => {
        fs.writeFileSync(args[args.length - 1], 'jpg');
        return { code: 0, stderr: '', duration: null };
      });

      const p = await gen.generatePreview('C:\\v\\a.mp4', '0123456789abcdef0123456789abcdef', 0);
      expect(path.basename(p)).toBe('fp-0123456789abcdef0123456789abcdef.jpg');
      expect(onDuration).toHaveBeenCalledWith('C:\\v\\a.mp4', 60);

      await gen.generatePreview('C:\\v\\a.mp4', '0123456789abcdef0123456789abcdef', 60);
      expect(run).toHaveBeenCalledTimes(1);
    });

    test('FFmpeg 失敗時丟出錯誤、不留下暫存檔', async () => {
      jest.spyOn(gen, '_runFfmpeg').mockResolvedValue({ code: 1, stderr: 'Invalid data', duration: null });
      await expect(gen.generatePreview('C:\\v\\bad.mp4', null, 30)).rejects.toThrow('FFmpeg 產生預覽失敗');
      expect(fs.readdirSync(gen.previewsDir)).toEqual([]);
    });

    test('清理時預覽與縮圖一起清', async () => {
      fs.mkdirSync(gen.previewsDir, { recursive: true });
      const keep = gen.getPreviewPath('C:\\v\\a.mp4', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const orphan = gen.getPreviewPath('C:\\v\\gone.mp4', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      [keep, orphan].forEach(f => fs.writeFileSync(f, 'jpg'));
      await gen.cleanupThumbnails([{ filepath: 'C:\\v\\a.mp4', fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }]);
      expect(fs.readdirSync(gen.previewsDir)).toEqual([path.basename(keep)]);
      expect((await gen.getThumbnailStats()).previews).toEqual({ total: 1, size: 3 });
    });
  });

  test('全部失敗時不留下任何檔案', async () => {
    const thumbPath = gen.getThumbnailPath('C:\\videos\\bad.mp4');
    jest.spyOn(gen, '_runFfmpeg').mockResolvedValue({ code: 1, stderr: 'Invalid data' });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(gen.generateWithFFmpeg('C:\\videos\\bad.mp4', thumbPath, 30)).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
