const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { getUserDataDir } = require('./appPaths');
const FileFingerprint = require('./fileFingerprint');

// 優先使用打包的 ffmpeg-static，使用者不必自行安裝 FFmpeg；
// 取不到（極少數平台）時退回 PATH 上的 ffmpeg
function resolveFfmpegPath() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic) {
      // 打包成 asar 後，執行檔必須從 app.asar.unpacked 取得才能 spawn
      return ffmpegStatic.replace('app.asar', 'app.asar.unpacked');
    }
  } catch (e) {
    console.warn('ffmpeg-static 不可用，改用系統 PATH 中的 ffmpeg:', e.message);
  }
  return 'ffmpeg';
}

const FFMPEG_PATH = resolveFfmpegPath();

// 同時執行的 FFmpeg 行程上限（全域共用）。一頁全是 MKV/AVI 時不會一口氣開十幾個行程搶網路與 CPU
const MAX_FFMPEG_PROCESSES = Math.min(3, Math.max(1, Math.floor(os.cpus().length / 2)));
// 失敗時只保留最後這麼多字的 stderr 供錯誤訊息使用
const STDERR_TAIL_CHARS = 2000;
// 滑過預覽：一張橫向長條圖，PREVIEW_FRAMES 格、每格 PREVIEW_WIDTH x PREVIEW_HEIGHT（不足的比例補黑邊）
const PREVIEW_FRAMES = 10;
const PREVIEW_WIDTH = 320;
const PREVIEW_HEIGHT = 180;
// Duration 出現在 stderr 開頭的輸入資訊裡；只保留尾段會被串流/中繼資料擠掉，所以另存開頭這段來解析長度
const STDERR_HEAD_CHARS = 16000;

let runningProcesses = 0;
const waitingQueue = [];

async function withFfmpegSlot(task) {
  if (runningProcesses >= MAX_FFMPEG_PROCESSES) {
    await new Promise(resolve => waitingQueue.push(resolve));
  }
  runningProcesses++;
  try {
    return await task();
  } finally {
    runningProcesses--;
    const next = waitingQueue.shift();
    if (next) next();
  }
}

// 從 FFmpeg 輸出解析影片長度（秒），解析不到回傳 null
function parseDurationSeconds(stderr) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// 擷取時間點：指定秒數優先，失敗時往較早的時間點退（影片比指定秒數短時才找得到畫面）
function buildOffsets(timeOffset) {
  const primary = Number(timeOffset);
  const start = Number.isFinite(primary) && primary >= 0 ? primary : 30;
  const fallbacks = [30, 10, 3, 0].filter(o => o < start);
  return [start, ...fallbacks];
}

class ThumbnailGenerator {
  constructor() {
    // 縮圖將儲存在本地快取目錄中，避免網路磁碟權限問題
    // 放 userData：舊版存在程式目錄，重新 package 後整批縮圖就要重生
    this.thumbnailsDir = path.join(getUserDataDir(), 'thumbnails');
    // 同一支影片的縮圖同時只產一次（重複請求共用同一個 Promise）
    this.inflight = new Map();
    // 滑過預覽的長條圖，命名方式與縮圖相同
    this.previewsDir = path.join(getUserDataDir(), 'previews');
    // 產縮圖時順便得知影片長度就回呼 (videoPath, seconds)，由主行程寫回資料庫
    this.onDuration = null;
  }

  // 舊版縮圖檔名：檔案路徑的 MD5。只用在沒有指紋的影片，以及辨識尚未改名的舊縮圖
  generateFileHash(videoPath) {
    const normalizedPath = path.normalize(videoPath).toLowerCase();
    return crypto.createHash('md5').update(normalizedPath).digest('hex');
  }

  // 縮圖檔名（不含副檔名）：有指紋時用內容指紋，搬移/改名後仍找得到同一張縮圖，
  // 內容相同的複本（:dup:）也共用一張；沒有指紋時退回路徑雜湊。
  // 指紋來自渲染器，不是 32 位十六進位就再雜湊一次，避免拿來組出任意路徑
  thumbnailKey(videoPath, fingerprint) {
    if (fingerprint) {
      const base = FileFingerprint.baseFingerprint(fingerprint);
      const safe = /^[0-9a-f]{32}$/.test(base) ? base : crypto.createHash('md5').update(base).digest('hex');
      return `fp-${safe}`;
    }
    return this.generateFileHash(videoPath);
  }

  // 產生縮圖路徑 (在本地快取目錄中)
  getThumbnailPath(videoPath, fingerprint) {
    return path.join(this.thumbnailsDir, `${this.thumbnailKey(videoPath, fingerprint)}.jpg`);
  }

