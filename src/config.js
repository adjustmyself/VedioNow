const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const { getUserDataDir } = require('./appPaths');
const AutoTagRules = require('./autoTagRules');
const { samePath } = require('./storageMover');

class Config {
  constructor() {
    // 存在 userData，否則重新 package 時會被程式目錄的 data/ 覆蓋掉
    this.configPath = path.join(getUserDataDir(), 'config.json');
    this.defaultConfig = {
      database: {
        // 預設使用 SQLite（零安裝依賴、本機檔案、速度快）；
        // 既有使用者 config.json 中的 mongodb 設定不受影響
        type: 'sqlite',
        mongodb: {
          // 只是新安裝的預設值；實際連線設定存在 userData/config.json，可在設定頁修改
          host: 'localhost',
          port: 27017,
          database: 'videonow',
          username: '',
          password: '',
          authSource: 'admin',
          ssl: false,
          connectionString: '' // 如果有自定義連線字串
        }
      },
      app: {
        theme: 'light',
        language: 'zh-TW',
        pageSize: 9,
        hoverPreview: true, // 滑鼠停在縮圖上時產生並顯示多格預覽
        backupThumbnails: true, // 手動與自動備份都包含縮圖
        autoBackupKeep: 7 // 自動備份保留份數（1～60，見 BackupManager.normalizeKeep）
      },
      // 圖片（縮圖、滑過預覽、標籤圖片）與備份的存放位置，空字串為 userData 底下的預設位置。
      // 由設定頁的「存放位置」變更（會搬移既有檔案），不經過 updateSettings
      storage: {
        imagesDir: '',
        backupDir: ''
      },
      scan: {
        recentPaths: [], // 已記憶的掃描路徑（永久保留，除非手動刪除）
        watchedFolders: [] // 監看中的資料夾 [{ path, recursive }]：每次啟動自動增量掃描並恢復監看
      },
      savedSearches: [], // 儲存的搜尋：篩選條件 + 排序，見 normalizeSavedSearch()
      autoTagRules: [] // 自動標籤規則，見 autoTagRules.js
    };
  }

  async init() {
    await fs.ensureDir(path.dirname(this.configPath));

    if (!await fs.pathExists(this.configPath)) {
      await this.save(this.defaultConfig);
    }
  }

  async load() {
    try {
      if (await fs.pathExists(this.configPath)) {
        const configData = await fs.readJson(this.configPath);
        return { ...this.defaultConfig, ...configData };
      }
      return this.defaultConfig;
    } catch (error) {
      console.error('載入配置檔案失敗:', error);
      return this.defaultConfig;
    }
  }

  async save(config) {
    try {
      await fs.writeJson(this.configPath, config, { spaces: 2 });
      return true;
    } catch (error) {
      console.error('儲存配置檔案失敗:', error);
      return false;
    }
  }

  // 設定頁儲存：只替換 database 與 app 區段。設定頁只送這兩段，
  // 直接整份覆蓋會清掉最近掃描路徑、監看資料夾、儲存的搜尋、自動標籤規則等其他資料
  async updateSettings({ database, app } = {}) {
    const config = await this.load();
    if (database) config.database = { ...config.database, ...database };
    if (app) config.app = { ...config.app, ...app };
    return await this.save(config);
  }

  async updateDatabaseConfig(databaseConfig) {
    const config = await this.load();
    config.database = { ...config.database, ...databaseConfig };
    return await this.save(config);
  }

  async getDatabaseConfig() {
    const config = await this.load();
    return config.database;
  }

  async setDatabaseType(type) {
    const config = await this.load();
    config.database.type = type;
    return await this.save(config);
  }

  async getMongoDBConnectionString() {
    const config = await this.load();
    const mongodb = config.database.mongodb;

    if (mongodb.connectionString) {
      return mongodb.connectionString;
    }

    let connectionString = 'mongodb://';

    if (mongodb.username && mongodb.password) {
      connectionString += `${encodeURIComponent(mongodb.username)}:${encodeURIComponent(mongodb.password)}@`;
    }

    connectionString += `${mongodb.host}:${mongodb.port}/${mongodb.database}`;

    const params = [];
    if (mongodb.authSource && mongodb.username) {
      params.push(`authSource=${mongodb.authSource}`);
    }
    if (mongodb.ssl) {
      params.push('ssl=true');
    }

    if (params.length > 0) {
      connectionString += '?' + params.join('&');
    }

    return connectionString;
  }

