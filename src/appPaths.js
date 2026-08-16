const path = require('path');

// 使用者資料（設定、資料庫、縮圖、標籤圖片）一律存在 Electron 的 userData：
// 舊版存在程式目錄旁的 data/，重新 package 會被整個覆蓋，使用者設定與快取全部消失。
const LEGACY_DATA_DIR = path.join(__dirname, '../data');

let cachedUserDataDir;

function getUserDataDir() {
  if (cachedUserDataDir) return cachedUserDataDir;

  try {
    const electron = require('electron');

    // 主行程
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      cachedUserDataDir = electron.app.getPath('userData');
      return cachedUserDataDir;
    }

    // 算圖用的 ThumbnailGenerator 也會在 renderer 建立，但 renderer 沒有 app。
    // 向主行程同步詢問一次即可（結果會快取，不會每張縮圖都阻塞）。
    if (electron && electron.ipcRenderer) {
      const dir = electron.ipcRenderer.sendSync('get-user-data-dir-sync');
      if (dir) {
        cachedUserDataDir = dir;
        return cachedUserDataDir;
      }
    }
  } catch (error) {
    // 測試與 CLI 腳本以純 Node 執行（ELECTRON_RUN_AS_NODE），沒有 electron 模組，
    // 往下走 fallback
  }

  cachedUserDataDir = LEGACY_DATA_DIR;
  return cachedUserDataDir;
}

module.exports = { getUserDataDir, LEGACY_DATA_DIR };
