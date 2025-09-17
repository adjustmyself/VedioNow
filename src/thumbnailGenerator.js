const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const crypto = require('crypto');

class ThumbnailGenerator {
  constructor() {
    // 縮圖將儲存在影片所在資料夾的 .thumbnails 子目錄中
    // 這樣可以讓多個用戶共享縮圖
  }

  // 生成檔案路徑的唯一hash值
  generateFileHash(videoPath) {
    // 使用MD5生成檔案路徑的hash，作為縮圖的唯一key
    const normalizedPath = path.normalize(videoPath).toLowerCase();
    return crypto.createHash('md5').update(normalizedPath).digest('hex');
  }

  // 產生縮圖路徑 (在影片所在資料夾的 .thumbnails 子目錄中)
  getThumbnailPath(videoPath) {
    const videoDir = path.dirname(videoPath);
    const thumbnailDir = path.join(videoDir, '.thumbnails');
    const fileHash = this.generateFileHash(videoPath);
    return path.join(thumbnailDir, `${fileHash}.jpg`);
  }

  // 獲取縮圖目錄路徑
  getThumbnailDir(videoPath) {
    const videoDir = path.dirname(videoPath);
    return path.join(videoDir, '.thumbnails');
  }

  // 檢查縮圖是否存在
  async thumbnailExists(videoPath) {
    const thumbnailPath = this.getThumbnailPath(videoPath);
    try {
      await fs.access(thumbnailPath);
      return thumbnailPath;
    } catch {
      return null;
    }
  }

  // 使用 FFmpeg 生成縮圖 (如果系統有安裝)
  async generateWithFFmpeg(videoPath, thumbnailPath, timeOffset = 30) {
    return new Promise((resolve, reject) => {
      // 嘗試多個時間點，避免黑幀
      const timeOffsets = [30, 60, 90, 120, 15, 5];
      let currentOffsetIndex = 0;

      const tryGenerateThumbnail = (offset) => {
        // 針對不同格式調整 FFmpeg 參數
        const extension = videoPath.toLowerCase().split('.').pop();
        let ffmpegArgs = [
          '-i', videoPath,
          '-ss', offset.toString(),
          '-vframes', '1',
          '-q:v', '2'
        ];

        // 針對 TS 格式添加特殊處理
        if (['ts', 'mts', 'm2ts'].includes(extension)) {
          ffmpegArgs.push('-f', 'image2');
        } else {
          ffmpegArgs.push('-f', 'mjpeg');
        }

        ffmpegArgs.push('-y', thumbnailPath);

        console.log('FFmpeg 命令:', 'ffmpeg', ffmpegArgs.join(' '));

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

        ffmpeg.stderr.on('data', (data) => {
          // 記錄 FFmpeg 錯誤輸出，但不中斷處理
          console.log('FFmpeg stderr:', data.toString());
        });

        ffmpeg.on('close', (code) => {
          console.log(`FFmpeg 退出碼: ${code} (時間點: ${offset}s)`);
          if (code === 0) {
            resolve(thumbnailPath);
          } else if (currentOffsetIndex < timeOffsets.length - 1) {
            currentOffsetIndex++;
            tryGenerateThumbnail(timeOffsets[currentOffsetIndex]);
          } else {
            reject(new Error(`FFmpeg failed for all time offsets, last exit code: ${code}`));
          }
        });

        ffmpeg.on('error', (error) => {
          console.error('FFmpeg 執行錯誤:', error.message);
          if (currentOffsetIndex < timeOffsets.length - 1) {
            currentOffsetIndex++;
            tryGenerateThumbnail(timeOffsets[currentOffsetIndex]);
          } else {
            reject(error);
          }
        });
      };

      tryGenerateThumbnail(timeOffsets[currentOffsetIndex]);
    });
  }

