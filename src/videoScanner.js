const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const FileFingerprint = require('./fileFingerprint');

// 讀取目錄與讀檔算指紋的全域併發上限（整次掃描共用，不隨資料夾深度倍增）
const DIR_CONCURRENCY = 4;
const FILE_CONCURRENCY = 8;
// 進度事件節流間隔，避免數萬個檔案各送一次 IPC
const PROGRESS_INTERVAL_MS = 150;

class VideoScanner {
  constructor(database) {
    this.database = database;
    this.supportedFormats = [
      '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v',
      '.3gp', '.ogv', '.ogg', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts'
    ];
    // BT 下載未完成檔案的副檔名
    this.incompleteDownloadExtensions = [
      '.part',      // qBittorrent, aria2, Firefox
      '.!ut',       // uTorrent
      '.crdownload',// Chrome
      '.tmp',       // 臨時檔案
      '.downloading',// 通用下載中
      '.download',  // 通用下載中
      '.partial',   // 部分下載
      '.aria2'      // aria2 控制檔案
    ];
    this.watchers = new Map();
    this.fileFingerprint = new FileFingerprint();
  }

  async scanFolder(folderPath, options = {}) {
    const { recursive = true, watchChanges = false, cleanupMissing = false, progressCallback = null, dateFilter = 'all' } = options;

    // 計算日期過濾的截止時間
    let dateThreshold = null;
    if (dateFilter === 'week') {
      dateThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    } else if (dateFilter === 'month') {
      dateThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    }

    if (!await fs.pathExists(folderPath)) {
      throw new Error(`路徑不存在: ${folderPath}`);
    }

    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) {
      throw new Error(`路徑不是資料夾: ${folderPath}`);
    }

    console.log(`開始掃描資料夾: ${folderPath}`);
    const progress = this._createProgressReporter(progressCallback);

    progress({
      phase: 'scanning',
      message: '正在掃描資料夾...',
      progress: 0,
      filesFound: 0,
      currentFile: folderPath
    }, true);

    // 1. 列出所有影片檔（只讀目錄，不讀檔案內容）
    const filePaths = await this._listVideoFiles(folderPath, recursive, (dir, count) => {
      progress({
        phase: 'scanning',
        message: `正在掃描資料夾... (已找到 ${count} 個)`,
        progress: 0,
        filesFound: count,
        currentFile: dir
      });
    });

    // 2. 既有記錄：大小與修改時間都沒變的檔案沿用原指紋，不必重讀檔案、也不必寫資料庫
    const existingByPath = new Map();
    for (const ref of await this.database.getAllVideoRefs()) {
      existingByPath.set(ref.filepath, ref);
    }

    const videos = [];
    let unchangedCount = 0;
    let checked = 0;
    await this._runWithConcurrency(filePaths, FILE_CONCURRENCY, async (itemPath) => {
      try {
        const fileStat = await fs.stat(itemPath);
        if (dateThreshold) {
          const birthtimeMs = fileStat.birthtime && fileStat.birthtime.getTime() > 0 ? fileStat.birthtime.getTime() : 0;
          const fileTimeMs = Math.max(fileStat.mtime.getTime(), birthtimeMs);
          if (fileTimeMs < dateThreshold.getTime()) return;
        }

        if (this._isUnchanged(existingByPath.get(itemPath), fileStat)) {
          unchangedCount++;
          return;
        }

        videos.push(await this._getVideoInfo(itemPath, fileStat));
      } catch (error) {
        console.warn(`無法讀取項目: ${itemPath}`, error.message);
      } finally {
        checked++;
        progress({
          phase: 'scanning',
          message: `正在檢查影片檔案... (${checked}/${filePaths.length})`,
          progress: (checked / filePaths.length) * 100,
          filesFound: filePaths.length,
          currentFile: path.basename(itemPath)
        });
      }
    });

    progress({
      phase: 'processing',
      message: `掃描完成，找到 ${filePaths.length} 個影片檔案，${videos.length} 個需要更新...`,
      progress: 0,
      filesFound: filePaths.length,
      processed: 0,
      currentFile: ''
    }, true);

    // 3. 寫入資料庫
    const { added: addedCount, updated: updatedCount } = await this._saveVideos(videos, (processed, video) => {
      progress({
        phase: 'processing',
        message: `正在處理影片... (${processed}/${videos.length})`,
        progress: (processed / videos.length) * 100,
        filesFound: filePaths.length,
        processed,
        currentFile: video.filename
      });
    });

    // 可選：清理已刪除的檔案記錄
    let cleanupCount = 0;
    if (cleanupMissing) {
      cleanupCount = await this._cleanupMissingFiles(folderPath, recursive, new Set(filePaths), existingByPath);
    }

    if (watchChanges) {
      this.watchFolder(folderPath, recursive);
    }

