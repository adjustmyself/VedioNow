// 主視窗、設定與標籤管理視窗共用的小工具（ES module；畫面端沒有 Node 可用）

// HTML escape，避免 filename / tag name 中的 <、>、" 等字元破壞畫面或造成 XSS
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 本機 / UNC 路徑轉成 file:// URL（直接串 "file://" + 路徑遇到 # % ? 空白會壞掉）。
// 與 Node 的 url.pathToFileURL 結果等價：每段路徑各自編碼、保留磁碟代號的冒號，
// UNC 路徑（\\server\share\...）轉成 file://server/share/...
export function toFileUrl(filePath, version) {
  const normalized = String(filePath).replace(/\\/g, '/');
  let prefix = 'file://';
  let rest = normalized;
  if (normalized.startsWith('//')) {
    rest = normalized.slice(2);
  } else if (/^[a-zA-Z]:(\/|$)/.test(normalized)) {
    prefix = 'file:///';
  }
  const encoded = rest
    .split('/')
    .map((segment, i) => (i === 0 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
  const href = prefix + encoded;
  return version ? `${href}?t=${version}` : href;
}

// 資料夾與檔名串成路徑，沿用資料夾原本的分隔符
function joinPath(dir, name) {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

// 標籤圖片：資料庫只存檔名（相容舊版存的絕對路徑），組成 userData 下的 file:// URL
export function toTagImageUrl(value, tagImagesDir) {
  if (!value) return '';
  const isAbsolute = /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
  return toFileUrl(isAbsolute ? value : joinPath(tagImagesDir, value));
}

// 連續觸發時只在停止 wait 毫秒後執行最後一次
export function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}
