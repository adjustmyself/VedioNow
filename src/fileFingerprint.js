const fs = require('fs-extra');
const crypto = require('crypto');

class FileFingerprint {
  constructor() {
    this.CHUNK_SIZE = 64 * 1024; // 64KB
  }

  /**
   * 讀取檔案指定區段並餵入 hash
   * @param {crypto.Hash} hash
   * @param {string} filepath
   * @param {number} start - 起始位元組（含）
   * @param {number} end - 結束位元組（含）
   */
  async _hashFileRange(hash, filepath, start, end) {
    const readStream = fs.createReadStream(filepath, { start, end });
    for await (const chunk of readStream) {
      hash.update(chunk);
    }
  }

  /**
   * 計算檔案指紋（v2）
   *
   * 組成：檔案大小 + 檔頭 64KB + 檔尾 64KB 的 MD5。
   * 刻意不包含 mtime：mtime 會因檔案搬移、NAS 同步工具、系統操作而改變，
   * 內容沒變指紋卻變了，會導致 video_tag_relations 變成孤兒、標籤全部消失。
   * 加入檔尾 64KB 是為了區分檔頭相同的系列影片（同片頭的多集影片）。
   *
   * @param {string} filepath - 檔案路徑
   * @param {fs.Stats} stat - 檔案統計資訊（可選，如果提供可節省一次 stat 調用）
   * @returns {Promise<string>} 檔案指紋
   */
  async calculateFingerprint(filepath, stat = null) {
    try {
      if (!stat) {
        stat = await fs.stat(filepath);
      }

      const hash = crypto.createHash('md5');
      hash.update(stat.size.toString());

      try {
        // 檔頭 64KB
        const headEnd = Math.min(this.CHUNK_SIZE - 1, stat.size - 1);
        if (stat.size > 0) {
          await this._hashFileRange(hash, filepath, 0, headEnd);
        }

        // 檔尾 64KB（與檔頭不重疊時才讀）
        const tailStart = stat.size - this.CHUNK_SIZE;
        if (tailStart > headEnd) {
          await this._hashFileRange(hash, filepath, tailStart, stat.size - 1);
        }
      } catch (readError) {
        console.warn('讀取檔案內容時發生錯誤:', readError.message);
        // 繼續處理，僅使用檔案大小
      }

      return hash.digest('hex');
    } catch (error) {
      console.error(`計算檔案指紋失敗: ${filepath}`, error);
      // 回退方案：使用檔案路徑 + 大小（同樣不含 mtime，維持穩定性）
      const fallbackHash = crypto.createHash('md5');
      fallbackHash.update(filepath);
      if (stat) {
        fallbackHash.update(stat.size.toString());
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
