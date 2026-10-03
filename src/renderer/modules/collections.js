// VideoManager 的方法群組：影片合集：合併同資料夾影片、合集清單
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
import { escapeHtml } from '../shared/util.js';

class CollectionMethods {
  async showCollectionModal() {
    if (!this.selectedVideo || !this.selectedVideo.fingerprint) {
      alert('請先選擇一個影片');
      return;
    }

    // 支援 Windows 路徑的兩種分隔符（反斜線和正斜線）
    const filepath = this.selectedVideo.filepath;
    const lastBackslash = filepath.lastIndexOf('\\');
    const lastSlash = filepath.lastIndexOf('/');
    const lastSeparator = Math.max(lastBackslash, lastSlash);
    const folderPath = filepath.substring(0, lastSeparator);

    try {
      // 獲取同資料夾的所有影片
      const result = await window.api.invoke('get-folder-videos', folderPath);

      if (!result.success) {
        alert('獲取資料夾影片失敗: ' + result.error);
        return;
      }

      const folderVideos = result.data || [];

      if (folderVideos.length < 2) {
        alert('該資料夾只有一個影片，無法建立合集');
        return;
      }

      // 顯示模態框
      this.elements.collectionSelectModal.classList.remove('hidden');
      this.elements.collectionFolderPath.textContent = folderPath;
      this.elements.folderVideoCount.textContent = folderVideos.length;

      // 設定預設合集名稱為主影片檔名（去除副檔名）
      const mainFilename = this.selectedVideo.filename;
      const defaultName = mainFilename.substring(0, mainFilename.lastIndexOf('.')) || mainFilename;
      this.elements.collectionNameNew.value = defaultName;

      // 確保輸入框可以編輯並聚焦
      this.elements.collectionNameNew.removeAttribute('readonly');
      this.elements.collectionNameNew.removeAttribute('disabled');

      // 延遲聚焦，確保模態框已完全顯示
      setTimeout(() => {
        this.elements.collectionNameNew.focus();
        this.elements.collectionNameNew.select();
      }, 100);

      // 填充主影片選擇器
      this.elements.mainVideoSelect.innerHTML = folderVideos.map(v =>
        `<option value="${escapeHtml(v.fingerprint)}" ${v.fingerprint === this.selectedVideo.fingerprint ? 'selected' : ''}>
          ${escapeHtml(v.filename)}
        </option>`
      ).join('');

      // 當主影片選擇改變時，更新子影片清單和預設名稱
      this.elements.mainVideoSelect.onchange = () => {
        const newMainFingerprint = this.elements.mainVideoSelect.value;
        const newMainVideo = folderVideos.find(v => v.fingerprint === newMainFingerprint);
        if (newMainVideo) {
          const newDefaultName = newMainVideo.filename.substring(0, newMainVideo.filename.lastIndexOf('.'));
          this.elements.collectionNameNew.value = newDefaultName;
          this.renderChildVideosList(folderVideos, newMainFingerprint);
        }
      };

      // 填充子影片清單（可勾選）
      this.renderChildVideosList(folderVideos, this.selectedVideo.fingerprint);

    } catch (error) {
      console.error('顯示合集模態框失敗:', error);
      alert('顯示合集選擇失敗');
    }
  }

  renderChildVideosList(videos, mainFingerprint) {
    this.elements.childVideosList.innerHTML = videos
      .filter(v => v.fingerprint !== mainFingerprint)
      .map(v => `
        <div class="child-video-item" data-fingerprint="${escapeHtml(v.fingerprint)}">
          <input type="checkbox" checked>
          <span>${escapeHtml(v.filename)}</span>
        </div>
      `).join('');
  }