  getPreviewPath(videoPath, fingerprint) {
    return path.join(this.previewsDir, `${this.thumbnailKey(videoPath, fingerprint)}.jpg`);
  }

  getLegacyThumbnailPath(videoPath) {
    return path.join(this.thumbnailsDir, `${this.generateFileHash(videoPath)}.jpg`);
  }

  // 獲取縮圖目錄路徑
  getThumbnailDir() {
    return this.thumbnailsDir;
  }

  // 檢查縮圖是否存在（0 byte 的殘檔視為不存在）。
  // 指紋命名的縮圖不存在、但有舊版路徑命名的縮圖時，就地改名沿用，不必重新產生
  async thumbnailExists(videoPath, fingerprint) {
    const thumbnailPath = this.getThumbnailPath(videoPath, fingerprint);
    if (await this._isValidFile(thumbnailPath)) return thumbnailPath;
    if (!fingerprint) return null;

    const legacyPath = this.getLegacyThumbnailPath(videoPath);
    if (!await this._isValidFile(legacyPath)) return null;
    try {
      await fs.move(legacyPath, thumbnailPath, { overwrite: false });
    } catch {
      // 同時有另一個請求先改好名，或新檔已存在：以新檔為準，舊檔留給清理
    }
    if (await this._isValidFile(thumbnailPath)) return thumbnailPath;
    return null;
  }

