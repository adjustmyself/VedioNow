const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const DatabaseFactory = require('./database');
const VideoScanner = require('./videoScanner');
const ThumbnailGenerator = require('./thumbnailGenerator');
const Config = require('./config');

let mainWindow;
let database;
let videoScanner;
let thumbnailGenerator;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, '../assets/icon.png')
  });

  mainWindow.loadFile('src/renderer/index.html');

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(async () => {
  try {
    // 初始化配置
    const config = new Config();
    await config.init();

    // 使用工廠創建資料庫實例
    database = await DatabaseFactory.create();

    videoScanner = new VideoScanner(database);
    thumbnailGenerator = new ThumbnailGenerator();

    // 執行縮圖遷移 (如果需要)
    try {
      const videos = await database.getVideos();
      const videoPaths = videos.map(video => video.filepath);
      const migrationResult = await thumbnailGenerator.migrateThumbnails(videoPaths);
      if (migrationResult.migrated > 0) {
        console.log(`縮圖遷移完成：已遷移 ${migrationResult.migrated} 個檔案`);
      }
    } catch (error) {
      console.warn('縮圖遷移失敗:', error);
    }

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
    const result = await videoScanner.scanFolder(folderPath, options);
    return { success: true, result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-videos', async (event, filters = {}) => {
  try {
    const videos = await database.getVideos(filters);
    return videos;
  } catch (error) {
    console.error('Error getting videos:', error);
    return [];
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

ipcMain.handle('search-videos', async (event, searchTerm, tags = []) => {
  try {
    return await database.searchVideos(searchTerm, tags);
  } catch (error) {
    console.error('Error searching videos:', error);
    return [];
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
    await database.updateTagGroup(groupId, updates);
    return { success: true };
  } catch (error) {
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

// 縮圖清理
ipcMain.handle('cleanup-thumbnails', async () => {
  try {
    // 獲取所有影片的路徑
    const videos = await database.getVideos();
    const validVideoPaths = videos.map(video => video.filepath);

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
    // 獲取所有影片的路徑來計算縮圖統計
    const videos = await database.getVideos();
    const videoPaths = videos.map(video => video.filepath);
    const stats = await thumbnailGenerator.getThumbnailStats(videoPaths);
    return { success: true, stats };
  } catch (error) {
    console.error('獲取縮圖統計錯誤:', error);
    return { success: false, error: error.message };
  }
});

// 縮圖遷移
ipcMain.handle('migrate-thumbnails', async () => {
  try {
    const videos = await database.getVideos();
    const videoPaths = videos.map(video => video.filepath);
    const result = await thumbnailGenerator.migrateThumbnails(videoPaths);
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
    const config = new Config();
    await config.init();
    return await config.load();
  } catch (error) {
    console.error('獲取配置失敗:', error);
    throw error;
  }
});

// 儲存配置
ipcMain.handle('save-config', async (event, settings) => {
  try {
    const config = new Config();
    await config.init();
    const success = await config.save(settings);

    if (success) {
      // 如果資料庫類型改變，需要重新初始化資料庫
      const currentConfig = await config.load();
      if (currentConfig.database.type !== settings.database.type) {
        // 關閉當前資料庫連線
        if (database) {
          database.close();
        }

        // 重新創建資料庫實例
        database = await DatabaseFactory.create();

        // 重新初始化 VideoScanner
        videoScanner = new VideoScanner(database);
      }
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
    const config = new Config();
    await config.init();

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
    const config = new Config();
    await config.init();

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