const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');

class ThumbnailGenerator {
  constructor() {
    this.thumbnailSubfolder = '.video_thumbnails';
  }

  // 產生縮圖路徑
  getThumbnailPath(videoPath) {
    const videoDir = path.dirname(videoPath);
    const videoName = path.basename(videoPath, path.extname(videoPath));
    const thumbnailDir = path.join(videoDir, this.thumbnailSubfolder);
    return path.join(thumbnailDir, `${videoName}.jpg`);
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

  // 清理過期縮圖 (影片檔案不存在時)
  async cleanupThumbnails(videoDir) {
    const thumbnailDir = path.join(videoDir, this.thumbnailSubfolder);

    try {
      const thumbnailFiles = await fs.readdir(thumbnailDir);

      for (const thumbnailFile of thumbnailFiles) {
        const videoName = path.basename(thumbnailFile, '.jpg');

        // 檢查常見的影片副檔名
        const videoExtensions = ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.ogv', '.ogg', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts'];

        let videoExists = false;
        for (const ext of videoExtensions) {
          const videoPath = path.join(videoDir, videoName + ext);
          if (await fs.pathExists(videoPath)) {
            videoExists = true;
            break;
          }
        }

        // 如果對應的影片檔案不存在，刪除縮圖
        if (!videoExists) {
          const thumbnailPath = path.join(thumbnailDir, thumbnailFile);
          await fs.remove(thumbnailPath);
          console.log('已清理過期縮圖:', thumbnailPath);
        }
      }

      // 如果縮圖資料夾空了，刪除它
      const remainingFiles = await fs.readdir(thumbnailDir);
      if (remainingFiles.length === 0) {
        await fs.remove(thumbnailDir);
      }
    } catch (error) {
      // 縮圖目錄不存在是正常的
      if (error.code !== 'ENOENT') {
        console.error('清理縮圖時發生錯誤:', error);
      }
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
}

module.exports = ThumbnailGenerator;