  async _isValidFile(filePath) {
    try {
      const stat = await fs.stat(filePath);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  // 組 FFmpeg 參數：-ss 放在 -i 前面用關鍵格快速定位，
  // 放在後面會從頭解碼到指定秒數，網路磁碟上等於先讀完前段影片
  buildFfmpegArgs(videoPath, outputPath, offset) {
    // 標準化路徑：UNC 網路路徑（\\server\share）必須保留反斜線，
    // FFmpeg 在 Windows 上無法識別 //server/share 格式
    const isUNC = videoPath.startsWith('\\\\') || videoPath.startsWith('//');
    const normalizedVideoPath = isUNC
      ? videoPath.replace(/\//g, '\\')
      : videoPath.replace(/\\/g, '/');

    return [
      '-hide_banner',
      '-ss', String(offset),
      '-i', normalizedVideoPath,
      '-an', '-sn', '-dn',
      '-frames:v', '1',
      // 縮放到寬 640px、維持比例（高為奇數時自動補成偶數）
      '-vf', 'scale=640:-2:flags=lanczos',
      '-q:v', '2',
      '-f', 'image2',
      '-update', '1',
      '-y', outputPath.replace(/\\/g, '/')
    ];
  }

  // 標準化路徑：UNC 網路路徑（\\server\share）必須保留反斜線，
  // FFmpeg 在 Windows 上無法識別 //server/share 格式
  normalizeInputPath(videoPath) {
    const isUNC = videoPath.startsWith('\\\\') || videoPath.startsWith('//');
    return isUNC
      ? videoPath.replace(/\//g, '\\')
      : videoPath.replace(/\\/g, '/');
  }

  // 結果：{ code, stderr（尾段）, duration（從開頭解析，取不到為 null）}
  _runFfmpeg(args) {
    return new Promise((resolve) => {
      let stderrTail = '';
      let stderrHead = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let ffmpeg;
      try {
        ffmpeg = spawn(FFMPEG_PATH, args, { windowsVerbatimArguments: false, shell: false });
      } catch (error) {
        finish({ code: -1, stderr: error.message });
        return;
      }

      ffmpeg.stderr.on('data', (data) => {
        const text = data.toString();
        if (stderrHead.length < STDERR_HEAD_CHARS) stderrHead += text.slice(0, STDERR_HEAD_CHARS - stderrHead.length);
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      });
      ffmpeg.on('error', (error) => finish({ code: -1, stderr: error.message, duration: null }));
      ffmpeg.on('close', (code) => finish({ code, stderr: stderrTail, duration: parseDurationSeconds(stderrHead) }));
    });
  }

  // 使用 FFmpeg 生成縮圖。先寫到暫存檔、確認有內容才改名，
  // 避免中途失敗留下壞檔被當成有效縮圖
  async generateWithFFmpeg(videoPath, thumbnailPath, timeOffset = 30) {
    const tmpPath = `${thumbnailPath}.tmp.jpg`;
    const offsets = buildOffsets(timeOffset);
    let duration = null;
    let lastError = '';

    try {
      for (let i = 0; i < offsets.length; i++) {
        let offset = offsets[i];
        // 已知影片長度時，超出長度的時間點改成影片 20% 處
        if (duration != null && offset >= duration) {
          offset = Math.floor(duration * 0.2);
          if (i > 0 && offsets.slice(0, i).includes(offset)) continue;
        }

        const result = await withFfmpegSlot(() =>
          this._runFfmpeg(this.buildFfmpegArgs(videoPath, tmpPath, offset))
        );
        const { code, stderr } = result;
        if (duration == null) {
          duration = result.duration ?? parseDurationSeconds(stderr);
          if (duration != null) this._reportDuration(videoPath, duration);
        }

        // 時間點超過影片長度時 FFmpeg 仍會回傳 0 但不輸出畫面，要檢查檔案
        const stat = await fs.stat(tmpPath).catch(() => null);
        if (code === 0 && stat && stat.size > 0) {
          await fs.move(tmpPath, thumbnailPath, { overwrite: true });
          return thumbnailPath;
        }
        lastError = `exit code ${code} @${offset}s: ${stderr.slice(-300)}`;
      }
    } finally {
      await fs.remove(tmpPath).catch(() => {});
    }

    console.error(`FFmpeg 縮圖生成失敗: ${videoPath}\n${lastError}`);
    throw new Error(`FFmpeg failed for all time offsets\n${lastError}`);
  }

  // 預覽各格的擷取時間點：平均分布在影片 5%～95%
  static previewOffsets(duration, frames = PREVIEW_FRAMES) {
    return Array.from({ length: frames }, (_, i) =>
      Math.round(duration * (0.05 + 0.9 * i / (frames - 1)) * 10) / 10
    );
  }

  // 一次 FFmpeg 執行：每個時間點各開一個輸入（-ss 在 -i 前快速定位），縮放補邊後橫向拼接
  buildPreviewArgs(videoPath, outputPath, offsets) {
    const input = this.normalizeInputPath(videoPath);
    const args = ['-hide_banner'];
    for (const offset of offsets) args.push('-ss', String(offset), '-i', input);
    const scaled = offsets.map((_, i) =>
      `[${i}:v:0]scale=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${PREVIEW_WIDTH}:${PREVIEW_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
    );
    const stack = `${offsets.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${offsets.length}[out]`;
    args.push(
      '-filter_complex', `${scaled.join(';')};${stack}`,
      '-map', '[out]',
      '-frames:v', '1',
      '-q:v', '4',
      '-f', 'image2',
      '-update', '1',
      '-y', outputPath.replace(/\\/g, '/')
    );
    return args;
  }

  async previewExists(videoPath, fingerprint) {
    const previewPath = this.getPreviewPath(videoPath, fingerprint);
    return await this._isValidFile(previewPath) ? previewPath : null;
  }

  // 產生滑過預覽（已存在就直接回傳）。knownDuration 為資料庫裡的長度，沒有時先讀檔頭
  async generatePreview(videoPath, fingerprint, knownDuration = 0) {
    const previewPath = this.getPreviewPath(videoPath, fingerprint);
    const pending = this.inflight.get(previewPath);
    if (pending) return pending;

    const task = (async () => {
      if (await this._isValidFile(previewPath)) return previewPath;

      let duration = Number(knownDuration) > 0 ? Number(knownDuration) : null;
      if (!duration) {
        duration = await this.probeDuration(videoPath);
        if (duration) this._reportDuration(videoPath, duration);
      }
      if (!duration || duration < 2) throw new Error('無法取得影片長度或影片太短');

      await fs.ensureDir(this.previewsDir);
      const tmpPath = `${previewPath}.tmp.jpg`;
      try {
        const offsets = ThumbnailGenerator.previewOffsets(duration);
        const { code, stderr } = await withFfmpegSlot(() =>
          this._runFfmpeg(this.buildPreviewArgs(videoPath, tmpPath, offsets))
        );
        if (code !== 0 || !await this._isValidFile(tmpPath)) {
          throw new Error(`FFmpeg 產生預覽失敗 (exit ${code}): ${stderr.slice(-300)}`);
        }
        await fs.move(tmpPath, previewPath, { overwrite: true });
        return previewPath;
      } finally {
        await fs.remove(tmpPath).catch(() => {});
      }
    })();

    this.inflight.set(previewPath, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(previewPath);
    }
  }

  _reportDuration(videoPath, seconds) {
    if (!this.onDuration || !(seconds > 0)) return;
    try {
      Promise.resolve(this.onDuration(videoPath, seconds)).catch(err =>
        console.warn(`寫入影片長度失敗: ${videoPath}`, err.message)
      );
    } catch (err) {
      console.warn(`寫入影片長度失敗: ${videoPath}`, err.message);
    }
  }

  // 只讀影片標頭取得長度（秒），不產生任何檔案；取不到回傳 null。
  // 補齊舊資料用：已經有縮圖的影片不會再跑 generateWithFFmpeg
  async probeDuration(videoPath) {
    const { duration, stderr } = await withFfmpegSlot(() =>
      this._runFfmpeg(['-hide_banner', '-i', this.normalizeInputPath(videoPath)])
    );
    return duration ?? parseDurationSeconds(stderr);
  }

  // 畫面端用 <video> + canvas 擷取的 JPEG（瀏覽器能播的格式不必跑 FFmpeg），由主行程寫檔。
  // 已有縮圖時沿用既有的，不覆蓋
  async saveThumbnailBuffer(videoPath, fingerprint, buffer) {
    const existing = await this.thumbnailExists(videoPath, fingerprint);
    if (existing) return existing;

    const thumbnailPath = this.getThumbnailPath(videoPath, fingerprint);
    await fs.ensureDir(this.thumbnailsDir);
    const tmpPath = `${thumbnailPath}.tmp.jpg`;
    try {
      await fs.writeFile(tmpPath, buffer);
      await fs.move(tmpPath, thumbnailPath, { overwrite: true });
    } finally {
      await fs.remove(tmpPath).catch(() => {});
    }
    return thumbnailPath;
  }

  // 主要生成縮圖方法（timeOffset：指定擷取秒數，未指定則預設 30 秒）
  async generateThumbnail(videoPath, timeOffset, fingerprint) {
    const thumbnailPath = this.getThumbnailPath(videoPath, fingerprint);
    const pending = this.inflight.get(thumbnailPath);
    if (pending) return pending;

    const task = (async () => {
      // 先檢查縮圖是否已存在
      const existingThumbnail = await this.thumbnailExists(videoPath, fingerprint);
      if (existingThumbnail) {
        return existingThumbnail;
      }

      // 確保縮圖目錄存在
      await fs.ensureDir(this.thumbnailsDir);
      return this.generateWithFFmpeg(videoPath, thumbnailPath, timeOffset);
    })();

    this.inflight.set(thumbnailPath, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(thumbnailPath);
    }
  }

  // 清理過期縮圖。videos：資料庫中所有影片 [{ filepath, fingerprint }]（也接受純路徑字串）。
  // 指紋命名與舊版路徑命名都算有效：尚未被查詢改名的舊縮圖不能刪
  async cleanupThumbnails(videos = []) {
    try {
      const validHashes = new Set();
      for (const video of videos) {
        const filepath = typeof video === 'string' ? video : video.filepath;
        const fingerprint = typeof video === 'string' ? null : video.fingerprint;
        validHashes.add(this.generateFileHash(filepath));
        if (fingerprint) validHashes.add(this.thumbnailKey(filepath, fingerprint));
      }

      // 縮圖與滑過預覽用同一套檔名，一起清理
      const thumbnails = await this._cleanupDir(this.thumbnailsDir, validHashes);
      const previews = await this._cleanupDir(this.previewsDir, validHashes);
      if (thumbnails + previews > 0) {
        console.log(`縮圖清理完成，共刪除 ${thumbnails} 個過期縮圖、${previews} 個過期預覽`);
      }
    } catch (error) {
      console.error('清理縮圖時發生錯誤:', error);
    }
  }

  // 刪除目錄中檔名不在 validHashes 的 jpg（中斷留下的 .tmp.jpg 一併清掉），回傳刪除數
  async _cleanupDir(dir, validHashes) {
    if (!await fs.pathExists(dir)) return 0;
    let count = 0;
    try {
      for (const file of await fs.readdir(dir)) {
        if (path.extname(file).toLowerCase() !== '.jpg') continue;
        if (validHashes.has(path.basename(file, '.jpg'))) continue;
        await fs.remove(path.join(dir, file));
        count++;
      }
    } catch (error) {
      console.warn(`清理目錄失敗 ${dir}:`, error.message);
    }
    return count;
  }

  // 獲取縮圖統計資訊（previews：滑過預覽）
  async getThumbnailStats() {
    try {
      const [thumbnails, previews] = await Promise.all([
        this._dirStats(this.thumbnailsDir),
        this._dirStats(this.previewsDir)
      ]);
      return { ...thumbnails, previews };
    } catch (error) {
      console.error('獲取縮圖統計資訊失敗:', error);
      return { total: 0, size: 0, previews: { total: 0, size: 0 } };
    }
  }

  async _dirStats(dir) {
    if (!await fs.pathExists(dir)) return { total: 0, size: 0 };
    const jpgFiles = (await fs.readdir(dir)).filter(file => path.extname(file).toLowerCase() === '.jpg');
    const sizes = await Promise.all(jpgFiles.map(file =>
      fs.stat(path.join(dir, file)).then(st => st.size).catch(() => 0)
    ));
    return { total: jpgFiles.length, size: sizes.reduce((sum, size) => sum + size, 0) };
  }
}

module.exports = ThumbnailGenerator;
module.exports.buildOffsets = buildOffsets;
module.exports.parseDurationSeconds = parseDurationSeconds;
