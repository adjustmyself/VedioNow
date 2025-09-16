const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const Database = require('./database');
const VideoScanner = require('./videoScanner');
const ThumbnailGenerator = require('./thumbnailGenerator');

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
  database = new Database();
  await database.init();

  videoScanner = new VideoScanner(database);
  thumbnailGenerator = new ThumbnailGenerator();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
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

ipcMain.handle('scan-videos', async (event, folderPath) => {
  try {
    const videos = await videoScanner.scanFolder(folderPath);
    return { success: true, videos };
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
    return await database.getTagsByGroup();
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