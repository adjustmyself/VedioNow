const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const FileFingerprint = require('./fileFingerprint');

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
    const { recursive = true, watchChanges = false, cleanupMissing = false, progressCallback = null } = options;

    if (!await fs.pathExists(folderPath)) {
      throw new Error(`路徑不存在: ${folderPath}`);
    }

    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) {
      throw new Error(`路徑不是資料夾: ${folderPath}`);
    }

    console.log(`開始掃描資料夾: ${folderPath}`);

    if (progressCallback) {
      progressCallback({
        phase: 'scanning',
        message: '正在掃描資料夾...',
        progress: 0,
        filesFound: 0,
        currentFile: folderPath
      });
    }

    const videos = [];
    await this._scanDirectory(folderPath, videos, recursive, progressCallback);

    if (progressCallback) {
      progressCallback({
        phase: 'processing',
        message: `掃描完成，找到 ${videos.length} 個影片檔案，開始處理...`,
        progress: 0,
        filesFound: videos.length,
        processed: 0,
        currentFile: ''
      });
    }

    let addedCount = 0;
    let updatedCount = 0;

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      try {
        if (progressCallback) {
          progressCallback({
            phase: 'processing',
            message: `正在處理影片... (${i + 1}/${videos.length})`,
            progress: ((i + 1) / videos.length) * 100,
            filesFound: videos.length,
            processed: i + 1,
            currentFile: video.filename
          });
        }

        const result = await this.database.addVideo(video);
        if (result === 'updated') {
          updatedCount++;
        } else {
          addedCount++;
        }
      } catch (error) {
        console.error(`添加影片失敗: ${video.filepath}`, error);
      }
    }

    // 可選：清理已刪除的檔案記錄
    let cleanupCount = 0;
    if (cleanupMissing) {
      cleanupCount = await this._cleanupMissingFiles(folderPath, recursive);
    }

    if (watchChanges) {
      this.watchFolder(folderPath, recursive);
    }

    console.log(`掃描完成 - 找到: ${videos.length}, 新增: ${addedCount}, 更新: ${updatedCount}, 清理: ${cleanupCount}`);
    return {
      found: videos.length,
      added: addedCount,
      updated: updatedCount,
      cleaned: cleanupCount,
      videos
    };
  }

  async _scanDirectory(dirPath, videos, recursive, progressCallback = null) {
    try {
      const items = await fs.readdir(dirPath);

      for (const item of items) {
        const itemPath = path.join(dirPath, item);

        try {
          const stat = await fs.stat(itemPath);

          if (stat.isDirectory() && recursive) {
            if (progressCallback) {
              progressCallback({
                phase: 'scanning',
                message: '正在掃描資料夾...',
                progress: 0,
                filesFound: videos.length,
                currentFile: itemPath
              });
            }
            await this._scanDirectory(itemPath, videos, recursive, progressCallback);
          } else if (stat.isFile() && this._isVideoFile(item)) {
            const videoInfo = await this._getVideoInfo(itemPath, stat);
            videos.push(videoInfo);

            if (progressCallback) {
              progressCallback({
                phase: 'scanning',
                message: `找到影片檔案... (已找到 ${videos.length} 個)`,
                progress: 0,
                filesFound: videos.length,
                currentFile: item
              });
            }
          }
        } catch (error) {
          console.warn(`無法讀取項目: ${itemPath}`, error.message);
        }
      }
    } catch (error) {
      console.error(`掃描資料夾錯誤: ${dirPath}`, error);
    }
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
      file_created_at
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
      depth: recursive ? undefined : 0
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
        try {
          const videos = await this.database.getVideos({ filepath });
          if (videos.length > 0) {
            await this.database.deleteVideo(videos[0].id);
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

  isNetworkPath(filepath) {
    return filepath.startsWith('\\\\') ||
           filepath.startsWith('//') ||
           !/^[a-zA-Z]:\\/.test(filepath);
  }

  async verifyNetworkPath(filepath) {
    try {
      await fs.access(filepath);
      return true;
    } catch (error) {
      console.warn(`網路路徑無法存取: ${filepath}`, error.message);
      return false;
    }
  }

  async scanNetworkPath(networkPath, options = {}) {
    if (!this.isNetworkPath(networkPath)) {
      throw new Error('提供的不是網路路徑');
    }

    const isAccessible = await this.verifyNetworkPath(networkPath);
    if (!isAccessible) {
      throw new Error(`無法存取網路路徑: ${networkPath}`);
    }

    return await this.scanFolder(networkPath, {
      ...options,
      watchChanges: false
    });
  }

  async _cleanupMissingFiles(scanPath, recursive) {
    try {
      // 獲取資料庫中所有在掃描路徑下的影片
      const allVideos = await this.database.getVideos();
      const pathVideos = allVideos.filter(video => {
        if (recursive) {
          return video.filepath.startsWith(scanPath);
        } else {
          return path.dirname(video.filepath) === scanPath;
        }
      });

      let cleanupCount = 0;
      for (const video of pathVideos) {
        try {
          // 檢查檔案是否還存在
          const exists = await fs.pathExists(video.filepath);
          if (!exists) {
            await this.database.deleteVideo(video.id);
            console.log(`清理已刪除的檔案記錄: ${video.filepath}`);
            cleanupCount++;
          }
        } catch (error) {
          console.warn(`檢查檔案時發生錯誤: ${video.filepath}`, error.message);
        }
      }

      return cleanupCount;
    } catch (error) {
      console.error('清理已刪除檔案時發生錯誤:', error);
      return 0;
    }
  }
}

module.exports = VideoScanner;