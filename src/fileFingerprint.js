const fs = require('fs-extra');
const crypto = require('crypto');

class FileFingerprint {
  constructor() {
    this.CHUNK_SIZE = 64 * 1024; // 64KB
  }

  /**
   * 計算檔案指紋
   * @param {string} filepath - 檔案路徑
   * @param {fs.Stats} stat - 檔案統計資訊（可選，如果提供可節省一次 stat 調用）
   * @returns {Promise<string>} 檔案指紋
   */
  async calculateFingerprint(filepath, stat = null) {
    try {
      // 獲取檔案統計資訊
      if (!stat) {
        stat = await fs.stat(filepath);
      }

      const hash = crypto.createHash('md5');

      // 添加檔案大小
      hash.update(stat.size.toString());

      // 添加修改時間
      hash.update(stat.mtime.getTime().toString());

      // 讀取檔案前64KB內容
      try {
        const readStream = fs.createReadStream(filepath, {
          start: 0,
          end: Math.min(this.CHUNK_SIZE - 1, stat.size - 1)
        });

        for await (const chunk of readStream) {
          hash.update(chunk);
        }
      } catch (readError) {
        console.warn('讀取檔案內容時發生錯誤:', readError.message);
        // 繼續處理，僅使用檔案大小和時間戳
      }

      const fingerprint = hash.digest('hex');
      console.log(`計算檔案指紋: ${filepath.substring(filepath.lastIndexOf('/') + 1)} -> ${fingerprint.substring(0, 8)}...`);

      return fingerprint;
    } catch (error) {
      console.error(`計算檔案指紋失敗: ${filepath}`, error);
      // 回退方案：使用檔案路徑 + 大小 + 時間
      const fallbackHash = crypto.createHash('md5');
      fallbackHash.update(filepath);
      if (stat) {
        fallbackHash.update(stat.size.toString());
        fallbackHash.update(stat.mtime.getTime().toString());
      }
      return fallbackHash.digest('hex');
    }
  }

  /**
   * 批量計算指紋
   * @param {Array<{filepath: string, stat?: fs.Stats}>} files
   * @returns {Promise<Array<{filepath: string, fingerprint: string}>>}
   */
  async calculateBatchFingerprints(files) {
    const results = [];

    for (const file of files) {
      try {
        const fingerprint = await this.calculateFingerprint(file.filepath, file.stat);
        results.push({
          filepath: file.filepath,
          fingerprint
        });
      } catch (error) {
        console.error(`批量計算指紋失敗: ${file.filepath}`, error);
        // 繼續處理其他檔案
      }
    }

    return results;
  }

  /**
   * 驗證檔案是否匹配指紋
   * @param {string} filepath
   * @param {string} expectedFingerprint
   * @returns {Promise<boolean>}
   */
  async verifyFingerprint(filepath, expectedFingerprint) {
    try {
      const actualFingerprint = await this.calculateFingerprint(filepath);
      return actualFingerprint === expectedFingerprint;
    } catch (error) {
      console.error(`驗證指紋失敗: ${filepath}`, error);
      return false;
    }
  }
}

module.exports = FileFingerprint;