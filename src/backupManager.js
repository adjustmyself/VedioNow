const path = require('path');
const fs = require('fs-extra');

// 備份資料夾內容：資料庫（線上備份，單一檔案、不含 -wal/-shm）、設定檔、標籤圖片，
// 以及設定開啟時的縮圖。滑過預覽只是快取、可重新產生，不備份。
const DB_FILE = 'videonow.db';
const CONFIG_FILE = 'config.json';
const TAG_IMAGES_DIR = 'tag-images';
const THUMBNAILS_DIR = 'thumbnails';
const MANIFEST_FILE = 'manifest.json';
const BACKUP_PREFIX = 'VideoNow-backup-';

const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 自動備份保留份數：預設值與設定頁可選的範圍（config.app.autoBackupKeep）
const AUTO_BACKUP_KEEP = 7;
const AUTO_BACKUP_KEEP_MAX = 60;
const PRE_RESTORE_KEEP = 5;

// 設定值不合法時用預設值，超出範圍時夾到 1～AUTO_BACKUP_KEEP_MAX
function normalizeKeep(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return AUTO_BACKUP_KEEP;
  return Math.min(AUTO_BACKUP_KEEP_MAX, Math.max(1, Math.floor(n)));
}

// 本地時間 YYYYMMDD-HHmmss，資料夾名稱照字典序排就是時間順序
function formatTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 產生到一半的縮圖暫存檔（*.tmp.jpg）不備份
function isFinishedImage(src) {
  return !src.endsWith('.tmp.jpg');
}

async function countFiles(dir) {
  if (!await fs.pathExists(dir)) return 0;
  return (await fs.readdir(dir)).length;
}

class BackupManager {
  // imagesDir / backupsDir：設定頁「存放位置」的圖片與備份資料夾，預設在 userData 底下
  constructor({ userDataDir, imagesDir = userDataDir, backupsDir = path.join(userDataDir, 'backups'), appVersion = '' }) {
    this.userDataDir = userDataDir;
    this.imagesDir = imagesDir;
    this.appVersion = appVersion;
    this.backupsDir = backupsDir;
    this.autoDir = path.join(this.backupsDir, 'auto');
    this.preRestoreDir = path.join(this.backupsDir, 'pre-restore');
  }

  static supports(database) {
    return !!database && typeof database.backupTo === 'function';
  }

  // 在 parentDir 底下建立一份完整備份，回傳備份資料夾路徑
  async createBackup(database, parentDir, { now = new Date(), reason = 'manual', includeThumbnails = false } = {}) {
    if (!BackupManager.supports(database)) {
      throw new Error('目前使用的資料庫不支援備份（僅支援 SQLite）');
    }
    await fs.ensureDir(parentDir);

    // 同一秒內重複備份時加上序號，不覆蓋既有備份
    const base = `${BACKUP_PREFIX}${formatTimestamp(now)}`;
    let dir = path.join(parentDir, base);
    for (let i = 2; await fs.pathExists(dir); i++) {
      dir = path.join(parentDir, `${base}-${i}`);
    }
    // 先寫到暫存資料夾，全部完成才改名：中途失敗不會留下看似完整的半套備份
    const tmpDir = `${dir}.partial`;
    await fs.remove(tmpDir);
    await fs.ensureDir(tmpDir);

    try {
      await database.backupTo(path.join(tmpDir, DB_FILE));

      const configPath = path.join(this.userDataDir, CONFIG_FILE);
      if (await fs.pathExists(configPath)) {
        await fs.copy(configPath, path.join(tmpDir, CONFIG_FILE));
      }
      const tagImages = path.join(this.imagesDir, TAG_IMAGES_DIR);
      if (await fs.pathExists(tagImages)) {
        await fs.copy(tagImages, path.join(tmpDir, TAG_IMAGES_DIR));
      }
      let thumbnails = null;
      const thumbnailsSrc = path.join(this.imagesDir, THUMBNAILS_DIR);
      if (includeThumbnails && await fs.pathExists(thumbnailsSrc)) {
        await fs.copy(thumbnailsSrc, path.join(tmpDir, THUMBNAILS_DIR), { filter: isFinishedImage });
        thumbnails = await countFiles(path.join(tmpDir, THUMBNAILS_DIR));
      }

      const info = BackupManager.readDatabaseInfo(path.join(tmpDir, DB_FILE));
      await fs.writeJson(path.join(tmpDir, MANIFEST_FILE), {
        app: 'VideoNow',
        appVersion: this.appVersion,
        createdAt: now.toISOString(),
        reason,
        videos: info.videos,
        tags: info.tags,
        thumbnails
      }, { spaces: 2 });

      await fs.move(tmpDir, dir);
      return dir;
    } catch (error) {
      await fs.remove(tmpDir).catch(() => {});
      throw error;
    }
  }

  // 每天第一次啟動時備份一次，只保留最近 keep 份；回傳新備份路徑，今天已備份過回傳 null。
  // 調低份數時，多出來的舊備份在下一次自動備份後才刪除（儲存設定時不刪任何東西）
  async autoBackup(database, { now = new Date(), includeThumbnails = false, keep = AUTO_BACKUP_KEEP } = {}) {
    if (!BackupManager.supports(database)) return null;
    const [latest] = await this.listBackups(this.autoDir);
    if (latest && now - new Date(latest.createdAt) < AUTO_BACKUP_INTERVAL_MS) return null;

    const dir = await this.createBackup(database, this.autoDir, { now, reason: 'auto', includeThumbnails });
    await this.prune(this.autoDir, normalizeKeep(keep));
    return dir;
  }

