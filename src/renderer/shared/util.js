// 主視窗與標籤管理視窗共用的小工具
const { pathToFileURL } = require('url');

// HTML escape，避免 filename / tag name 中的 <、>、" 等字元破壞畫面或造成 XSS
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 本機 / UNC 路徑轉成 file:// URL（直接串 "file://" + 路徑遇到 # % ? 空白會壞掉）
function toFileUrl(filePath, version) {
  const href = pathToFileURL(filePath).href;
  return version ? `${href}?t=${version}` : href;
}

// 標籤圖片：資料庫只存檔名（相容舊版存的絕對路徑），組成 userData 下的 file:// URL
function toTagImageUrl(value, tagImagesDir) {
  if (!value) return '';
  const isAbsolute = /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
  return toFileUrl(isAbsolute ? value : require('path').join(tagImagesDir, value));
}

// 連續觸發時只在停止 wait 毫秒後執行最後一次
function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

module.exports = { escapeHtml, toFileUrl, toTagImageUrl, debounce };