  async confirmCreateCollection() {
    const mainFingerprint = this.elements.mainVideoSelect.value;
    const collectionName = this.elements.collectionNameNew.value.trim();
    const folderPath = this.elements.collectionFolderPath.textContent;

    if (!collectionName) {
      alert('請輸入合集名稱');
      return;
    }

    // 獲取勾選的子影片
    const checkboxes = this.elements.childVideosList.querySelectorAll('input[type="checkbox"]:checked');
    const childFingerprints = Array.from(checkboxes).map(cb =>
      cb.closest('.child-video-item').dataset.fingerprint
    );

    if (childFingerprints.length === 0) {
      alert('請至少選擇一個子影片');
      return;
    }

    try {
      const result = await window.api.invoke('create-collection',
        mainFingerprint, childFingerprints, collectionName, folderPath
      );

      if (result.success) {
        alert('合集建立成功！');
        this.hideCollectionModal();
        await this.refreshCurrentView();
      } else {
        alert('建立合集失敗: ' + result.error);
      }
    } catch (error) {
      console.error('建立合集失敗:', error);
      alert('建立合集失敗');
    }
  }

  async removeCollection() {
    if (!this.selectedVideo || !this.selectedVideo.fingerprint) {
      return;
    }

    // 先獲取合集資訊，顯示子影片數量
    try {
      const collectionResult = await window.api.invoke('get-collection', this.selectedVideo.fingerprint);
      let childCount = 0;
      if (collectionResult.success && collectionResult.data) {
        childCount = collectionResult.data.child_videos?.length || 0;
      }

      const totalCount = childCount + 1; // 子影片 + 主影片
      const message = childCount > 0
        ? `確定要刪除此合集嗎？\n\n⚠️ 警告：這將會刪除主影片和 ${childCount} 個子影片，共 ${totalCount} 個影片的資料庫記錄！\n（影片檔案不會被刪除）`
        : '確定要刪除此合集嗎？\n\n⚠️ 這將會刪除合集資料（影片檔案不會被刪除）';

      if (!confirm(message)) {
        return;
      }

      const result = await window.api.invoke('remove-collection', this.selectedVideo.fingerprint);

      if (result.success) {
        const deletedMsg = result.data?.totalVideosDeleted > 0
          ? `合集已刪除，已移除 ${result.data.totalVideosDeleted} 個影片的資料庫記錄`
          : '合集已刪除';
        alert(deletedMsg);
        this.hideVideoModal();
        await this.refreshCurrentView();
      } else {
        alert('刪除合集失敗: ' + result.error);
      }
    } catch (error) {
      console.error('刪除合集失敗:', error);
      alert('刪除合集失敗');
    }
  }

  hideCollectionModal() {
    this.elements.collectionSelectModal.classList.add('hidden');
    this.elements.collectionNameNew.value = '';
  }

  async loadCollectionInfo(fingerprint) {
    try {
      const result = await window.api.invoke('get-collection', fingerprint);

      if (result.success && result.data) {
        // 顯示合集資訊
        this.elements.collectionList.classList.remove('hidden');
        this.elements.removeCollectionBtn.classList.remove('hidden');

        // 顯示子影片清單
        const collection = result.data;
        this.elements.collectionEpisodes.innerHTML = collection.child_videos.map((v, index) => `
          <div class="episode-item" data-filepath="${escapeHtml(v.filepath)}">
            <span class="episode-number">${index + 1}</span>
            <span class="episode-name">${escapeHtml(v.filename)}</span>
            <button class="btn btn-play" data-filepath="${escapeHtml(v.filepath)}">▶ 播放</button>
          </div>
        `).join('');

        // 綁定播放按鈕事件
        this.bindEpisodePlayEvents();
      } else {
        // 不是合集主影片
        this.elements.collectionList.classList.add('hidden');
        this.elements.removeCollectionBtn.classList.add('hidden');
      }
    } catch (error) {
      console.error('載入合集資訊失敗:', error);
    }
  }

  bindEpisodePlayEvents() {
    // 使用事件委派綁定播放按鈕（只綁定一次）
    if (!this.episodePlayEventBound) {
      this.elements.collectionEpisodes.addEventListener('click', (e) => {
        const playButton = e.target.closest('.btn-play');
        if (playButton) {
          e.stopPropagation(); // 防止事件冒泡
          const filepath = playButton.dataset.filepath;
          if (filepath) {
            window.api.invoke('open-path', filepath);
          }
        }
      });
      this.episodePlayEventBound = true;
    }
  }
}

export default CollectionMethods;