  // 使用 Canvas 從 video 元素生成縮圖
  async generateWithCanvas(videoElement, thumbnailPath) {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        canvas.width = 320;
        canvas.height = 180;

        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

        canvas.toBlob((blob) => {
          if (blob) {
            const reader = new FileReader();
            reader.onload = async () => {
              try {
                const buffer = Buffer.from(reader.result);
                await fs.ensureDir(path.dirname(thumbnailPath));
                await fs.writeFile(thumbnailPath, buffer);
                resolve(thumbnailPath);
              } catch (error) {
                reject(error);
              }
            };
            reader.readAsArrayBuffer(blob);
          } else {
            reject(new Error('Failed to create blob'));
          }
        }, 'image/jpeg', 0.8);
      } catch (error) {
        reject(error);
      }
    });
  }

  // 主要生成縮圖方法
  async generateThumbnail(videoPath) {
    // 先檢查縮圖是否已存在
    const existingThumbnail = await this.thumbnailExists(videoPath);
    if (existingThumbnail) {
      return existingThumbnail;
    }

    const thumbnailPath = this.getThumbnailPath(videoPath);

    // 確保縮圖目錄存在
    await fs.ensureDir(path.dirname(thumbnailPath));

    // 嘗試使用 FFmpeg
    try {
      return await this.generateWithFFmpeg(videoPath, thumbnailPath);
    } catch (ffmpegError) {
      console.warn('FFmpeg 生成縮圖失敗，將使用瀏覽器方法:', ffmpegError.message);
      // FFmpeg 失敗時返回 null，讓前端處理
      return null;
    }
  }

  // 清理過期縮圖 (根據有效的影片路徑列表)
  async cleanupThumbnails(validVideoPaths = []) {
    try {
      // 生成所有有效影片的hash值
      const validHashes = new Set(validVideoPaths.map(videoPath => this.generateFileHash(videoPath)));

      // 取得所有有影片的資料夾路徑
      const videoDirs = new Set(validVideoPaths.map(videoPath => path.dirname(videoPath)));

      let cleanupCount = 0;

      // 遍歷每個資料夾的 .thumbnails 目錄
      for (const videoDir of videoDirs) {
        const thumbnailDir = path.join(videoDir, '.thumbnails');

        if (!await fs.pathExists(thumbnailDir)) {
          continue;
        }

        try {
          const thumbnailFiles = await fs.readdir(thumbnailDir);

          for (const thumbnailFile of thumbnailFiles) {
            // 只處理jpg檔案
            if (path.extname(thumbnailFile).toLowerCase() === '.jpg') {
              const fileHash = path.basename(thumbnailFile, '.jpg');

              // 如果這個hash不在有效列表中，就刪除縮圖
              if (!validHashes.has(fileHash)) {
                const thumbnailPath = path.join(thumbnailDir, thumbnailFile);
                await fs.remove(thumbnailPath);
                console.log('已清理過期縮圖:', thumbnailPath);
                cleanupCount++;
              }
            }
          }

          // 檢查目錄是否為空，如果是則刪除 .thumbnails 目錄
          const remainingFiles = await fs.readdir(thumbnailDir);
          if (remainingFiles.length === 0) {
            await fs.remove(thumbnailDir);
            console.log('已刪除空的縮圖目錄:', thumbnailDir);
          }
        } catch (error) {
          console.warn(`清理縮圖目錄失敗 ${thumbnailDir}:`, error.message);
        }
      }

      if (cleanupCount > 0) {
        console.log(`縮圖清理完成，共刪除 ${cleanupCount} 個過期縮圖`);
      }
    } catch (error) {
      console.error('清理縮圖時發生錯誤:', error);
    }
  }

  // 新增方法：獲取縮圖統計資訊 (需要提供影片路徑列表來計算)
  async getThumbnailStats(videoPaths = []) {
    try {
      // 取得所有有影片的資料夾路徑
      const videoDirs = new Set(videoPaths.map(videoPath => path.dirname(videoPath)));

      let totalCount = 0;
      let totalSize = 0;

      // 遍歷每個資料夾的 .thumbnails 目錄
      for (const videoDir of videoDirs) {
        const thumbnailDir = path.join(videoDir, '.thumbnails');

        if (!await fs.pathExists(thumbnailDir)) {
          continue;
        }

        try {
          const thumbnailFiles = await fs.readdir(thumbnailDir);
          const jpgFiles = thumbnailFiles.filter(file => path.extname(file).toLowerCase() === '.jpg');

          totalCount += jpgFiles.length;

          for (const file of jpgFiles) {
            const filePath = path.join(thumbnailDir, file);
            try {
              const stats = await fs.stat(filePath);
              totalSize += stats.size;
            } catch (error) {
              console.warn(`無法獲取檔案統計: ${filePath}`, error.message);
            }
          }
        } catch (error) {
          console.warn(`無法讀取縮圖目錄: ${thumbnailDir}`, error.message);
        }
      }

      return {
        total: totalCount,
        size: totalSize
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

    // 使用 Canvas 生成縮圖
    try {
      return await this.generateWithCanvas(videoElement, thumbnailPath);
    } catch (error) {
      console.error('生成縮圖失敗:', error);
      return null;
    }
  }

  // 遷移舊的縮圖從統一目錄到各自資料夾 (一次性執行)
  async migrateThumbnails(videoPaths = []) {
    try {
      const oldThumbnailDir = path.join(__dirname, '../data/thumbnails');

      if (!await fs.pathExists(oldThumbnailDir)) {
        console.log('沒有找到舊的縮圖目錄，無需遷移');
        return { migrated: 0, errors: 0 };
      }

      const oldThumbnailFiles = await fs.readdir(oldThumbnailDir);
      const jpgFiles = oldThumbnailFiles.filter(file => path.extname(file).toLowerCase() === '.jpg');

      let migratedCount = 0;
      let errorCount = 0;

      console.log(`開始遷移 ${jpgFiles.length} 個縮圖檔案...`);

      for (const thumbnailFile of jpgFiles) {
        const fileHash = path.basename(thumbnailFile, '.jpg');
        const oldThumbnailPath = path.join(oldThumbnailDir, thumbnailFile);

        // 尋找對應的影片檔案
        const matchingVideo = videoPaths.find(videoPath =>
          this.generateFileHash(videoPath) === fileHash
        );

        if (matchingVideo) {
          try {
            const newThumbnailPath = this.getThumbnailPath(matchingVideo);
            const newThumbnailDir = path.dirname(newThumbnailPath);

            // 確保新目錄存在
            await fs.ensureDir(newThumbnailDir);

            // 移動檔案
            await fs.move(oldThumbnailPath, newThumbnailPath, { overwrite: false });
            console.log(`已遷移縮圖: ${thumbnailFile} -> ${newThumbnailPath}`);
            migratedCount++;
          } catch (error) {
            console.error(`遷移縮圖失敗 ${thumbnailFile}:`, error.message);
            errorCount++;
          }
        } else {
          // 沒有對應的影片，刪除過期縮圖
          try {
            await fs.remove(oldThumbnailPath);
            console.log(`已刪除過期縮圖: ${thumbnailFile}`);
          } catch (error) {
            console.warn(`刪除過期縮圖失敗 ${thumbnailFile}:`, error.message);
          }
        }
      }

      // 檢查舊目錄是否為空，如果是則刪除
      try {
        const remainingFiles = await fs.readdir(oldThumbnailDir);
        if (remainingFiles.length === 0) {
          await fs.remove(oldThumbnailDir);
          console.log('已刪除空的舊縮圖目錄');
        }
      } catch (error) {
        console.warn('無法刪除舊縮圖目錄:', error.message);
      }

      console.log(`縮圖遷移完成：已遷移 ${migratedCount} 個檔案，${errorCount} 個錯誤`);
      return { migrated: migratedCount, errors: errorCount };
    } catch (error) {
      console.error('縮圖遷移失敗:', error);
      return { migrated: 0, errors: 1 };
    }
  }
}

module.exports = ThumbnailGenerator;