  async testMongoDBConnection() {
    try {
      const { MongoClient } = require('mongodb');
      const connectionString = await this.getMongoDBConnectionString();

      const client = new MongoClient(connectionString, {
        serverSelectionTimeoutMS: 5000,
        connectTimeoutMS: 5000
      });

      await client.connect();
      await client.db().admin().ping();
      await client.close();

      return { success: true, message: '連線成功' };
    } catch (error) {
      return {
        success: false,
        message: error.message || '連線失敗'
      };
    }
  }

  getConfigPath() {
    return this.configPath;
  }

  // ========== 存放位置 ==========

  static defaultStoragePaths() {
    return {
      imagesDir: getUserDataDir(),
      backupDir: path.join(getUserDataDir(), 'backups')
    };
  }

  // 實際使用的位置（未設定時為預設位置）
  async getStoragePaths() {
    const config = await this.load();
    const storage = config.storage || {};
    const defaults = Config.defaultStoragePaths();
    return {
      imagesDir: storage.imagesDir || defaults.imagesDir,
      backupDir: storage.backupDir || defaults.backupDir
    };
  }

  // key 為 imagesDir / backupDir；dir 與預設位置相同時存成空字串
  async setStoragePath(key, dir) {
    if (!['imagesDir', 'backupDir'].includes(key)) throw new Error(`未知的存放位置: ${key}`);
    const isDefault = !dir || samePath(dir, Config.defaultStoragePaths()[key]);
    const config = await this.load();
    config.storage = { ...config.storage, [key]: isDefault ? '' : path.resolve(dir) };
    if (!await this.save(config)) throw new Error('寫入設定檔失敗');
  }

  // 獲取最近掃描路徑
  async getRecentScanPaths() {
    try {
      const config = await this.load();
      return config.scan?.recentPaths || [];
    } catch (error) {
      console.error('獲取最近掃描路徑失敗:', error);
      return [];
    }
  }

  // 新增掃描路徑（永久保留，去重，最新使用排最前）
  async addRecentScanPath(folderPath) {
    try {
      const config = await this.load();
      if (!config.scan) {
        config.scan = { recentPaths: [] };
      }

      // 移除重複的路徑（不區分大小寫）
      const normalizedPath = folderPath.toLowerCase();
      config.scan.recentPaths = config.scan.recentPaths.filter(
        p => p.toLowerCase() !== normalizedPath
      );

      // 將新路徑添加到最前面
      config.scan.recentPaths.unshift(folderPath);

      return await this.save(config);
    } catch (error) {
      console.error('新增最近掃描路徑失敗:', error);
      return false;
    }
  }

  // 監看中的資料夾
  async getWatchedFolders() {
    try {
      const config = await this.load();
      const folders = config.scan?.watchedFolders;
      return Array.isArray(folders) ? folders.filter(f => f && typeof f.path === 'string') : [];
    } catch (error) {
      console.error('獲取監看資料夾失敗:', error);
      return [];
    }
  }

  // 新增或更新監看資料夾（路徑不分大小寫去重，已存在時更新是否包含子資料夾）
  async addWatchedFolder(folderPath, recursive = true) {
    try {
      const config = await this.load();
      if (!config.scan) config.scan = { recentPaths: [] };
      const folders = Array.isArray(config.scan.watchedFolders) ? config.scan.watchedFolders : [];
      const normalizedPath = folderPath.toLowerCase();
      config.scan.watchedFolders = [
        ...folders.filter(f => f.path.toLowerCase() !== normalizedPath),
        { path: folderPath, recursive: !!recursive }
      ];
      return await this.save(config);
    } catch (error) {
      console.error('新增監看資料夾失敗:', error);
      return false;
    }
  }

  // 移除監看資料夾，回傳被移除的設定（找不到時為 null）
  async removeWatchedFolder(folderPath) {
    try {
      const config = await this.load();
      const folders = Array.isArray(config.scan?.watchedFolders) ? config.scan.watchedFolders : [];
      const normalizedPath = folderPath.toLowerCase();
      const removed = folders.find(f => f.path.toLowerCase() === normalizedPath) || null;
      if (!removed) return null;
      config.scan.watchedFolders = folders.filter(f => f !== removed);
      await this.save(config);
      return removed;
    } catch (error) {
      console.error('移除監看資料夾失敗:', error);
      return null;
    }
  }