    console.log(`掃描完成 - 找到: ${filePaths.length}, 新增: ${addedCount}, 更新: ${updatedCount}, 未變更: ${unchangedCount}, 清理: ${cleanupCount}`);
    return {
      found: filePaths.length,
      added: addedCount,
      updated: updatedCount,
      unchanged: unchangedCount,
      cleaned: cleanupCount
    };
  }

  // 大小與修改時間都相同，視為內容未變（指紋本身不含 mtime，這裡只用來決定要不要重算）
  _isUnchanged(ref, stat) {
    return Boolean(
      ref && ref.fingerprint &&
      ref.file_mtime != null &&
      Number(ref.filesize) === stat.size &&
      Number(ref.file_mtime) === Math.floor(stat.mtimeMs)
    );
  }

  // 進度回報節流：一般事件最多每 PROGRESS_INTERVAL_MS 送一次，force 時立即送出
  _createProgressReporter(progressCallback) {
    if (!progressCallback) return () => {};
    let lastSent = 0;
    return (data, force = false) => {
      const now = Date.now();
      if (!force && now - lastSent < PROGRESS_INTERVAL_MS) return;
      lastSent = now;
      progressCallback(data);
    };
  }

  // 以佇列走訪目錄，整次掃描最多 DIR_CONCURRENCY 個 readdir 同時進行
  async _listVideoFiles(rootPath, recursive, onProgress) {
    const files = [];
    const queue = [rootPath];
    let active = 0;

    await new Promise((resolve) => {
      const pump = () => {
        if (queue.length === 0 && active === 0) {
          resolve();
          return;
        }
        while (active < DIR_CONCURRENCY && queue.length > 0) {
          const dirPath = queue.shift();
          active++;
          fs.readdir(dirPath, { withFileTypes: true })
            .then((entries) => {
              for (const entry of entries) {
                if (entry.isDirectory()) {
                  if (recursive) queue.push(path.join(dirPath, entry.name));
                } else if (entry.isFile() && this._isVideoFile(entry.name)) {
                  files.push(path.join(dirPath, entry.name));
                }
              }
              onProgress(dirPath, files.length);
            })
            .catch((error) => {
              console.error(`掃描資料夾錯誤: ${dirPath}`, error);
            })
            .finally(() => {
              active--;
              pump();
            });
        }
      };
      pump();
    });

    return files;
  }

  // 寫入影片記錄；資料庫有批次介面就用批次（SQLite 一個 transaction 寫一批）
  async _saveVideos(videos, onProgress) {
    let added = 0;
    let updated = 0;

    if (typeof this.database.addVideosBatch === 'function') {
      const result = await this.database.addVideosBatch(videos, (processed) => {
        onProgress(processed, videos[processed - 1]);
      });
      return { added: result.added, updated: result.updated };
    }

    let processed = 0;
    await this._runWithConcurrency(videos, FILE_CONCURRENCY, async (video) => {
      try {
        const result = await this.database.addVideo(video);
        if (result === 'updated') {
          updated++;
        } else {
          added++;
        }
      } catch (error) {
        console.error(`添加影片失敗: ${video.filepath}`, error);
      } finally {
        processed++;
        onProgress(processed, video);
      }
    });
    return { added, updated };
  }

  async _runWithConcurrency(items, limit, worker) {
    if (items.length === 0) return;
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        try {
          await worker(items[idx], idx);
        } catch (e) {
          // worker 內部應自行處理錯誤，這裡只是保險
          console.warn('worker error:', e && e.message);
        }
      }
    });
    await Promise.all(runners);
  }

  _isVideoFile(filename) {
    const ext = path.extname(filename).toLowerCase();

    // 檢查是否為未完成的下載檔案
    if (this._isIncompleteDownload(filename)) {
      return false;
    }

    return this.supportedFormats.includes(ext);
  }

  _isIncompleteDownload(filename) {
    const lowerFilename = filename.toLowerCase();

    // 檢查是否有未完成下載的副檔名
    for (const ext of this.incompleteDownloadExtensions) {
      if (lowerFilename.endsWith(ext)) {
        return true;
      }
    }

    // 檢查是否有複合副檔名（例如：video.mp4.part）
    // 提取倒數第二個副檔名
    const parts = filename.split('.');
    if (parts.length >= 3) {
      const secondToLastExt = '.' + parts[parts.length - 2].toLowerCase();
      if (this.supportedFormats.includes(secondToLastExt)) {
        const lastExt = '.' + parts[parts.length - 1].toLowerCase();
        if (this.incompleteDownloadExtensions.includes(lastExt)) {
          return true;
        }
      }
    }

    return false;
  }

  async _getVideoInfo(filepath, stat) {
    const filename = path.basename(filepath);
    const filesize = stat.size;

    // 獲取檔案建立時間，優先使用 birthtime，如果不可用則使用 mtime
    const file_created_at = stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.mtime;

    // 計算檔案指紋
    let fingerprint = null;
    try {
      fingerprint = await this.fileFingerprint.calculateFingerprint(filepath, stat);
    } catch (error) {
      console.warn(`計算檔案指紋失敗: ${filepath}`, error.message);
      // 繼續處理，但沒有指紋
    }

    return {
      filename,
      filepath,
      filesize,
      duration: null,
      description: '',
      fingerprint,
      file_created_at,
      // 只在指紋算成功時記錄 mtime，下次掃描才能據此略過
      file_mtime: fingerprint ? Math.floor(stat.mtimeMs) : null
    };
  }

  watchFolder(folderPath, recursive = true) {
    if (this.watchers.has(folderPath)) {
      console.log(`已經在監控資料夾: ${folderPath}`);
      return;
    }

    console.log(`開始監控資料夾: ${folderPath}`);

    const watcher = chokidar.watch(folderPath, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      depth: recursive ? undefined : 0,
      // 大檔案複製/下載中會先觸發 add，等大小穩定後再處理，避免對半個檔案算指紋
      awaitWriteFinish: {
        stabilityThreshold: 5000,
        pollInterval: 1000
      }
    });

    watcher
      .on('add', async (filepath) => {
        if (this._isVideoFile(filepath)) {
          try {
            const stat = await fs.stat(filepath);
            const videoInfo = await this._getVideoInfo(filepath, stat);
            await this.database.addVideo(videoInfo);
            console.log(`新增影片: ${filepath}`);
          } catch (error) {
            console.error(`處理新增影片錯誤: ${filepath}`, error);
          }
        }
      })
      .on('unlink', async (filepath) => {
        if (!this._isVideoFile(filepath)) return;
        try {
          const video = await this.database.getVideoByPath(filepath);
          if (video) {
            await this.database.deleteVideo(video.id);
            console.log(`刪除影片記錄: ${filepath}`);
          }
        } catch (error) {
          console.error(`處理刪除影片錯誤: ${filepath}`, error);
        }
      })
      .on('error', (error) => {
        console.error(`監控錯誤 ${folderPath}:`, error);
      });

    this.watchers.set(folderPath, watcher);
  }

  stopWatching(folderPath) {
    const watcher = this.watchers.get(folderPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(folderPath);
      console.log(`停止監控資料夾: ${folderPath}`);
    }
  }

  stopAllWatching() {
    for (const [folderPath, watcher] of this.watchers) {
      watcher.close();
      console.log(`停止監控資料夾: ${folderPath}`);
    }
    this.watchers.clear();
  }

  // 影片路徑是否在掃描範圍內（Windows 路徑不分大小寫；前綴需含分隔符，避免 D:\Videos 誤中 D:\Videos2）
  _isInScanScope(filepath, scanPath, recursive) {
    const normalize = (p) => {
      const trimmed = p.replace(/[\\/]+$/, '');
      return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
    };
    const root = normalize(scanPath);
    if (!recursive) {
      return normalize(path.dirname(filepath)) === root;
    }
    const target = normalize(filepath);
    return target.startsWith(root + '\\') || target.startsWith(root + '/');
  }

  // 清理資料庫中已不存在的檔案。
  // 本次掃描有列出的檔案一定存在，只需對「範圍內但沒被列出」的記錄確認是否真的不見了
  // （讀目錄失敗的子資料夾也會落在這裡，逐一確認可避免網路瞬斷時誤刪整批記錄）
  async _cleanupMissingFiles(scanPath, recursive, seenPaths, existingByPath) {
    try {
      const candidates = [];
      for (const ref of existingByPath.values()) {
        if (!seenPaths.has(ref.filepath) && this._isInScanScope(ref.filepath, scanPath, recursive)) {
          candidates.push(ref);
        }
      }

      const missingIds = [];
      await this._runWithConcurrency(candidates, FILE_CONCURRENCY, async (ref) => {
        try {
          if (!await fs.pathExists(ref.filepath)) {
            missingIds.push(ref.id);
            console.log(`清理已刪除的檔案記錄: ${ref.filepath}`);
          }
        } catch (error) {
          console.warn(`檢查檔案時發生錯誤: ${ref.filepath}`, error.message);
        }
      });

      if (missingIds.length === 0) return 0;

      if (typeof this.database.deleteVideosByIds === 'function') {
        await this.database.deleteVideosByIds(missingIds);
      } else {
        for (const id of missingIds) {
          await this.database.deleteVideo(id);
        }
      }
      return missingIds.length;
    } catch (error) {
      console.error('清理已刪除檔案時發生錯誤:', error);
      return 0;
    }
  }
}

module.exports = VideoScanner;
