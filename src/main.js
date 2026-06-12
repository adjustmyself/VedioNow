const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const DatabaseFactory = require('./database');
const VideoScanner = require('./videoScanner');
const ThumbnailGenerator = require('./thumbnailGenerator');
const Config = require('./config');

// Windows：明確設定 AppUserModelID，否則打包後工作列圖示不會套用自訂 icon
// （需與 package.json build.appId 一致）
if (process.platform === 'win32') {
  app.setAppUserModelId('com.videonow.app');
}

let mainWindow;
let database;
let videoScanner;
let thumbnailGenerator;
let config;

function createWindow() {
  // 根據平台選擇正確的 icon 格式
  let iconPath;
  if (process.platform === 'win32') {
    iconPath = path.join(__dirname, '../assets/icon.ico');
  } else if (process.platform === 'darwin') {
    iconPath = path.join(__dirname, '../assets/icon.icns');
  } else {
    iconPath = path.join(__dirname, '../assets/icon.png');
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: iconPath
  });

  mainWindow.loadFile('src/renderer/index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(async () => {
  try {
    // 初始化配置（全域單一實例）
    config = new Config();
    await config.init();

    // 使用工廠創建資料庫實例
    database = await DatabaseFactory.create();

    videoScanner = new VideoScanner(database);
    thumbnailGenerator = new ThumbnailGenerator();

    // 執行舊標籤系統遷移 (如果需要)
    try {
      const legacyMigrationResult = await database.migrateLegacyTags();
      if (legacyMigrationResult.migrated > 0 || legacyMigrationResult.metadataMigrated > 0) {
        console.log(`舊標籤系統遷移完成：已遷移 ${legacyMigrationResult.migrated} 個標籤，${legacyMigrationResult.metadataMigrated} 個影片元數據`);
      }
    } catch (error) {
      console.warn('舊標籤系統遷移失敗:', error);
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (error) {
    console.error('應用程式初始化失敗:', error);
    dialog.showErrorBox('初始化錯誤', `應用程式初始化失敗: ${error.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '選擇影片資料夾'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('scan-videos', async (event, folderPath, options = {}) => {
  try {
    // 創建進度回調函數，向渲染進程發送進度更新
    const progressCallback = (progressData) => {
      event.sender.send('scan-progress', progressData);
    };

    const result = await videoScanner.scanFolder(folderPath, {
      ...options,
      progressCallback
    });

    // 掃描成功後，將路徑保存到最近掃描記錄
    if (result) {
      await config.addRecentScanPath(folderPath);
    }

    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-videos', async (event, filters = {}) => {
  try {
    const result = await database.getVideos(filters);
    // 為了向下兼容，如果返回的是陣列，轉換為新格式
    if (Array.isArray(result)) {
      return result;
    }
    return result;
  } catch (error) {
    console.error('Error getting videos:', error);
    return { videos: [], total: 0, page: 1, pageSize: 9, totalPages: 0 };
  }
});

ipcMain.handle('add-tag', async (event, videoId, tagName) => {
  try {
    console.log('Adding tag:', { videoId, tagName });
    await database.addTag(videoId, tagName);
    console.log('Tag added successfully');
    return { success: true };
  } catch (error) {
    console.error('Error adding tag:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-tag', async (event, videoId, tagName) => {
  try {
    await database.removeTag(videoId, tagName);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 新的基於指紋的標籤操作
ipcMain.handle('add-video-tag', async (event, fingerprint, tagName) => {
  try {
    console.log('Adding video tag:', { fingerprint, tagName });
    await database.addVideoTag(fingerprint, tagName);
    console.log('Video tag added successfully');
    return { success: true };
  } catch (error) {
    console.error('Error adding video tag:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-video-tag', async (event, fingerprint, tagName) => {
  try {
    await database.removeVideoTag(fingerprint, tagName);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-video-metadata', async (event, fingerprint, metadata) => {
  try {
    await database.setVideoMetadata(fingerprint, metadata);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-all-tags', async () => {
  try {
    return await database.getAllTags();
  } catch (error) {
    console.error('Error getting tags:', error);
    return [];
  }
});

ipcMain.handle('search-videos', async (event, searchTerm, tags = [], filters = {}) => {
  try {
    const result = await database.searchVideos(searchTerm, tags, filters);
    // 為了向下兼容，如果返回的是陣列，轉換為新格式
    if (Array.isArray(result)) {
      return result;
    }
    return result;
  } catch (error) {
    console.error('Error searching videos:', error);
    return { videos: [], total: 0, page: 1, pageSize: 9, totalPages: 0 };
  }
});

// 取得目前篩選條件下每個標籤的影片計數（多面向篩選）
ipcMain.handle('get-filtered-tag-counts', async (event, searchTerm, tags = [], filters = {}) => {
  try {
    return await database.getTagCountsForFilter(searchTerm, tags, filters);
  } catch (error) {
    console.error('Error getting filtered tag counts:', error);
    return {};
  }
});

// 清理孤兒標籤關聯（指紋已不存在於 videos 集合的 video_tag_relations）
ipcMain.handle('cleanup-orphan-tag-relations', async () => {
  try {
    const { removed } = await database.cleanupOrphanTagRelations();
    const message = removed > 0
      ? `已清理 ${removed} 筆孤兒標籤關聯。`
      : '沒有發現孤兒標籤關聯，資料很乾淨。';
    return { success: true, removed, message };
  } catch (error) {
    console.error('Error cleaning orphan tag relations:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-video', async (event, videoId) => {
  try {
    await database.deleteVideo(videoId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-video-with-file', async (event, videoId) => {
  try {
    const result = await database.deleteVideoWithFile(videoId);
    return { success: true, result };
  } catch (error) {
    console.error('Error deleting video with file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('show-delete-confirmation', async (event, filename) => {
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['取消', '確認刪除'],
    defaultId: 0,
    cancelId: 0,
    title: '確認刪除檔案',
    message: '警告：此操作將永久刪除檔案！',
    detail: `檔案：${filename}\n\n此操作無法復原，確定要刪除嗎？`,
    checkboxLabel: '我瞭解此操作無法復原',
    checkboxChecked: false
  });

  return {
    confirmed: response.response === 1 && response.checkboxChecked,
    checkboxChecked: response.checkboxChecked
  };
});

ipcMain.handle('update-video', async (event, videoId, updates) => {
  try {
    await database.updateVideo(videoId, updates);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 標籤群組管理 IPC 處理
ipcMain.handle('create-tag-group', async (event, groupData) => {
  try {
    const groupId = await database.createTagGroup(groupData);
    return { success: true, groupId };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-all-tag-groups', async () => {
  try {
    return await database.getAllTagGroups();
  } catch (error) {
    console.error('Error getting tag groups:', error);
    return [];
  }
});

ipcMain.handle('update-tag-group', async (event, groupId, updates) => {
  try {
    console.log('IPC: 收到更新標籤群組請求:', { groupId, updates });
    const result = await database.updateTagGroup(groupId, updates);
    console.log('IPC: 更新標籤群組結果:', result);
    return { success: true, result };
  } catch (error) {
    console.error('IPC: 更新標籤群組失敗:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-tag-group', async (event, groupId) => {
  try {
    await database.deleteTagGroup(groupId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 新的標籤管理 IPC 處理
ipcMain.handle('create-tag', async (event, tagData) => {
  try {
    const tagId = await database.createTag(tagData);
    return { success: true, tagId };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-tags-by-group', async () => {
  try {
    console.log('開始獲取標籤群組...');
    const result = await database.getTagsByGroup();
    console.log('成功獲取標籤群組，數量:', result.length);
    console.log('標籤群組內容:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('Error getting tags by group:', error);
    return [];
  }
});

ipcMain.handle('get-drive-paths', async () => {
  try {
    console.log('開始獲取硬碟路徑...');
    const result = await database.getAllDrivePaths();
    console.log('成功獲取硬碟路徑，數量:', result.length);
    return result;
  } catch (error) {
    console.error('Error getting drive paths:', error);
    return [];
  }
});

ipcMain.handle('update-tag', async (event, tagId, updates) => {
  try {
    await database.updateTag(tagId, updates);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-tag', async (event, tagId) => {
  try {
    await database.deleteTag(tagId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ========== 影片合集相關 IPC Handlers ==========

ipcMain.handle('create-collection', async (event, mainFingerprint, childFingerprints, collectionName, folderPath) => {
  try {
    const result = await database.createVideoCollection(mainFingerprint, childFingerprints, collectionName, folderPath);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error creating collection:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-collection', async (event, mainFingerprint) => {
  try {
    const result = await database.removeVideoCollection(mainFingerprint);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error removing collection:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-collection', async (event, mainFingerprint) => {
  try {
    const collection = await database.getVideoCollection(mainFingerprint);
    return { success: true, data: collection };
  } catch (error) {
    console.error('Error getting collection:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-collection', async (event, mainFingerprint, updates) => {
  try {
    const result = await database.updateVideoCollection(mainFingerprint, updates);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error updating collection:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('remove-video-from-collection', async (event, mainFingerprint, childFingerprint) => {
  try {
    const result = await database.removeVideoFromCollection(mainFingerprint, childFingerprint);
    return { success: true, data: result };
  } catch (error) {
    console.error('Error removing video from collection:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-folder-videos', async (event, folderPath) => {
  try {
    const videos = await database.getVideosByFolder(folderPath);
    return { success: true, data: videos };
  } catch (error) {
    console.error('Error getting folder videos:', error);
    return { success: false, error: error.message };
  }
});

// 開啟標籤管理視窗
ipcMain.handle('open-tag-manager', async () => {
  const tagWindow = new BrowserWindow({
    width: 900,
    height: 700,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: '標籤管理器'
  });

  tagWindow.loadFile('src/renderer/tag-manager.html');

  if (process.argv.includes('--dev')) {
    tagWindow.webContents.openDevTools();
  }

  return { success: true };
});

// 縮圖相關的 IPC handlers
ipcMain.handle('get-thumbnail', async (event, videoPath) => {
  try {
    const thumbnail = await thumbnailGenerator.generateThumbnail(videoPath);
    return { success: true, thumbnail };
  } catch (error) {
    console.error('生成縮圖錯誤:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('check-thumbnail', async (event, videoPath) => {
  try {
    const existingThumbnail = await thumbnailGenerator.thumbnailExists(videoPath);
    return { success: true, exists: !!existingThumbnail, path: existingThumbnail };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 批次檢查縮圖：渲染一頁時用，避免 N 次 IPC 來回
ipcMain.handle('check-thumbnails-batch', async (event, videoPaths) => {
  try {
    if (!Array.isArray(videoPaths) || videoPaths.length === 0) {
      return { success: true, results: {} };
    }
    const entries = await Promise.all(
      videoPaths.map(async (p) => {
        try {
          const existing = await thumbnailGenerator.thumbnailExists(p);
          return [p, existing || null];
        } catch {
          return [p, null];
        }
      })
    );
    const results = Object.fromEntries(entries);
    return { success: true, results };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 強制重新生成縮圖（可指定擷取秒數）
ipcMain.handle('generate-thumbnail-force', async (event, videoPath, timeOffset) => {
  try {
    const thumbnailPath = thumbnailGenerator.getThumbnailPath(videoPath);

    // 刪除現有縮圖（如果存在）
    const existingThumbnail = await thumbnailGenerator.thumbnailExists(videoPath);
    if (existingThumbnail) {
      await fs.remove(existingThumbnail);
      console.log('已刪除舊縮圖:', existingThumbnail);
    }

    // 使用 FFmpeg 生成新縮圖
    const result = await thumbnailGenerator.generateThumbnail(videoPath, timeOffset);

    if (result) {
      return { success: true, thumbnail: result };
    } else {
      throw new Error('FFmpeg 縮圖生成返回 null');
    }
  } catch (error) {
    console.error('強制生成縮圖錯誤:', error);
    return { success: false, error: error.message };
  }
});

// 縮圖清理
ipcMain.handle('cleanup-thumbnails', async () => {
  try {
    // 必須取得「全部」影片路徑（不可用分頁的 getVideos，否則會誤刪有效縮圖）
    const refs = await database.getAllVideoRefs();
    const validVideoPaths = refs.map(ref => ref.filepath);

    await thumbnailGenerator.cleanupThumbnails(validVideoPaths);
    return { success: true, message: '縮圖清理完成' };
  } catch (error) {
    console.error('縮圖清理錯誤:', error);
    return { success: false, error: error.message };
  }
});

// 縮圖統計資訊
ipcMain.handle('get-thumbnail-stats', async () => {
  try {
    const stats = await thumbnailGenerator.getThumbnailStats();
    return { success: true, stats };
  } catch (error) {
    console.error('獲取縮圖統計錯誤:', error);
    return { success: false, error: error.message };
  }
});

// 縮圖遷移（縮圖已統一存於本地目錄，保留 IPC 以相容設定頁按鈕）
ipcMain.handle('migrate-thumbnails', async () => {
  try {
    const result = await thumbnailGenerator.migrateThumbnails();
    return {
      success: true,
      message: `已遷移 ${result.migrated} 個縮圖檔案，${result.errors} 個錯誤`,
      result
    };
  } catch (error) {
    console.error('縮圖遷移錯誤:', error);
    return { success: false, error: error.message };
  }
});

// 設置頁面相關的 IPC 處理程序
ipcMain.handle('open-settings', async () => {
  const settingsWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    parent: mainWindow,
    modal: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: '應用程式設定'
  });

  settingsWindow.loadFile('src/renderer/settings.html');

  if (process.argv.includes('--dev')) {
    settingsWindow.webContents.openDevTools();
  }

  return { success: true };
});

// 獲取配置
ipcMain.handle('get-config', async () => {
  try {
    return await config.load();
  } catch (error) {
    console.error('獲取配置失敗:', error);
    throw error;
  }
});

// 儲存配置
ipcMain.handle('save-config', async (event, settings) => {
  try {
    // 必須在儲存前讀取舊設定，存檔後再讀只會讀到新值，永遠偵測不到類型變更
    const previousConfig = await config.load();
    const success = await config.save(settings);

    if (success && previousConfig.database.type !== settings.database.type) {
      // 資料庫類型改變，重新初始化資料庫
      if (database) {
        database.close();
      }
      database = await DatabaseFactory.create();
      videoScanner = new VideoScanner(database);
    }

    return success;
  } catch (error) {
    console.error('儲存配置失敗:', error);
    return false;
  }
});

// 重置配置
ipcMain.handle('reset-config', async () => {
  try {
    // 刪除配置檔案
    if (await fs.pathExists(config.getConfigPath())) {
      await fs.remove(config.getConfigPath());
    }

    // 重新初始化
    await config.init();

    // 重新創建資料庫實例
    if (database) {
      database.close();
    }
    database = await DatabaseFactory.create();
    videoScanner = new VideoScanner(database);

    return true;
  } catch (error) {
    console.error('重置配置失敗:', error);
    return false;
  }
});

// 測試MongoDB連線
ipcMain.handle('test-mongodb-connection', async (event, mongoConfig) => {
  try {
    // 暫時更新MongoDB配置
    const tempConfig = await config.load();
    tempConfig.database.mongodb = { ...tempConfig.database.mongodb, ...mongoConfig };

    // 創建臨時Config實例來測試連線
    const testConfig = new Config();
    testConfig.defaultConfig = tempConfig;

    const result = await testConfig.testMongoDBConnection();
    return result;
  } catch (error) {
    console.error('測試MongoDB連線失敗:', error);
    return {
      success: false,
      message: error.message || '測試連線失敗'
    };
  }
});

// 上傳字幕：選擇字幕檔並複製到影片所在資料夾，重新命名成影片檔名
ipcMain.handle('upload-subtitle', async (event, videoPath) => {
  try {
    if (!videoPath) {
      return { success: false, error: '未指定影片' };
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: '選擇字幕檔',
      filters: [
        { name: '字幕檔', extensions: ['srt', 'vtt', 'ass', 'ssa', 'sub', 'idx', 'sup', 'smi', 'txt'] },
        { name: '所有檔案', extensions: ['*'] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const subtitlePath = result.filePaths[0];
    const folder = path.dirname(videoPath);
    const videoBase = path.basename(videoPath, path.extname(videoPath));
    const subtitleExt = path.extname(subtitlePath);
    const targetPath = path.join(folder, videoBase + subtitleExt);

    if (await fs.pathExists(targetPath)) {
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['取消', '覆寫'],
        defaultId: 0,
        cancelId: 0,
        title: '字幕檔已存在',
        message: `已存在同名字幕：${path.basename(targetPath)}`,
        detail: '是否覆寫？'
      });
      if (confirm.response !== 1) {
        return { success: false, canceled: true };
      }
    }

    await fs.copy(subtitlePath, targetPath, { overwrite: true });
    return { success: true, targetPath };
  } catch (error) {
    console.error('上傳字幕失敗:', error);
    return { success: false, error: error.message };
  }
});

// 檔案對話框
ipcMain.handle('dialog-save-file', async (event, options) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, options);
    return result;
  } catch (error) {
    console.error('檔案對話框錯誤:', error);
    throw error;
  }
});

// 以系統預設程式開啟檔案（renderer 不直接使用 shell，統一走 IPC）
ipcMain.handle('open-path', async (event, targetPath) => {
  try {
    const result = await shell.openPath(targetPath);
    // shell.openPath 成功時回傳空字串，失敗時回傳錯誤訊息
    return { success: result === '', error: result || null };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// MongoDB → SQLite 一鍵資料遷移
ipcMain.handle('migrate-mongodb-to-sqlite', async () => {
  try {
    const { migrateMongoToSqlite } = require('./mongoToSqliteMigration');
    const connectionString = await config.getMongoDBConnectionString();
    const sqlitePath = DatabaseFactory.getSQLiteDbPath();

    const counts = await migrateMongoToSqlite(connectionString, sqlitePath);

    return {
      success: true,
      counts,
      message: `遷移完成：${counts.videos} 部影片、${counts.tags} 個標籤（${counts.tagGroups} 個群組）、` +
        `${counts.tagRelations} 筆標籤關聯、${counts.collections} 筆合集記錄。` +
        `請將資料庫類型切換為 SQLite 並重新啟動。`
    };
  } catch (error) {
    console.error('MongoDB → SQLite 遷移失敗:', error);
    return { success: false, error: error.message };
  }
});

// 重新啟動應用程式
ipcMain.handle('restart-app', async () => {
  app.relaunch();
  app.exit(0);
});

// 手動觸發舊標籤系統遷移
ipcMain.handle('migrate-legacy-tags', async () => {
  try {
    const result = await database.migrateLegacyTags();
    return {
      success: true,
      message: `遷移完成：已遷移 ${result.migrated} 個標籤，${result.metadataMigrated} 個影片元數據`,
      result
    };
  } catch (error) {
    console.error('手動遷移舊標籤系統失敗:', error);
    return { success: false, error: error.message };
  }
});

// 獲取最近掃描路徑
ipcMain.handle('get-recent-scan-paths', async () => {
  try {
    const paths = await config.getRecentScanPaths();
    return { success: true, paths };
  } catch (error) {
    console.error('獲取最近掃描路徑失敗:', error);
    return { success: false, error: error.message, paths: [] };
  }
});

// 清空最近掃描路徑
ipcMain.handle('clear-recent-scan-paths', async () => {
  try {
    const success = await config.clearRecentScanPaths();
    return { success };
  } catch (error) {
    console.error('清空最近掃描路徑失敗:', error);
    return { success: false, error: error.message };
  }
});

// 移除單一掃描路徑
ipcMain.handle('remove-recent-scan-path', async (event, folderPath) => {
  try {
    const success = await config.removeRecentScanPath(folderPath);
    return { success };
  } catch (error) {
    console.error('移除最近掃描路徑失敗:', error);
    return { success: false, error: error.message };
  }
});