const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');

class VideoScanner {
  constructor(database) {
    this.database = database;
    this.supportedFormats = [
      '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v',
      '.3gp', '.ogv', '.ogg', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts'
    ];
    this.watchers = new Map();
  }

  async scanFolder(folderPath, options = {}) {
    const { recursive = true, watchChanges = false } = options;

    if (!await fs.pathExists(folderPath)) {
      throw new Error(`路徑不存在: ${folderPath}`);
    }

    const stat = await fs.stat(folderPath);
    if (!stat.isDirectory()) {
      throw new Error(`路徑不是資料夾: ${folderPath}`);
    }

    console.log(`開始掃描資料夾: ${folderPath}`);

    const videos = [];
    await this._scanDirectory(folderPath, videos, recursive);

    for (const video of videos) {
      try {
        await this.database.addVideo(video);
      } catch (error) {
        console.error(`添加影片失敗: ${video.filepath}`, error);
      }
    }

    if (watchChanges) {
      this.watchFolder(folderPath, recursive);
    }

    console.log(`掃描完成，找到 ${videos.length} 個影片檔案`);
    return videos;
  }

  async _scanDirectory(dirPath, videos, recursive) {
    try {
      const items = await fs.readdir(dirPath);

      for (const item of items) {
        const itemPath = path.join(dirPath, item);

        try {
          const stat = await fs.stat(itemPath);

          if (stat.isDirectory() && recursive) {
            await this._scanDirectory(itemPath, videos, recursive);
          } else if (stat.isFile() && this._isVideoFile(item)) {
            const videoInfo = await this._getVideoInfo(itemPath, stat);
            videos.push(videoInfo);
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
    return this.supportedFormats.includes(ext);
  }

  async _getVideoInfo(filepath, stat) {
    const filename = path.basename(filepath);
    const filesize = stat.size;

    return {
      filename,
      filepath,
      filesize,
      duration: null,
      description: ''
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
}

module.exports = VideoScanner;