  // 列出 parentDir 底下的備份，新的在前
  async listBackups(parentDir) {
    if (!await fs.pathExists(parentDir)) return [];
    const names = (await fs.readdir(parentDir))
      .filter(name => name.startsWith(BACKUP_PREFIX) && !name.endsWith('.partial'))
      .sort()
      .reverse();

    const backups = [];
    for (const name of names) {
      const dir = path.join(parentDir, name);
      const manifest = await fs.readJson(path.join(dir, MANIFEST_FILE)).catch(() => null);
      if (!manifest && !await fs.pathExists(path.join(dir, DB_FILE))) continue;
      const createdAt = manifest?.createdAt || (await fs.stat(dir)).mtime.toISOString();
      backups.push({ name, path: dir, createdAt, videos: manifest?.videos ?? null });
    }
    return backups;
  }

  async prune(parentDir, keep) {
    const backups = await this.listBackups(parentDir);
    for (const backup of backups.slice(keep)) {
      await fs.remove(backup.path);
    }
  }

  // 以唯讀方式打開備份資料庫，確認是 VideoNow 的資料庫並取得筆數
  static readDatabaseInfo(dbPath) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name)
      );
      if (!tables.has('videos') || !tables.has('tags')) {
        throw new Error('不是 VideoNow 的資料庫（缺少 videos / tags 資料表）');
      }
      return {
        videos: db.prepare('SELECT COUNT(*) AS n FROM videos').get().n,
        tags: db.prepare('SELECT COUNT(*) AS n FROM tags').get().n
      };
    } finally {
      db.close();
    }
  }

  // 檢查一個備份資料夾能否還原；回傳摘要（供確認對話框顯示），不合格時丟出錯誤
  async inspectBackup(dir) {
    const dbPath = path.join(dir, DB_FILE);
    if (!await fs.pathExists(dbPath)) {
      throw new Error(`這個資料夾裡沒有 ${DB_FILE}，不是 VideoNow 備份`);
    }
    let info;
    try {
      info = BackupManager.readDatabaseInfo(dbPath);
    } catch (error) {
      throw new Error(`備份資料庫無法讀取：${error.message}`);
    }
    const manifest = await fs.readJson(path.join(dir, MANIFEST_FILE)).catch(() => null);
    return {
      path: dir,
      createdAt: manifest?.createdAt || null,
      appVersion: manifest?.appVersion || null,
      videos: info.videos,
      tags: info.tags,
      hasTagImages: await fs.pathExists(path.join(dir, TAG_IMAGES_DIR)),
      thumbnails: await countFiles(path.join(dir, THUMBNAILS_DIR))
    };
  }

  // 還原前先替目前的資料做一份備份（資料庫必須仍開著）。
  // 不含縮圖：還原縮圖只會補上缺少的、不會刪除或覆蓋現有縮圖，回復時用不到
  async backupBeforeRestore(database) {
    const dir = await this.createBackup(database, this.preRestoreDir, { reason: 'pre-restore' });
    await this.prune(this.preRestoreDir, PRE_RESTORE_KEEP);
    return dir;
  }

  // 用備份覆蓋 userData 與圖片資料夾的檔案；呼叫前資料庫連線必須已關閉。
  // 設定檔保留目前的 database 與 storage 區段：還原資料不該順便把後端切到別的資料庫，
  // 也不該讓存放位置指回備份當時的資料夾（圖片已經還原到目前的位置）
  async restoreFiles(dir) {
    await this.inspectBackup(dir);

    const dbDest = path.join(this.userDataDir, DB_FILE);
    for (const suffix of ['', '-wal', '-shm']) {
      await fs.remove(dbDest + suffix);
    }
    await fs.copy(path.join(dir, DB_FILE), dbDest);

    const tagImagesSrc = path.join(dir, TAG_IMAGES_DIR);
    if (await fs.pathExists(tagImagesSrc)) {
      const tagImagesDest = path.join(this.imagesDir, TAG_IMAGES_DIR);
      await fs.remove(tagImagesDest);
      await fs.copy(tagImagesSrc, tagImagesDest);
    }

    // 縮圖以內容指紋命名，只補上缺少的：備份之後新產生的縮圖仍然有效，不必刪
    const thumbnailsSrc = path.join(dir, THUMBNAILS_DIR);
    if (await fs.pathExists(thumbnailsSrc)) {
      await fs.copy(thumbnailsSrc, path.join(this.imagesDir, THUMBNAILS_DIR), { overwrite: false, errorOnExist: false });
    }

    const configSrc = path.join(dir, CONFIG_FILE);
    if (await fs.pathExists(configSrc)) {
      const configDest = path.join(this.userDataDir, CONFIG_FILE);
      const restored = await fs.readJson(configSrc);
      const current = await fs.readJson(configDest).catch(() => null);
      if (current && current.database) restored.database = current.database;
      if (current && current.storage) restored.storage = current.storage;
      else delete restored.storage;
      await fs.writeJson(configDest, restored, { spaces: 2 });
    }
  }
}

module.exports = BackupManager;
module.exports.formatTimestamp = formatTimestamp;
module.exports.AUTO_BACKUP_KEEP = AUTO_BACKUP_KEEP;
module.exports.AUTO_BACKUP_KEEP_MAX = AUTO_BACKUP_KEEP_MAX;
module.exports.normalizeKeep = normalizeKeep;
