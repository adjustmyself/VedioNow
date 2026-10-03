// 所有視窗共用的 preload：畫面端只能透過 window.api 呼叫白名單內的 IPC，拿不到 Node 與完整的 ipcRenderer。
// 新增 IPC 頻道時必須加進下面的清單，否則畫面端呼叫會直接被拒絕。
// （sandbox 模式下 preload 只能 require('electron')，清單不能拆到別的檔案）
const { contextBridge, ipcRenderer } = require('electron');

// 畫面端 → 主行程（ipcMain.handle）
const INVOKE_CHANNELS = new Set([
  // 影片清單與搜尋
  'search-videos', 'get-filtered-tag-counts', 'get-drive-paths', 'get-duplicate-summary', 'get-duplicate-videos',
  'get-matching-video-refs', 'get-config',
  // 單部影片
  'add-video-tag', 'remove-video-tag', 'set-video-metadata', 'update-video', 'delete-video', 'delete-video-with-file',
  'show-delete-confirmation', 'open-path', 'upload-subtitle', 'set-video-duration', 'copy-to-clipboard',
  // 批次操作
  'batch-add-tag', 'batch-remove-tag', 'batch-set-rating', 'batch-delete-records',
  // 縮圖與預覽
  'check-thumbnail', 'check-thumbnails-batch', 'get-thumbnail', 'generate-thumbnail-force', 'save-renderer-thumbnail',
  'get-preview', 'cleanup-thumbnails', 'get-thumbnail-stats', 'backfill-durations',
  // 合集
  'create-collection', 'remove-collection', 'get-collection', 'get-folder-videos',
  // 標籤
  'get-tags-by-group', 'get-all-tag-groups', 'create-tag', 'update-tag', 'delete-tag', 'reorder-tags',
  'create-tag-group', 'update-tag-group', 'delete-tag-group', 'get-tag-images-dir', 'pick-tag-image',
  'cleanup-orphan-tag-relations',
  // 掃描與監看
  'select-folder', 'scan-videos', 'get-recent-scan-paths', 'remove-recent-scan-path', 'get-watched-folders',
  'remove-watched-folder',
  // 儲存的搜尋、自動標籤
  'get-saved-searches', 'save-search', 'delete-saved-search',
  'get-auto-tag-rules', 'save-auto-tag-rules', 'preview-auto-tag-rules', 'apply-auto-tag-rules',
  // 視窗與設定
  'open-settings', 'open-tag-manager', 'save-config', 'reset-config', 'restart-app',
  'test-mongodb-connection', 'migrate-mongodb-to-sqlite',
  // 備份與還原
  'get-backup-info', 'create-backup', 'open-backup-dir', 'choose-restore-backup', 'restore-backup'
]);

// 畫面端 → 主行程（ipcMain.on，不需回應）
const SEND_CHANNELS = new Set(['renderer-ready']);

// 主行程 → 畫面端
const EVENT_CHANNELS = new Set([
  'scan-progress', 'background-scan-status', 'duration-backfill-progress',
  'videos-changed', 'tags-changed', 'database-changed', 'page-size-changed', 'theme-changed',
  'splash-status', 'splash-finish'
]);

function assertAllowed(set, channel) {
  if (!set.has(channel)) throw new Error(`IPC 頻道不在白名單內: ${channel}`);
}

const api = {
  invoke(channel, ...args) {
    assertAllowed(INVOKE_CHANNELS, channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    assertAllowed(SEND_CHANNELS, channel);
    ipcRenderer.send(channel, ...args);
  },
  // 監聽主行程事件；listener 只收到資料（不含 IpcRendererEvent），回傳取消監聽的函式
  on(channel, listener) {
    assertAllowed(EVENT_CHANNELS, channel);
    const wrapped = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
};

// contextIsolation 開啟時經由 contextBridge 暴露；關閉時（過渡期）直接掛在 window 上
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api);
} else {
  window.api = api;
}
