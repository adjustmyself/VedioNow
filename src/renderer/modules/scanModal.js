// VideoManager 的方法群組：掃描資料夾彈窗與最近掃描路徑
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
const { ipcRenderer } = require('electron');
const { escapeHtml } = require('../shared/util');

class ScanModalMethods {
  async showScanModal() {
    this.elements.scanModal.classList.remove('hidden');
    // 載入最近掃描路徑
    await this.loadRecentScanPaths();
  }

  hideScanModal() {
    this.elements.scanModal.classList.add('hidden');
    this.elements.scanProgress.classList.add('hidden');
  }

  async selectFolder() {
    try {
      const folderPath = await ipcRenderer.invoke('select-folder');
      if (folderPath) {
        this.elements.folderPath.value = folderPath;
      }
    } catch (error) {
      console.error('選擇資料夾錯誤:', error);
    }
  }

  async startScan() {
    const folderPath = this.elements.folderPath.value.trim();
    if (!folderPath) {
      alert('請選擇或輸入資料夾路徑');
      return;
    }

    const dateFilter = this.elements.scanDateFilterWeek.checked ? 'week'
      : this.elements.scanDateFilterMonth.checked ? 'month'
      : 'all';

    const options = {
      recursive: this.elements.recursiveScan.checked,
      watchChanges: this.elements.watchChanges.checked,
      cleanupMissing: this.elements.cleanupMissing.checked,
      dateFilter
    };

    this.elements.scanProgress.classList.remove('hidden');
    this.resetScanProgress();

    try {
      const result = await ipcRenderer.invoke('scan-videos', folderPath, options);
      if (result.success) {
        const stats = result.result;
        let message = `掃描完成！找到: ${stats.found}, 新增: ${stats.added}, 更新: ${stats.updated}, 未變更: ${stats.unchanged || 0}`;
        if (options.cleanupMissing && stats.cleaned > 0) {
          message += `, 清理: ${stats.cleaned}`;
        }
        this.elements.scanStatus.textContent = message;

        setTimeout(() => {
          this.hideScanModal();
          this.loadData();
        }, 3000);
      } else {
        this.elements.scanStatus.textContent = `掃描失敗: ${result.error}`;
      }
    } catch (error) {
      console.error('掃描錯誤:', error);
      this.elements.scanStatus.textContent = `掃描錯誤: ${error.message}`;
    }
  }

  resetScanProgress() {
    this.elements.scanPhase.textContent = '準備中...';
    this.elements.scanCounter.textContent = '';
    this.elements.scanPercentage.textContent = '0%';
    this.elements.progressFill.style.width = '0%';
    this.elements.scanStatus.textContent = '正在初始化...';
    this.elements.currentFile.textContent = '';
  }

  updateScanProgress(progressData) {
    const { phase, message, progress, filesFound, processed, currentFile } = progressData;

    // 更新階段顯示
    if (phase === 'scanning') {
      this.elements.scanPhase.textContent = '掃描中';
      this.elements.scanCounter.textContent = `已找到 ${filesFound || 0} 個影片`;
      this.elements.scanPercentage.textContent = '搜尋中...';
      this.elements.progressFill.style.width = '0%';
    } else if (phase === 'processing') {
      this.elements.scanPhase.textContent = '處理中';
      this.elements.scanCounter.textContent = `${processed || 0} / ${filesFound || 0} 個檔案`;
      this.elements.scanPercentage.textContent = `${Math.round(progress || 0)}%`;
      this.elements.progressFill.style.width = `${progress || 0}%`;
    }

    // 更新狀態訊息
    this.elements.scanStatus.textContent = message || '';

    // 更新當前檔案
    if (currentFile) {
      this.elements.currentFile.textContent = `當前檔案: ${currentFile}`;
    }
  }

  async loadRecentScanPaths() {
    try {
      const result = await ipcRenderer.invoke('get-recent-scan-paths');
      if (result.success && result.paths && result.paths.length > 0) {
        this.renderRecentScanPaths(result.paths);
        document.getElementById('recent-paths-group').classList.add('has-paths');
      } else {
        document.getElementById('recent-paths-group').classList.remove('has-paths');
        document.getElementById('recent-paths-list').innerHTML = '';
      }
    } catch (error) {
      console.error('載入最近掃描路徑失敗:', error);
    }
  }

  renderRecentScanPaths(paths) {
    const recentPathsList = document.getElementById('recent-paths-list');
    if (!recentPathsList) return;

    recentPathsList.innerHTML = paths.map(path => {
      const safePath = escapeHtml(path);
      return `
      <div class="recent-path-item" data-path="${safePath}" title="${safePath}">
        <span class="recent-path-icon">📁</span>
        <span class="recent-path-text">${safePath}</span>
        <button class="recent-path-remove" data-path="${safePath}" title="刪除此記憶路徑">✕</button>
      </div>
    `;
    }).join('');

    // 綁定點擊事件（選取路徑）
    recentPathsList.querySelectorAll('.recent-path-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // 點到刪除按鈕時不要觸發選取
        if (e.target.classList.contains('recent-path-remove')) return;
        const path = item.dataset.path;
        this.elements.folderPath.value = path;
        this.elements.folderPath.focus();
      });
    });

    // 綁定刪除事件
    recentPathsList.querySelectorAll('.recent-path-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const path = btn.dataset.path;
        await this.removeRecentScanPath(path);
      });
    });
  }

  async removeRecentScanPath(folderPath) {
    try {
      const result = await ipcRenderer.invoke('remove-recent-scan-path', folderPath);
      if (result.success) {
        await this.loadRecentScanPaths();
      }
    } catch (error) {
      console.error('移除最近掃描路徑失敗:', error);
    }
  }
}

module.exports = ScanModalMethods;
