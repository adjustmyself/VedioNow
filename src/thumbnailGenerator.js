const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const crypto = require('crypto');

class ThumbnailGenerator {
  constructor() {
    // 縮圖將儲存在本地快取目錄中，避免網路磁碟權限問題
    this.thumbnailsDir = path.join(__dirname, '../data/thumbnails');
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
        // 標準化路徑：將反斜線轉為正斜線（FFmpeg 在 Windows 上兩者都支援）
        // 這樣可以避免路徑中的反斜線轉義問題
        const normalizedVideoPath = videoPath.replace(/\\/g, '/');
        const normalizedThumbnailPath = thumbnailPath.replace(/\\/g, '/');

        // 針對不同格式調整 FFmpeg 參數
        const extension = videoPath.toLowerCase().split('.').pop();
        let ffmpegArgs = [];

        // AVI 格式需要先解析再擷取
        if (extension === 'avi') {
          ffmpegArgs = [
            '-ss', offset.toString(),
            '-i', normalizedVideoPath,
            '-vframes', '1',
            '-q:v', '2',
            '-f', 'image2',
            '-update', '1',
            '-y', normalizedThumbnailPath
          ];
        } else {
          ffmpegArgs = [
            '-i', normalizedVideoPath,
            '-ss', offset.toString(),
            '-vframes', '1',
            '-q:v', '2',
            '-f', 'image2',
            '-update', '1',
            '-y', normalizedThumbnailPath
          ];
        }

        console.log('===== FFmpeg 縮圖生成 =====');
        console.log('原始影片路徑:', videoPath);
        console.log('標準化路徑:', normalizedVideoPath);
        console.log('縮圖路徑:', normalizedThumbnailPath);
        console.log('完整命令:', 'ffmpeg ' + ffmpegArgs.map(arg =>
          arg.includes(' ') || arg.includes('(') || arg.includes(')') ? `"${arg}"` : arg
        ).join(' '));

        const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
          windowsVerbatimArguments: false,
          shell: false
        });

        let stderrOutput = '';

        ffmpeg.stderr.on('data', (data) => {
          const output = data.toString();
          stderrOutput += output;
          // 只記錄關鍵錯誤信息
          if (output.includes('Error') || output.includes('Invalid') || output.includes('No such file')) {
            console.error('FFmpeg 錯誤:', output);
          }
        });

        ffmpeg.on('close', (code) => {
          console.log(`FFmpeg 退出碼: ${code} (時間點: ${offset}s)`);
          if (code === 0) {
            console.log('✓ 縮圖生成成功');
            resolve(thumbnailPath);
          } else {
            console.error(`✗ FFmpeg 失敗 (退出碼: ${code})`);
            if (stderrOutput) {
              console.error('完整錯誤輸出:', stderrOutput.substring(stderrOutput.length - 500)); // 只顯示最後500字
            }
            if (currentOffsetIndex < timeOffsets.length - 1) {
              currentOffsetIndex++;
              console.log(`嘗試下一個時間點: ${timeOffsets[currentOffsetIndex]}s`);
              tryGenerateThumbnail(timeOffsets[currentOffsetIndex]);
            } else {
              reject(new Error(`FFmpeg failed for all time offsets, last exit code: ${code}\nLast error: ${stderrOutput.substring(stderrOutput.length - 200)}`));
            }
          }
        });

        ffmpeg.on('error', (error) => {
          console.error('FFmpeg 執行錯誤 (spawn failed):', error.message);
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
    await fs.ensureDir(this.thumbnailsDir);

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

      let cleanupCount = 0;

      // 檢查本地縮圖目錄
      if (!await fs.pathExists(this.thumbnailsDir)) {
        return;
      }

      try {
        const thumbnailFiles = await fs.readdir(this.thumbnailsDir);

        for (const thumbnailFile of thumbnailFiles) {
          // 只處理jpg檔案
          if (path.extname(thumbnailFile).toLowerCase() === '.jpg') {
            const fileHash = path.basename(thumbnailFile, '.jpg');

            // 如果這個hash不在有效列表中，就刪除縮圖
            if (!validHashes.has(fileHash)) {
              const thumbnailPath = path.join(this.thumbnailsDir, thumbnailFile);
              await fs.remove(thumbnailPath);
              console.log('已清理過期縮圖:', thumbnailPath);
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

  // 新增方法：獲取縮圖統計資訊
  async getThumbnailStats() {
    try {
      let totalCount = 0;
      let totalSize = 0;

      // 檢查本地縮圖目錄
      if (!await fs.pathExists(this.thumbnailsDir)) {
        return { total: 0, size: 0 };
      }

      try {
        const thumbnailFiles = await fs.readdir(this.thumbnailsDir);
        const jpgFiles = thumbnailFiles.filter(file => path.extname(file).toLowerCase() === '.jpg');

        totalCount = jpgFiles.length;

        for (const file of jpgFiles) {
          const filePath = path.join(this.thumbnailsDir, file);
          try {
            const stats = await fs.stat(filePath);
            totalSize += stats.size;
          } catch (error) {
            console.warn(`無法獲取檔案統計: ${filePath}`, error.message);
          }
        }
      } catch (error) {
        console.warn(`無法讀取縮圖目錄: ${this.thumbnailsDir}`, error.message);
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

  // 遷移舊的縮圖（現在所有縮圖都在本地目錄，無需遷移）
  async migrateThumbnails(videoPaths = []) {
    try {
      // 確保本地縮圖目錄存在
      await fs.ensureDir(this.thumbnailsDir);

      console.log('縮圖已統一存儲在本地目錄，無需遷移');
      return { migrated: 0, errors: 0 };

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