  // ========== 自動標籤規則 ==========

  async getAutoTagRules() {
    try {
      const config = await this.load();
      return Array.isArray(config.autoTagRules) ? config.autoTagRules.map(AutoTagRules.normalizeRule) : [];
    } catch (error) {
      console.error('獲取自動標籤規則失敗:', error);
      return [];
    }
  }

  // 整份規則清單一起存（設定頁編輯後送回）；有任何一條不合法就整批拒絕
  async saveAutoTagRules(rules) {
    if (!Array.isArray(rules)) throw new Error('規則格式錯誤');
    const normalized = rules.map(AutoTagRules.normalizeRule);
    for (const rule of normalized) {
      const error = AutoTagRules.validateRule(rule);
      if (error) throw new Error(`規則「${rule.pattern || '(空白)'}」：${error}`);
    }
    const config = await this.load();
    config.autoTagRules = normalized;
    if (!await this.save(config)) throw new Error('寫入設定檔失敗');
    return normalized;
  }

  // ========== 儲存的搜尋 ==========

  // 只保留已知欄位並修正型別（資料來自渲染器）
  static normalizeSavedSearch(search) {
    const SORT_FIELDS = ['file_created_at', 'created_at', 'filename', 'filesize', 'duration', 'rating', 'play_count', 'last_played_at'];
    const rating = Number(search.rating);
    return {
      id: typeof search.id === 'string' && search.id ? search.id : crypto.randomUUID(),
      name: String(search.name || '').trim().slice(0, 60),
      searchTerm: String(search.searchTerm || '').trim(),
      tags: Array.isArray(search.tags) ? [...new Set(search.tags.filter(t => typeof t === 'string' && t))] : [],
      rating: Number.isInteger(rating) && rating >= 0 && rating <= 5 ? rating : 0,
      drivePath: typeof search.drivePath === 'string' ? search.drivePath : '',
      duplicatesOnly: !!search.duplicatesOnly,
      unwatchedOnly: !!search.unwatchedOnly,
      sortBy: SORT_FIELDS.includes(search.sortBy) ? search.sortBy : 'file_created_at',
      sortOrder: search.sortOrder === 'asc' ? 'asc' : 'desc'
    };
  }

  async getSavedSearches() {
    try {
      const config = await this.load();
      return Array.isArray(config.savedSearches) ? config.savedSearches : [];
    } catch (error) {
      console.error('獲取儲存的搜尋失敗:', error);
      return [];
    }
  }

  // 儲存搜尋：同名（不分大小寫）就覆蓋原本那筆、保留位置；回傳更新後的清單
  async saveSearch(search) {
    const entry = Config.normalizeSavedSearch(search);
    if (!entry.name) throw new Error('請輸入名稱');
    const config = await this.load();
    const list = Array.isArray(config.savedSearches) ? config.savedSearches : [];
    const index = list.findIndex(s => s.name.toLowerCase() === entry.name.toLowerCase());
    if (index >= 0) {
      list[index] = { ...entry, id: list[index].id };
    } else {
      list.push(entry);
    }
    config.savedSearches = list;
    if (!await this.save(config)) throw new Error('寫入設定檔失敗');
    return list;
  }

  async deleteSavedSearch(id) {
    const config = await this.load();
    const list = Array.isArray(config.savedSearches) ? config.savedSearches : [];
    config.savedSearches = list.filter(s => s.id !== id);
    if (!await this.save(config)) throw new Error('寫入設定檔失敗');
    return config.savedSearches;
  }

  // 移除單一掃描路徑
  async removeRecentScanPath(folderPath) {
    try {
      const config = await this.load();
      if (!config.scan || !Array.isArray(config.scan.recentPaths)) {
        return true;
      }

      const normalizedPath = folderPath.toLowerCase();
      config.scan.recentPaths = config.scan.recentPaths.filter(
        p => p.toLowerCase() !== normalizedPath
      );

      return await this.save(config);
    } catch (error) {
      console.error('移除最近掃描路徑失敗:', error);
      return false;
    }
  }

}

module.exports = Config;