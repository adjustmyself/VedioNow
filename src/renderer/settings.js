const { ipcRenderer } = require('electron');

class SettingsManager {
    constructor() {
        this.currentSection = 'database';
        this.config = {};
        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.loadSettings();
    }

    setupEventListeners() {
        // 側邊欄選單
        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                const section = e.currentTarget.dataset.section;
                this.switchSection(section);
            });
        });

        // 資料庫類型切換
        document.querySelectorAll('input[name="database-type"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.toggleDatabaseConfig(e.target.value);
            });
        });

        // 分頁切換
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.target.dataset.tab;
                this.switchTab(tab);
            });
        });

        // 測試連線按鈕
        document.getElementById('test-connection-btn').addEventListener('click', () => {
            this.testConnection();
        });

        // 儲存設定按鈕
        document.getElementById('save-settings-btn').addEventListener('click', () => {
            this.saveSettings();
        });

        // 重置設定按鈕
        document.getElementById('reset-settings-btn').addEventListener('click', () => {
            this.resetSettings();
        });

        // 瀏覽SQLite路徑按鈕
        document.getElementById('browse-sqlite-path').addEventListener('click', () => {
            this.browseSQLitePath();
        });

        // 模態框關閉
        document.getElementById('save-modal-close').addEventListener('click', () => {
            this.hideModal('save-modal');
        });

        document.getElementById('continue-without-restart').addEventListener('click', () => {
            this.hideModal('save-modal');
        });

        document.getElementById('restart-app').addEventListener('click', () => {
            ipcRenderer.send('restart-app');
        });

        // 縮圖管理相關按鈕
        document.getElementById('refresh-thumbnail-stats').addEventListener('click', () => {
            this.loadThumbnailStats();
        });

        document.getElementById('cleanup-thumbnails-btn').addEventListener('click', () => {
            this.cleanupThumbnails();
        });

        document.getElementById('migrate-thumbnails-btn').addEventListener('click', () => {
            this.migrateThumbnails();
        });

        // MongoDB設定變更監聽
        this.setupMongoDBFieldListeners();
    }

    setupMongoDBFieldListeners() {
        const mongoFields = [
            'mongodb-host', 'mongodb-port', 'mongodb-database',
            'mongodb-username', 'mongodb-password', 'mongodb-auth-source',
            'mongodb-ssl', 'mongodb-connection-string'
        ];

        mongoFields.forEach(fieldId => {
            const field = document.getElementById(fieldId);
            if (field) {
                field.addEventListener('change', () => {
                    this.clearConnectionStatus();
                });
                field.addEventListener('input', () => {
                    this.clearConnectionStatus();
                });
            }
        });
    }

    switchSection(section) {
        // 更新側邊欄
        document.querySelectorAll('.menu-item').forEach(item => {
            item.classList.remove('active');
        });
        document.querySelector(`[data-section="${section}"]`).classList.add('active');

        // 更新內容區域
        document.querySelectorAll('.settings-section').forEach(section => {
            section.classList.remove('active');
        });
        document.getElementById(`${section}-section`).classList.add('active');

        this.currentSection = section;
    }

    switchTab(tab) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`${tab}-tab`).classList.add('active');
    }

    toggleDatabaseConfig(type) {
        const sqliteConfig = document.getElementById('sqlite-config');
        const mongodbConfig = document.getElementById('mongodb-config');

        if (type === 'sqlite') {
            sqliteConfig.classList.remove('hidden');
            mongodbConfig.classList.add('hidden');
        } else {
            sqliteConfig.classList.add('hidden');
            mongodbConfig.classList.remove('hidden');
        }

        this.clearConnectionStatus();
    }

    async loadSettings() {
        try {
            this.config = await ipcRenderer.invoke('get-config');

            // 載入資料庫設定
            const dbType = this.config.database?.type || 'sqlite';
            document.querySelector(`input[name="database-type"][value="${dbType}"]`).checked = true;
            this.toggleDatabaseConfig(dbType);

            // SQLite 設定
            if (this.config.database?.sqlite?.path) {
                document.getElementById('sqlite-path').value = this.config.database.sqlite.path;
            }

            // MongoDB 設定
            const mongodb = this.config.database?.mongodb || {};
            document.getElementById('mongodb-host').value = mongodb.host || '127.0.0.1';
            document.getElementById('mongodb-port').value = mongodb.port || 27017;
            document.getElementById('mongodb-database').value = mongodb.database || 'videonow';
            document.getElementById('mongodb-username').value = mongodb.username || '';
            document.getElementById('mongodb-password').value = mongodb.password || '';
            document.getElementById('mongodb-auth-source').value = mongodb.authSource || 'admin';
            document.getElementById('mongodb-ssl').checked = mongodb.ssl || false;
            document.getElementById('mongodb-connection-string').value = mongodb.connectionString || '';

            // 應用程式設定
            const app = this.config.app || {};
            document.getElementById('app-theme').value = app.theme || 'light';
            document.getElementById('app-language').value = app.language || 'zh-TW';

            // 載入縮圖統計
            this.loadThumbnailStats();

        } catch (error) {
            console.error('載入設定失敗:', error);
            this.showError('載入設定失敗: ' + error.message);
        }
    }

    async saveSettings() {
        try {
            const settings = this.collectSettings();
            const success = await ipcRenderer.invoke('save-config', settings);

            if (success) {
                this.showModal('save-modal');
            } else {
                this.showError('儲存設定失敗');
            }
        } catch (error) {
            console.error('儲存設定失敗:', error);
            this.showError('儲存設定失敗: ' + error.message);
        }
    }

    collectSettings() {
        const dbType = document.querySelector('input[name="database-type"]:checked').value;

        const settings = {
            database: {
                type: dbType,
                sqlite: {
                    path: document.getElementById('sqlite-path').value
                },
                mongodb: {
                    host: document.getElementById('mongodb-host').value,
                    port: parseInt(document.getElementById('mongodb-port').value),
                    database: document.getElementById('mongodb-database').value,
                    username: document.getElementById('mongodb-username').value,
                    password: document.getElementById('mongodb-password').value,
                    authSource: document.getElementById('mongodb-auth-source').value,
                    ssl: document.getElementById('mongodb-ssl').checked,
                    connectionString: document.getElementById('mongodb-connection-string').value
                }
            },
            app: {
                theme: document.getElementById('app-theme').value,
                language: document.getElementById('app-language').value
            }
        };

        return settings;
    }

    async resetSettings() {
        if (confirm('確定要重置所有設定到預設值嗎？')) {
            try {
                const success = await ipcRenderer.invoke('reset-config');
                if (success) {
                    await this.loadSettings();
                    alert('設定已重置到預設值');
                } else {
                    this.showError('重置設定失敗');
                }
            } catch (error) {
                console.error('重置設定失敗:', error);
                this.showError('重置設定失敗: ' + error.message);
            }
        }
    }

    async testConnection() {
        const statusEl = document.getElementById('connection-status');
        const testBtn = document.getElementById('test-connection-btn');

        // 更新UI狀態
        statusEl.className = 'connection-status testing';
        statusEl.textContent = '正在測試連線...';
        testBtn.disabled = true;

        try {
            // 收集MongoDB設定
            const mongoConfig = {
                host: document.getElementById('mongodb-host').value,
                port: parseInt(document.getElementById('mongodb-port').value),
                database: document.getElementById('mongodb-database').value,
                username: document.getElementById('mongodb-username').value,
                password: document.getElementById('mongodb-password').value,
                authSource: document.getElementById('mongodb-auth-source').value,
                ssl: document.getElementById('mongodb-ssl').checked,
                connectionString: document.getElementById('mongodb-connection-string').value
            };

            // 發送測試請求
            const result = await ipcRenderer.invoke('test-mongodb-connection', mongoConfig);

            if (result.success) {
                statusEl.className = 'connection-status success';
                statusEl.textContent = '連線成功！';
            } else {
                statusEl.className = 'connection-status error';
                statusEl.textContent = '連線失敗: ' + result.message;
            }
        } catch (error) {
            console.error('測試連線失敗:', error);
            statusEl.className = 'connection-status error';
            statusEl.textContent = '測試連線失敗: ' + error.message;
        } finally {
            testBtn.disabled = false;
        }
    }

    clearConnectionStatus() {
        const statusEl = document.getElementById('connection-status');
        statusEl.className = 'connection-status';
        statusEl.textContent = '';
    }

    async browseSQLitePath() {
        try {
            const result = await ipcRenderer.invoke('dialog-save-file', {
                title: '選擇SQLite資料庫檔案位置',
                defaultPath: 'videos.db',
                filters: [
                    { name: 'SQLite資料庫', extensions: ['db', 'sqlite', 'sqlite3'] },
                    { name: '所有檔案', extensions: ['*'] }
                ]
            });

            if (result && !result.canceled) {
                document.getElementById('sqlite-path').value = result.filePath;
            }
        } catch (error) {
            console.error('選擇檔案失敗:', error);
            this.showError('選擇檔案失敗: ' + error.message);
        }
    }

    showModal(modalId) {
        document.getElementById(modalId).classList.remove('hidden');
    }

    hideModal(modalId) {
        document.getElementById(modalId).classList.add('hidden');
    }

    showError(message) {
        alert('錯誤: ' + message);
    }

    // 載入縮圖統計資訊
    async loadThumbnailStats() {
        try {
            const result = await ipcRenderer.invoke('get-thumbnail-stats');

            if (result.success) {
                const { stats } = result;
                document.getElementById('thumbnail-count').textContent = stats.total.toLocaleString();
                document.getElementById('thumbnail-size').textContent = this.formatFileSize(stats.size);
            } else {
                document.getElementById('thumbnail-count').textContent = '載入失敗';
                document.getElementById('thumbnail-size').textContent = '載入失敗';
            }
        } catch (error) {
            console.error('載入縮圖統計失敗:', error);
            document.getElementById('thumbnail-count').textContent = '載入失敗';
            document.getElementById('thumbnail-size').textContent = '載入失敗';
        }
    }

    // 清理過期縮圖
    async cleanupThumbnails() {
        const statusEl = document.getElementById('cleanup-status');
        const cleanupBtn = document.getElementById('cleanup-thumbnails-btn');

        // 確認操作
        if (!confirm('確定要清理過期縮圖嗎？這個操作將刪除與資料庫中影片檔案不對應的縮圖。')) {
            return;
        }

        // 更新UI狀態
        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在清理過期縮圖...';
        cleanupBtn.disabled = true;

        try {
            const result = await ipcRenderer.invoke('cleanup-thumbnails');

            if (result.success) {
                statusEl.className = 'cleanup-status success';
                statusEl.textContent = result.message;

                // 更新統計資訊
                setTimeout(() => {
                    this.loadThumbnailStats();
                }, 1000);
            } else {
                statusEl.className = 'cleanup-status error';
                statusEl.textContent = '清理失敗: ' + result.error;
            }
        } catch (error) {
            console.error('清理縮圖失敗:', error);
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '清理失敗: ' + error.message;
        } finally {
            cleanupBtn.disabled = false;

            // 5秒後清除狀態訊息
            setTimeout(() => {
                statusEl.className = 'cleanup-status';
                statusEl.textContent = '';
            }, 5000);
        }
    }

    // 遷移縮圖到影片資料夾
    async migrateThumbnails() {
        const statusEl = document.getElementById('migrate-status');
        const migrateBtn = document.getElementById('migrate-thumbnails-btn');

        // 確認操作
        if (!confirm('確定要將縮圖遷移到各自的影片資料夾嗎？這將讓多個用戶可以共享縮圖。')) {
            return;
        }

        // 更新UI狀態
        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在遷移縮圖...';
        migrateBtn.disabled = true;

        try {
            const result = await ipcRenderer.invoke('migrate-thumbnails');

            if (result.success) {
                statusEl.className = 'cleanup-status success';
                statusEl.textContent = result.message;

                // 更新統計資訊
                setTimeout(() => {
                    this.loadThumbnailStats();
                }, 1000);
            } else {
                statusEl.className = 'cleanup-status error';
                statusEl.textContent = '遷移失敗: ' + result.error;
            }
        } catch (error) {
            console.error('遷移縮圖失敗:', error);
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '遷移失敗: ' + error.message;
        } finally {
            migrateBtn.disabled = false;

            // 5秒後清除狀態訊息
            setTimeout(() => {
                statusEl.className = 'cleanup-status';
                statusEl.textContent = '';
            }, 5000);
        }
    }

    // 格式化檔案大小
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';

        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}

// 初始化設定管理器
document.addEventListener('DOMContentLoaded', () => {
    new SettingsManager();
});