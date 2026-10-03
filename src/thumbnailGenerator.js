const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { getUserDataDir } = require('./appPaths');

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
    // 產縮圖時順便得知影片長度就回呼 (videoPath, seconds)，由主行程寫回資料庫
    this.onDuration = null;
  }

  // 生成檔案路徑的唯一hash值
  generateFileHash(videoPath) {
    // 使用MD5生成檔案路徑的hash，作為縮圖的唯一key
    const normalizedPath = path.normalize(videoPath).toLowerCase();
    return crypto.createHash('md5').update(normalizedPath).digest('hex');
  }

  // 產生縮圖路徑 (在本地快取目錄中)
  getThumbnailPath(videoPath) {
    const fileHash = this.generateFileHash(videoPath);
    return path.join(this.thumbnailsDir, `${fileHash}.jpg`);
  }

  // 獲取縮圖目錄路徑
  getThumbnailDir() {
    return this.thumbnailsDir;
  }

  // 檢查縮圖是否存在（0 byte 的殘檔視為不存在）
  async thumbnailExists(videoPath) {
    const thumbnailPath = this.getThumbnailPath(videoPath);
    try {
      const stat = await fs.stat(thumbnailPath);
      return stat.size > 0 ? thumbnailPath : null;
    } catch {
      return null;
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

  // 使用 Canvas 從 video 元素生成縮圖
  async generateWithCanvas(videoElement, thumbnailPath) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // 依影片原始比例縮放，目標寬度 640px（高 DPI / 加高縮圖也夠清楚）
    const TARGET_WIDTH = 640;
    const srcW = videoElement.videoWidth || 1280;
    const srcH = videoElement.videoHeight || 720;
    canvas.width = TARGET_WIDTH;
    canvas.height = Math.round(TARGET_WIDTH * (srcH / srcW));

    // 較佳的縮放品質
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('Failed to create blob');

    const buffer = Buffer.from(await blob.arrayBuffer());
    await fs.ensureDir(path.dirname(thumbnailPath));
    const tmpPath = `${thumbnailPath}.tmp.jpg`;
    await fs.writeFile(tmpPath, buffer);
    await fs.move(tmpPath, thumbnailPath, { overwrite: true });
    return thumbnailPath;
  }

  // 主要生成縮圖方法（timeOffset：指定擷取秒數，未指定則預設 30 秒）
  async generateThumbnail(videoPath, timeOffset) {
    const thumbnailPath = this.getThumbnailPath(videoPath);
    const pending = this.inflight.get(thumbnailPath);
    if (pending) return pending;

    const task = (async () => {
      // 先檢查縮圖是否已存在
      const existingThumbnail = await this.thumbnailExists(videoPath);
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

  // 清理過期縮圖 (根據有效的影片路徑列表)
  async cleanupThumbnails(validVideoPaths = []) {
    try {
      // 生成所有有效影片的hash值
      const validHashes = new Set(validVideoPaths.map(videoPath => this.generateFileHash(videoPath)));

      let cleanupCount = 0;

      // 檢查本地縮圖目錄
      if (!await fs.pathExists(this.thumbnailsDir)) {
        return;
      }

      try {
        const thumbnailFiles = await fs.readdir(this.thumbnailsDir);

        for (const thumbnailFile of thumbnailFiles) {
          // 只處理jpg檔案（中斷留下的 .tmp.jpg 一併清掉）
          if (path.extname(thumbnailFile).toLowerCase() === '.jpg') {
            const fileHash = path.basename(thumbnailFile, '.jpg');

            // 如果這個hash不在有效列表中，就刪除縮圖
            if (!validHashes.has(fileHash)) {
              const thumbnailPath = path.join(this.thumbnailsDir, thumbnailFile);
              await fs.remove(thumbnailPath);
              cleanupCount++;
            }
          }
        }
      } catch (error) {
        console.warn(`清理縮圖目錄失敗 ${this.thumbnailsDir}:`, error.message);
      }

      if (cleanupCount > 0) {
        console.log(`縮圖清理完成，共刪除 ${cleanupCount} 個過期縮圖`);
      }
    } catch (error) {
      console.error('清理縮圖時發生錯誤:', error);
    }
  }

  // 獲取縮圖統計資訊
  async getThumbnailStats() {
    try {
      // 檢查本地縮圖目錄
      if (!await fs.pathExists(this.thumbnailsDir)) {
        return { total: 0, size: 0 };
      }

      const thumbnailFiles = await fs.readdir(this.thumbnailsDir);
      const jpgFiles = thumbnailFiles.filter(file => path.extname(file).toLowerCase() === '.jpg');

      const sizes = await Promise.all(jpgFiles.map(file =>
        fs.stat(path.join(this.thumbnailsDir, file)).then(s => s.size).catch(() => 0)
      ));

      return {
        total: jpgFiles.length,
        size: sizes.reduce((sum, size) => sum + size, 0)
      };
    } catch (error) {
      console.error('獲取縮圖統計資訊失敗:', error);
      return { total: 0, size: 0 };
    }
  }

  // 為前端提供的生成縮圖方法 (在渲染進程中調用)
  async generateThumbnailInRenderer(videoElement, videoPath) {
    const thumbnailPath = this.getThumbnailPath(videoPath);

    // 檢查縮圖是否已存在
    const existingThumbnail = await this.thumbnailExists(videoPath);
    if (existingThumbnail) {
      return existingThumbnail;
    }

    // 確保縮圖目錄存在
    await fs.ensureDir(this.thumbnailsDir);

    // 使用 Canvas 生成縮圖
    try {
      return await this.generateWithCanvas(videoElement, thumbnailPath);
    } catch (error) {
      console.error('生成縮圖失敗:', error);
      return null;
    }
  }
}

module.exports = ThumbnailGenerator;
module.exports.buildOffsets = buildOffsets;
module.exports.parseDurationSeconds = parseDurationSeconds;
