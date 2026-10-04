import { escapeHtml } from './shared/util.js';

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

        // 模態框關閉
        document.getElementById('save-modal-close').addEventListener('click', () => {
            this.hideModal('save-modal');
        });

        document.getElementById('continue-without-restart').addEventListener('click', () => {
            this.hideModal('save-modal');
        });

        document.getElementById('restart-app').addEventListener('click', () => {
            // restart-app 在 main 是 ipcMain.handle，必須用 invoke（send 不會觸發）
            window.api.invoke('restart-app');
        });

        // 縮圖管理相關按鈕
        document.getElementById('refresh-thumbnail-stats').addEventListener('click', () => {
            this.loadThumbnailStats();
        });

        document.getElementById('cleanup-thumbnails-btn').addEventListener('click', () => {
            this.cleanupThumbnails();
        });

        // 資料維護：清理孤兒標籤關聯
        document.getElementById('cleanup-orphan-relations-btn').addEventListener('click', () => {
            this.cleanupOrphanRelations();
        });

        // 自動標籤規則
        document.getElementById('auto-tag-add-btn').addEventListener('click', () => this.addAutoTagRule());
        document.getElementById('auto-tag-pattern').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.addAutoTagRule();
        });
        document.getElementById('auto-tag-tags').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.addAutoTagRule();
        });
        document.getElementById('auto-tag-preview-btn').addEventListener('click', () => this.previewAutoTagRules());
        document.getElementById('auto-tag-apply-btn').addEventListener('click', () => this.applyAutoTagRules());
        document.getElementById('auto-tag-rule-list').addEventListener('change', (e) => {
            const toggle = e.target.closest('.auto-tag-toggle');
            if (!toggle) return;
            const rule = this.autoTagRules.find(r => r.id === toggle.dataset.id);
            if (rule) this.saveAutoTagRules(this.autoTagRules.map(r => (r === rule ? { ...r, enabled: toggle.checked } : r)));
        });
        document.getElementById('auto-tag-rule-list').addEventListener('click', (e) => {
            const del = e.target.closest('.auto-tag-delete');
            if (!del) return;
            const rule = this.autoTagRules.find(r => r.id === del.dataset.id);
            if (rule && confirm(`刪除規則「${rule.pattern}」？\n已經加上的標籤不會被移除。`)) {
                this.saveAutoTagRules(this.autoTagRules.filter(r => r !== rule));
            }
        });

        // 備份與還原
        document.getElementById('open-backup-dir-btn').addEventListener('click', () => {
            window.api.invoke('open-backup-dir');
        });
        document.getElementById('create-backup-btn').addEventListener('click', () => {
            this.createBackup();
        });
        document.getElementById('restore-backup-btn').addEventListener('click', () => {
            this.restoreBackup();
        });

        // 存放位置
        document.getElementById('open-data-dir-btn').addEventListener('click', () => {
            window.api.invoke('open-storage-dir', 'data');
        });
        document.getElementById('open-images-dir-btn').addEventListener('click', () => {
            window.api.invoke('open-storage-dir', 'images');
        });
        document.getElementById('open-backup-root-btn').addEventListener('click', () => {
            window.api.invoke('open-storage-dir', 'backup');
        });
        document.getElementById('change-images-dir-btn').addEventListener('click', () => this.changeStorageDir('images', false));
        document.getElementById('reset-images-dir-btn').addEventListener('click', () => this.changeStorageDir('images', true));
        document.getElementById('change-backup-dir-btn').addEventListener('click', () => this.changeStorageDir('backup', false));
        document.getElementById('reset-backup-dir-btn').addEventListener('click', () => this.changeStorageDir('backup', true));

        // 資料維護：補齊影片長度
        document.getElementById('backfill-durations-btn').addEventListener('click', () => {
            this.backfillDurations();
        });
        window.api.on('duration-backfill-progress', ({ processed, total }) => {
            const statusEl = document.getElementById('backfill-durations-status');
            statusEl.className = 'cleanup-status working';
            statusEl.textContent = `正在讀取影片長度… ${processed} / ${total}`;
        });

        // MongoDB → SQLite 資料遷移
        document.getElementById('migrate-to-sqlite-btn').addEventListener('click', () => {
            this.migrateToSqlite();
        });

        // 主題即時預覽（儲存後才會套用到其他視窗）
        document.getElementById('app-theme').addEventListener('change', (e) => {
            if (typeof window.applyTheme === 'function') {
                window.applyTheme(e.target.value);
            }
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
        if (section === 'backup') this.loadBackupInfo();
        if (section === 'storage') this.loadStorageInfo();
        if (section === 'autotag') this.loadAutoTagRules();
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


    async loadSettings() {
        try {
            this.config = await window.api.invoke('get-config');

            // 資料庫類型
            document.getElementById('db-type').value = this.config.database?.type || 'sqlite';

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
            document.getElementById('app-page-size').value = app.pageSize || 9;
            document.getElementById('app-hover-preview').checked = app.hoverPreview !== false;
            document.getElementById('app-backup-thumbnails').checked = app.backupThumbnails !== false;
            document.getElementById('app-auto-backup-keep').value = app.autoBackupKeep || 7;

            // 載入縮圖統計與存放位置
            this.loadThumbnailStats();
            this.loadStorageInfo();

        } catch (error) {
            console.error('載入設定失敗:', error);
            this.showError('載入設定失敗: ' + error.message);
        }
    }

    async saveSettings() {
        try {
            const settings = this.collectSettings();
            // 只有資料庫類型變更才需要重啟；主題、語言等變更即時生效
            const needsRestart = (this.config?.database?.type || 'sqlite') !== settings.database.type;
            const success = await window.api.invoke('save-config', settings);

            if (success) {
                this.config = settings;
                // 「已保留」旁顯示的上限跟著更新
                if (this.currentSection === 'backup') this.loadBackupInfo();
                this.showSaveResult(needsRestart);
            } else {
                this.showError('儲存設定失敗');
            }
        } catch (error) {
            console.error('儲存設定失敗:', error);
            this.showError('儲存設定失敗: ' + error.message);
        }
    }

    collectSettings() {
        const settings = {
            database: {
                type: document.getElementById('db-type').value || 'sqlite',
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
                language: document.getElementById('app-language').value,
                pageSize: this.collectPageSize(),
                hoverPreview: document.getElementById('app-hover-preview').checked,
                backupThumbnails: document.getElementById('app-backup-thumbnails').checked,
                autoBackupKeep: this.collectAutoBackupKeep()
            }
        };

        return settings;
    }

    // 解析並限制單頁顯示數量（1～200，非法值回退 9）
    collectPageSize() {
        const raw = parseInt(document.getElementById('app-page-size').value, 10);
        if (isNaN(raw)) return 9;
        return Math.min(200, Math.max(1, raw));
    }

    // 自動備份保留份數（1～60，非法值回退 7；主行程會再檢查一次）
    collectAutoBackupKeep() {
        const raw = parseInt(document.getElementById('app-auto-backup-keep').value, 10);
        if (isNaN(raw)) return 7;
        return Math.min(60, Math.max(1, raw));
    }

    async resetSettings() {
        if (confirm('確定要重置所有設定到預設值嗎？')) {
            try {
                const success = await window.api.invoke('reset-config');
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
            const result = await window.api.invoke('test-mongodb-connection', mongoConfig);

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

    // 顯示儲存結果：需要重啟才出現重啟提問與按鈕，否則只顯示成功訊息
    showSaveResult(needsRestart) {
        const restartQuestion = document.getElementById('save-modal-restart-question');
        const restartBtn = document.getElementById('restart-app');
        const continueBtn = document.getElementById('continue-without-restart');

        if (needsRestart) {
            restartQuestion.classList.remove('hidden');
            restartBtn.classList.remove('hidden');
            continueBtn.textContent = '稍後重啟';
        } else {
            restartQuestion.classList.add('hidden');
            restartBtn.classList.add('hidden');
            continueBtn.textContent = '確定';
        }
        this.showModal('save-modal');
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
            const result = await window.api.invoke('get-thumbnail-stats');

            if (result.success) {
                const { stats } = result;
                document.getElementById('thumbnail-count').textContent = stats.total.toLocaleString();
                document.getElementById('thumbnail-size').textContent = this.formatFileSize(stats.size);
                const previews = stats.previews || { total: 0, size: 0 };
                document.getElementById('preview-stats').textContent =
                    `${previews.total.toLocaleString()} 個，${this.formatFileSize(previews.size)}`;
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
            const result = await window.api.invoke('cleanup-thumbnails');

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

    // MongoDB → SQLite 資料遷移
    async migrateToSqlite() {
        const statusEl = document.getElementById('migrate-sqlite-status');
        const btn = document.getElementById('migrate-to-sqlite-btn');

        if (!confirm('確定要把 MongoDB 的資料遷移到本機 SQLite 嗎？\n\nMongoDB 的資料不會被刪除或修改，可重複執行。')) {
            return;
        }

        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在遷移資料，資料量大時可能需要數分鐘...';
        btn.disabled = true;

        try {
            const result = await window.api.invoke('migrate-mongodb-to-sqlite');

            if (result.success) {
                statusEl.className = 'cleanup-status success';
                statusEl.textContent = result.message;
            } else {
                statusEl.className = 'cleanup-status error';
                statusEl.textContent = '遷移失敗: ' + result.error;
            }
        } catch (error) {
            console.error('遷移到 SQLite 失敗:', error);
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '遷移失敗: ' + error.message;
        } finally {
            btn.disabled = false;
        }
    }

    // 清理孤兒標籤關聯
    async cleanupOrphanRelations() {
        const statusEl = document.getElementById('cleanup-relations-status');
        const btn = document.getElementById('cleanup-orphan-relations-btn');

        if (!confirm('確定要清理孤兒標籤關聯嗎？這會刪除資料庫中已不存在影片所殘留的標籤關聯（不會刪到任何影片或縮圖）。')) {
            return;
        }

        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在清理孤兒標籤關聯...';
        btn.disabled = true;

        try {
            const result = await window.api.invoke('cleanup-orphan-tag-relations');

            if (result.success) {
                statusEl.className = 'cleanup-status success';
                statusEl.textContent = result.message;
            } else {
                statusEl.className = 'cleanup-status error';
                statusEl.textContent = '清理失敗: ' + result.error;
            }
        } catch (error) {
            console.error('清理孤兒標籤關聯失敗:', error);
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '清理失敗: ' + error.message;
        } finally {
            btn.disabled = false;

            // 8秒後清除狀態訊息
            setTimeout(() => {
                statusEl.className = 'cleanup-status';
                statusEl.textContent = '';
            }, 8000);
        }
    }

    // ========== 自動標籤規則 ==========

    async loadAutoTagRules() {
        const result = await window.api.invoke('get-auto-tag-rules');
        this.autoTagRules = result.success ? result.rules : [];
        this.autoTagPreview = null;
        this.renderAutoTagRules();

        // 標籤輸入框的自動完成
        try {
            const groups = await window.api.invoke('get-tags-by-group');
            const names = [...new Set((groups || []).flatMap(g => (g.tags || []).map(t => t.name)))];
            document.getElementById('auto-tag-tag-options').innerHTML =
                names.map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
        } catch (error) {
            console.warn('載入標籤清單失敗:', error);
        }
    }

    renderAutoTagRules() {
        const list = document.getElementById('auto-tag-rule-list');
        if (this.autoTagRules.length === 0) {
            list.innerHTML = '<p class="field-description">還沒有規則，請在下方新增。</p>';
            return;
        }
        const preview = new Map((this.autoTagPreview || []).map(p => [p.id, p]));
        list.innerHTML = this.autoTagRules.map(rule => {
            const field = rule.field === 'path' ? '完整路徑' : '檔名';
            const how = rule.type === 'regex' ? '符合正規表示式' : '包含';
            const p = preview.get(rule.id);
            const count = p ? (p.error ? `<span class="auto-tag-error">${escapeHtml(p.error)}</span>` : `符合 ${p.matched} 部`) : '';
            return `
            <div class="auto-tag-rule ${rule.enabled ? '' : 'disabled'}">
                <input type="checkbox" class="auto-tag-toggle" data-id="${escapeHtml(rule.id)}" ${rule.enabled ? 'checked' : ''} title="啟用 / 停用">
                <div class="auto-tag-rule-text">
                    <span>${field}${how}</span>
                    <code>${escapeHtml(rule.pattern)}</code>
                    <span class="auto-tag-arrow">→</span>
                    ${rule.tags.map(tag => `<span class="auto-tag-chip">${escapeHtml(tag)}</span>`).join('')}
                </div>
                <span class="auto-tag-count">${count}</span>
                <button type="button" class="auto-tag-delete btn btn-secondary btn-small" data-id="${escapeHtml(rule.id)}">刪除</button>
            </div>`;
        }).join('');
    }

    // 整份清單存回設定檔；成功後以存回的版本（已正規化）為準
    async saveAutoTagRules(rules) {
        const result = await window.api.invoke('save-auto-tag-rules', rules);
        if (!result.success) {
            alert(`儲存規則失敗：${result.error}`);
            return false;
        }
        this.autoTagRules = result.rules;
        this.autoTagPreview = null;
        this.renderAutoTagRules();
        return true;
    }

    async addAutoTagRule() {
        const statusEl = document.getElementById('auto-tag-add-status');
        const patternInput = document.getElementById('auto-tag-pattern');
        const tagsInput = document.getElementById('auto-tag-tags');
        const rule = {
            field: document.getElementById('auto-tag-field').value,
            type: document.getElementById('auto-tag-type').value,
            pattern: patternInput.value.trim(),
            tags: tagsInput.value.split(/[,，]/).map(t => t.trim()).filter(Boolean),
            enabled: true
        };
        if (!rule.pattern || rule.tags.length === 0) {
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = !rule.pattern ? '請輸入要比對的內容' : '請至少輸入一個標籤';
            return;
        }
        if (await this.saveAutoTagRules([...this.autoTagRules, rule])) {
            patternInput.value = '';
            tagsInput.value = '';
            statusEl.className = 'cleanup-status success';
            statusEl.textContent = '已新增規則';
            setTimeout(() => { statusEl.className = 'cleanup-status'; statusEl.textContent = ''; }, 3000);
        }
    }

    async previewAutoTagRules() {
        const statusEl = document.getElementById('auto-tag-status');
        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在計算...';
        const result = await window.api.invoke('preview-auto-tag-rules', this.autoTagRules);
        if (!result.success) {
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '預覽失敗: ' + result.error;
            return;
        }
        this.autoTagPreview = result.results;
        this.renderAutoTagRules();
        statusEl.className = 'cleanup-status success';
        statusEl.textContent = `共 ${result.total} 部影片`;
    }

    async applyAutoTagRules() {
        const enabled = this.autoTagRules.filter(r => r.enabled).length;
        if (enabled === 0) {
            alert('沒有啟用中的規則');
            return;
        }
        if (!confirm(`對資料庫中的全部影片套用 ${enabled} 條啟用中的規則？\n只會加上標籤，不會移除任何標籤。`)) return;

        const statusEl = document.getElementById('auto-tag-status');
        const btn = document.getElementById('auto-tag-apply-btn');
        btn.disabled = true;
        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在套用...';
        try {
            const result = await window.api.invoke('apply-auto-tag-rules');
            if (!result.success) throw new Error(result.error);
            statusEl.className = 'cleanup-status success';
            statusEl.textContent = `完成：${result.matchedVideos} 部影片符合，新加上 ${result.added} 個標籤`;
        } catch (error) {
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '套用失敗: ' + error.message;
        } finally {
            btn.disabled = false;
        }
    }

    async loadBackupInfo() {
        const latestEl = document.getElementById('backup-latest-auto');
        const countEl = document.getElementById('backup-auto-count');
        try {
            const info = await window.api.invoke('get-backup-info');
            if (!info.success) throw new Error(info.error);
            if (!info.supported) {
                latestEl.textContent = '目前使用 MongoDB，不支援備份';
                countEl.textContent = '-';
                ['create-backup-btn', 'restore-backup-btn'].forEach(id => {
                    document.getElementById(id).disabled = true;
                });
                return;
            }
            latestEl.textContent = info.latestAuto ? new Date(info.latestAuto).toLocaleString() : '尚未備份（啟動後約 15 秒會自動備份）';
            countEl.textContent = `${info.autoCount} 份（上限 ${info.keep} 份）`;
        } catch (error) {
            latestEl.textContent = '載入失敗';
            countEl.textContent = '載入失敗';
        }
    }

    async createBackup() {
        const statusEl = document.getElementById('create-backup-status');
        const btn = document.getElementById('create-backup-btn');
        btn.disabled = true;
        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在備份...';
        try {
            const result = await window.api.invoke('create-backup');
            if (result.canceled) {
                statusEl.className = 'cleanup-status';
                statusEl.textContent = '';
            } else if (result.success) {
                statusEl.className = 'cleanup-status success';
                statusEl.textContent = `備份完成：${result.path}`;
            } else {
                statusEl.className = 'cleanup-status error';
                statusEl.textContent = '備份失敗: ' + result.error;
            }
        } catch (error) {
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '備份失敗: ' + error.message;
        } finally {
            btn.disabled = false;
        }
    }

    async restoreBackup() {
        const statusEl = document.getElementById('restore-backup-status');
        const btn = document.getElementById('restore-backup-btn');
        btn.disabled = true;
        statusEl.className = 'cleanup-status';
        statusEl.textContent = '';
        try {
            const chosen = await window.api.invoke('choose-restore-backup');
            if (chosen.canceled) return;
            if (!chosen.success) throw new Error(chosen.error);

            const b = chosen.backup;
            const when = b.createdAt ? new Date(b.createdAt).toLocaleString() : '未知';
            const ok = confirm(
                `確定要用這份備份取代目前的資料嗎？\n\n` +
                `備份時間：${when}\n影片：${b.videos} 部\n標籤：${b.tags} 個\n` +
                `縮圖：${b.thumbnails > 0 ? `${b.thumbnails} 張（只補上缺少的）` : '未包含'}\n\n` +
                `還原前會先自動備份目前的資料，完成後應用程式會重新啟動。`
            );
            if (!ok) return;

            statusEl.className = 'cleanup-status working';
            statusEl.textContent = '正在還原，完成後會自動重新啟動...';
            const result = await window.api.invoke('restore-backup', b.path);
            if (!result.success) throw new Error(result.error);
        } catch (error) {
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '還原失敗: ' + error.message;
        } finally {
            btn.disabled = false;
        }
    }

    // ========== 存放位置 ==========

    async loadStorageInfo() {
        try {
            const info = await window.api.invoke('get-storage-info');
            const label = (dir, isDefault) => isDefault ? `${dir}（預設）` : dir;
            document.getElementById('storage-data-dir').textContent = info.dataDir;
            document.getElementById('storage-images-dir').textContent = label(info.imagesDir, info.imagesDirIsDefault);
            document.getElementById('storage-backup-dir').textContent = label(info.backupDir, info.backupDirIsDefault);
            document.getElementById('reset-images-dir-btn').disabled = info.imagesDirIsDefault;
            document.getElementById('reset-backup-dir-btn').disabled = info.backupDirIsDefault;
            document.getElementById('thumbnail-location').textContent = info.thumbnailsDir;
        } catch (error) {
            console.error('載入存放位置失敗:', error);
        }
    }

    // kind：images / backup；toDefault 為 true 時改回預設位置
    async changeStorageDir(kind, toDefault) {
        const isImages = kind === 'images';
        const statusEl = document.getElementById(isImages ? 'storage-images-status' : 'storage-backup-status');
        const buttons = ['change-images-dir-btn', 'reset-images-dir-btn', 'change-backup-dir-btn', 'reset-backup-dir-btn']
            .map(id => document.getElementById(id));

        let target = null;
        if (!toDefault) {
            const chosen = await window.api.invoke('choose-storage-dir', kind);
            if (!chosen.success) return;
            target = chosen.path;
        }

        const what = isImages ? '縮圖、滑過預覽與標籤圖片' : '自動備份與還原前備份';
        const where = target || '預設位置';
        const after = isImages ? '\n\n完成後應用程式會重新啟動。' : '';
        if (!confirm(`把${what}搬到：\n${where}\n\n檔案多時需要一段時間，期間請勿關閉程式。${after}`)) return;

        buttons.forEach(btn => { btn.disabled = true; });
        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在搬移...';
        try {
            const result = await window.api.invoke('change-storage-dir', kind, target);
            if (!result.success) throw new Error(result.error);
            statusEl.className = 'cleanup-status success';
            statusEl.textContent = result.restarting ? '搬移完成，正在重新啟動...' : `已搬到 ${result.path}`;
            if (!result.restarting) {
                await this.loadStorageInfo();
                this.loadBackupInfo();
            }
        } catch (error) {
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '變更失敗: ' + error.message;
            await this.loadStorageInfo();
        } finally {
            // loadStorageInfo 會依是否為預設位置重新設定兩個「改回預設」按鈕
            ['change-images-dir-btn', 'change-backup-dir-btn'].forEach(id => {
                document.getElementById(id).disabled = false;
            });
        }
    }

    // 補齊影片長度：對長度為 0 的影片讀取檔頭
    async backfillDurations() {
        const statusEl = document.getElementById('backfill-durations-status');
        const btn = document.getElementById('backfill-durations-btn');

        statusEl.className = 'cleanup-status working';
        statusEl.textContent = '正在找出缺少長度的影片...';
        btn.disabled = true;

        try {
            const result = await window.api.invoke('backfill-durations');

            if (result.success) {
                statusEl.className = 'cleanup-status success';
                statusEl.textContent = result.total === 0
                    ? '所有影片都已有長度'
                    : `完成：補齊 ${result.updated} 部` + (result.failed > 0 ? `，${result.failed} 部無法讀取（檔案不存在或格式無法解析）` : '');
            } else {
                statusEl.className = 'cleanup-status error';
                statusEl.textContent = '補齊失敗: ' + result.error;
            }
        } catch (error) {
            console.error('補齊影片長度失敗:', error);
            statusEl.className = 'cleanup-status error';
            statusEl.textContent = '補齊失敗: ' + error.message;
        } finally {
            btn.disabled = false;
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