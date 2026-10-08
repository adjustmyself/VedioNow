// VideoManager 的方法群組：影片詳情彈窗：標籤增刪、評分與描述、刪除、開檔、字幕
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
import { escapeHtml } from '../shared/util.js';

class VideoModalMethods {
  async showVideoModal(videoId) {
    this.selectedVideo = this.currentVideos.find(v => v.id === videoId);
    if (!this.selectedVideo) return;

    document.getElementById('modal-filename').textContent = this.selectedVideo.filename;
    document.getElementById('modal-filepath').textContent = this.selectedVideo.filepath;
    document.getElementById('modal-filesize').textContent = this.formatFileSize(this.selectedVideo.filesize);
    document.getElementById('modal-duration').textContent = this.formatDuration(this.selectedVideo.duration) || '尚未取得';
    const createdText = this.selectedVideo.file_created_at
      ? new Date(this.selectedVideo.file_created_at).toLocaleString()
      : (this.selectedVideo.created_at ? new Date(this.selectedVideo.created_at).toLocaleString() : '未知日期');
    document.getElementById('modal-created').textContent = createdText;
    this.renderModalPlayStats();
    document.getElementById('modal-description').value = this.selectedVideo.description || '';

    this.renderModalTags();
    this.renderTagSelector();
    this.setModalRating(this.selectedVideo.rating || 0);
    this.bindModalEvents();

    // 先隱藏合集區，避免顯示上一部影片的殘留資料
    this.elements.collectionList.classList.add('hidden');
    this.elements.removeCollectionBtn.classList.add('hidden');

    // 先隱藏重複檔案區，避免顯示上一部影片的殘留資料
    document.getElementById('modal-duplicates-group').classList.add('hidden');

    // 立即顯示彈窗，合集與重複檔案資訊在背景載入
    this.elements.videoModal.classList.remove('hidden');

    if (this.selectedVideo.fingerprint) {
      const fingerprint = this.selectedVideo.fingerprint;
      this.loadCollectionInfo(fingerprint).catch(err => {
        console.error('背景載入合集資訊失敗:', err);
      });
      this.loadDuplicateFiles(this.selectedVideo).catch(err => {
        console.error('背景載入重複檔案失敗:', err);
      });
    }
  }

  // 列出內容相同、存在於其他路徑的檔案
  async loadDuplicateFiles(video) {
    const result = await window.api.invoke('get-duplicate-videos', video.fingerprint, video.id);
    // 載入期間已切換到別部影片就不要覆蓋
    if (this.selectedVideo !== video) return;

    const group = document.getElementById('modal-duplicates-group');
    const list = document.getElementById('modal-duplicates');
    const duplicates = (result && result.success && result.data) || [];
    if (duplicates.length === 0) {
      group.classList.add('hidden');
      return;
    }

    document.getElementById('modal-duplicates-label').textContent = `重複檔案（另有 ${duplicates.length} 份）:`;
    list.innerHTML = duplicates.map(d => `
      <li class="duplicate-item">
        <span class="duplicate-path path-text" title="${escapeHtml(d.filepath)}">${escapeHtml(d.filepath)}</span>
        ${d.is_master ? '' : '<span class="duplicate-badge">合集子影片</span>'}
        <button class="btn btn-small copy-path-btn" type="button" data-filepath="${escapeHtml(d.filepath)}">複製</button>
      </li>
    `).join('');

    if (!this._duplicateListBound) {
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('.copy-path-btn');
        if (btn) this.copyPathToClipboard(btn.dataset.filepath, btn);
      });
      this._duplicateListBound = true;
    }
    group.classList.remove('hidden');
  }

  // 複製路徑到剪貼簿，按鈕短暫顯示「已複製」
  copyPathToClipboard(text, button) {
    if (!text) return;
    window.api.invoke('copy-to-clipboard', text);
    if (!button) return;
    clearTimeout(button._copiedTimer);
    button.textContent = '已複製';
    button.classList.add('copied');
    button._copiedTimer = setTimeout(() => {
      button.textContent = '複製';
      button.classList.remove('copied');
    }, 1500);
  }

  hideVideoModal() {
    this.elements.videoModal.classList.add('hidden');
    this.selectedVideo = null;
  }

  renderModalTags() {
    const modalTags = document.getElementById('modal-tags');
    clearTimeout(this._tagRemoveTimer);
    modalTags.innerHTML = this._sortTags(this.selectedVideo.tags).map(tag => {
      const color = this.tagColors?.get(tag) || '#3b82f6';
      return `<span class="tag removable" data-tag="${escapeHtml(tag)}" title="點一下後再按一次即可移除" style="--tag-color: ${escapeHtml(color)};">${escapeHtml(tag)}</span>`;
    }).join('');

    // 使用事件委派綁定標籤移除事件（只綁定一次）
    // 第一下只進入待確認狀態，同一個標籤再按一次才移除，避免誤刪
    if (!this.modalTagsEventBound) {
      modalTags.addEventListener('click', (e) => {
        const tagElement = e.target.closest('.tag.removable');
        if (!tagElement) return;
        if (tagElement.classList.contains('confirm-remove')) {
          this.removeVideoTag(tagElement.dataset.tag);
        } else {
          this._armTagRemoval(tagElement);
        }
      });
      this.modalTagsEventBound = true;
    }
  }

  // 標籤進入「確定移除？」狀態；3 秒內沒再按就還原（一次只會有一個待確認）
  _armTagRemoval(tagElement) {
    const modalTags = document.getElementById('modal-tags');
    modalTags.querySelectorAll('.tag.confirm-remove').forEach(el => {
      el.classList.remove('confirm-remove');
      el.textContent = el.dataset.tag;
    });
    this._hideTagTooltip?.();
    tagElement.classList.add('confirm-remove');
    tagElement.textContent = `移除「${tagElement.dataset.tag}」？`;
    clearTimeout(this._tagRemoveTimer);
    this._tagRemoveTimer = setTimeout(() => {
      if (!tagElement.isConnected) return;
      tagElement.classList.remove('confirm-remove');
      tagElement.textContent = tagElement.dataset.tag;
    }, 3000);
  }

  async renderTagSelector() {
    try {
      // 直接使用既有快取（loadTags 已在啟動與標籤變動時更新），避免每次開彈窗都重 IPC
      if (!this.tagsByGroup) {
        await this.loadTags();
      }
      const tagsByGroup = this.tagsByGroup;
      const tagSelector = document.getElementById('tag-selector');

      if (!tagsByGroup || tagsByGroup.length === 0) {
        this._bindTagSelectorEvents(tagSelector);
        tagSelector.innerHTML = `
          <div class="tag-selector-empty">
            <p>尚無可用標籤</p>
            <p class="tag-selector-empty-hint">請先到「標籤管理」頁面建立標籤群組和標籤</p>
            <button data-action="open-tag-manager" class="btn btn-primary btn-small">開啟標籤管理</button>
          </div>
        `;
        return;
      }

      tagSelector.innerHTML = tagsByGroup.map(group => `
        <div class="tag-group-selector" data-group-name="${escapeHtml((group.name || '').toLowerCase())}">
          <div class="tag-group-header-selector">
            <div class="tag-group-color-selector" style="background-color: ${escapeHtml(group.color)};"></div>
            <div class="tag-group-name-selector">${escapeHtml(group.name)}</div>
            <span class="tag-group-count-selector"></span>
          </div>
          <div class="tags-list-selector">
            ${(group.tags || []).map(tag => `
              <div class="tag-item-selector ${this.selectedVideo.tags.includes(tag.name) ? 'selected' : ''}"
                   style="--tag-color: ${escapeHtml(tag.color || '#3b82f6')};"
                   data-tag-name="${escapeHtml(tag.name)}"
                   data-tag-name-lower="${escapeHtml((tag.name || '').toLowerCase())}">
                <div class="tag-color-selector" style="background-color: ${escapeHtml(tag.color)};"></div>
                <div class="tag-name-selector">${escapeHtml(tag.name)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');

      this._updateSelectorGroupCounts();

      // 手動輸入框的自動完成清單
      document.getElementById('tag-name-options').innerHTML = this.allTags
        .map(tag => `<option value="${escapeHtml(tag.name)}"></option>`).join('');

      // 重新渲染後重新套用目前的搜尋條件（保留使用者輸入）
      this.applyTagSearchFilter();

      this._bindTagSelectorEvents(tagSelector);
    } catch (error) {
      console.error('載入標籤選擇器錯誤:', error);
      document.getElementById('tag-selector').innerHTML = '<p>載入標籤失敗</p>';
    }
  }

  // 使用事件委派綁定標籤選擇事件（只綁定一次）
  _bindTagSelectorEvents(tagSelector) {
    if (this.tagSelectorEventBound) return;
    tagSelector.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="open-tag-manager"]')) {
        window.api.invoke('open-tag-manager');
        return;
      }
      const tagItem = e.target.closest('.tag-item-selector');
      if (tagItem) this._toggleSelectorTag(tagItem);
    });
    this.tagSelectorEventBound = true;
  }

  // 套用 / 移除選擇器中的標籤（點選或在搜尋框按 Enter）
  _toggleSelectorTag(tagItem) {
    const tagName = tagItem.dataset.tagName;
    if (tagItem.classList.contains('selected')) {
      this.removeVideoTag(tagName);
    } else {
      this.addVideoTag(tagName);
    }
    // 點選後清掉搜尋，方便接著搜下一個標籤
    this.resetTagSearch();
  }

  // 群組標題旁顯示「已選 / 總數」
  _updateSelectorGroupCounts() {
    const tagSelector = document.getElementById('tag-selector');
    if (!tagSelector || !this.selectedVideo) return;
    tagSelector.querySelectorAll('.tag-group-selector').forEach(group => {
      const counter = group.querySelector('.tag-group-count-selector');
      if (!counter) return;
      const total = group.querySelectorAll('.tag-item-selector').length;
      const selected = group.querySelectorAll('.tag-item-selector.selected').length;
      counter.textContent = selected > 0 ? `(已選 ${selected}/${total})` : `(${total})`;
    });
  }

  setModalRating(rating) {
    const modal = document.getElementById('video-modal');
    const stars = modal.querySelectorAll('.rating .star');
    stars.forEach((star, index) => {
      star.classList.toggle('active', index < rating);
    });
  }

  bindModalEvents() {
    // 如果已經綁定過，不重複綁定
    if (this.modalEventsBound) return;

    const modal = document.getElementById('video-modal');

    // 綁定星星評分事件（限定在模態框內）
    const stars = modal.querySelectorAll('.rating .star');
    stars.forEach((star, index) => {
      star.addEventListener('click', () => {
        this.setModalRating(index + 1);
      });
    });

    // 綁定按鈕事件（使用事件委派）
    const modalFooter = modal.querySelector('.modal-footer');
    modalFooter.addEventListener('click', (e) => {
      const target = e.target;
      if (target.id === 'save-changes') {
        this.saveVideoChanges();
      } else if (target.id === 'generate-thumbnail') {
        this.showThumbnailSecondsMenu(target, (seconds) => {
          this.generateThumbnailManually(seconds);
        });
      } else if (target.id === 'delete-video') {
        this.deleteVideo();
      } else if (target.id === 'delete-video-file') {
        this.deleteVideoWithFile();
      } else if (target.id === 'open-file') {
        this.openVideoFile();
      } else if (target.id === 'upload-subtitle') {
        this.uploadSubtitle();
      }
    });

    // 複製檔案名稱
    const copyFilenameBtn = document.getElementById('copy-filename');
    copyFilenameBtn.addEventListener('click', () => {
      if (this.selectedVideo) this.copyPathToClipboard(this.selectedVideo.filename, copyFilenameBtn);
    });

    // 複製檔案路徑
    const copyFilepathBtn = document.getElementById('copy-filepath');
    copyFilepathBtn.addEventListener('click', () => {
      if (this.selectedVideo) this.copyPathToClipboard(this.selectedVideo.filepath, copyFilepathBtn);
    });

    // 綁定新增標籤按鈕
    const addTagBtn = document.getElementById('add-tag-btn');
    addTagBtn.addEventListener('click', () => {
      this.addVideoTag();
    });

    // 綁定輸入框 Enter 鍵
    const newTagInput = document.getElementById('new-tag-input');
    newTagInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.addVideoTag();
      }
    });

    // 綁定標籤搜尋框
    const tagSearchInput = document.getElementById('tag-search-input');
    const tagSearchClear = document.getElementById('tag-search-clear');
    if (tagSearchInput) {
      tagSearchInput.addEventListener('input', () => {
        tagSearchClear.classList.toggle('hidden', !tagSearchInput.value);
        this.applyTagSearchFilter();
      });
      // Enter：套用 / 移除第一個符合的標籤（注音等輸入法選字中的 Enter 不算）
      tagSearchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        if (!tagSearchInput.value.trim()) return;
        const first = document.querySelector(
          '#tag-selector .tag-group-selector:not(.hidden) .tag-item-selector:not(.hidden)');
        if (!first) return;
        e.preventDefault();
        this._toggleSelectorTag(first);
      });
    }
    if (tagSearchClear) {
      tagSearchClear.addEventListener('click', () => this.resetTagSearch());
    }

    this.modalEventsBound = true;
  }

  // 清空標籤搜尋並顯示全部標籤；沒有搜尋條件時不動作
  resetTagSearch() {
    const tagSearchInput = document.getElementById('tag-search-input');
    if (!tagSearchInput || !tagSearchInput.value) return;
    tagSearchInput.value = '';
    document.getElementById('tag-search-clear').classList.add('hidden');
    this.applyTagSearchFilter();
    tagSearchInput.focus();
  }

  applyTagSearchFilter() {
    const tagSelector = document.getElementById('tag-selector');
    const tagSearchInput = document.getElementById('tag-search-input');
    if (!tagSelector || !tagSearchInput) return;

    const keyword = tagSearchInput.value.trim().toLowerCase();

    // 移除前次的「無結果」提示
    const prevEmpty = tagSelector.querySelector('.tag-search-empty');
    if (prevEmpty) prevEmpty.remove();

    const groups = tagSelector.querySelectorAll('.tag-group-selector');

    if (!keyword) {
      groups.forEach(group => {
        group.classList.remove('hidden');
        group.querySelectorAll('.tag-item-selector').forEach(item => item.classList.remove('hidden'));
      });
      return;
    }

    let totalVisible = 0;
    groups.forEach(group => {
      const groupName = group.dataset.groupName || '';
      const groupMatch = groupName.includes(keyword);
      let groupVisibleCount = 0;

      group.querySelectorAll('.tag-item-selector').forEach(item => {
        const tagName = item.dataset.tagNameLower || '';
        // 群組名稱命中時顯示該群組所有標籤；否則只顯示名稱命中的標籤
        const match = groupMatch || tagName.includes(keyword);
        item.classList.toggle('hidden', !match);
        if (match) groupVisibleCount++;
      });

      group.classList.toggle('hidden', groupVisibleCount === 0);
      totalVisible += groupVisibleCount;
    });

    if (totalVisible === 0) {
      const empty = document.createElement('div');
      empty.className = 'tag-search-empty';
      empty.textContent = `找不到符合「${keyword}」的標籤`;
      tagSelector.appendChild(empty);
    }
  }

  async addVideoTag(tagName = null) {
    let actualTagName;
    let needsCreate = false;

    if (tagName) {
      actualTagName = tagName;
    } else {
      const tagInput = document.getElementById('new-tag-input');
      actualTagName = tagInput.value.trim();

      if (!actualTagName) return;

      tagInput.value = '';

      // 只差大小寫的既有標籤沿用原名；真正的新名稱要先建立標籤，
      // 否則只有關聯、沒有標籤資料，不會出現在篩選列與標籤管理
      const lower = actualTagName.toLowerCase();
      const existing = this.allTags.find(t => (t.name || '').toLowerCase() === lower);
      if (existing) {
        actualTagName = existing.name;
      } else {
        needsCreate = true;
      }
    }

    // 檢查標籤是否已存在
    if (this.selectedVideo.tags.includes(actualTagName)) return;

    try {
      // 只使用基於指紋的新方法
      if (!this.selectedVideo.fingerprint) {
        throw new Error('影片缺少 fingerprint，無法添加標籤');
      }

      if (needsCreate) {
        // 不指定群組 → 歸入「未分類」，之後可到標籤管理調整
        const created = await window.api.invoke('create-tag', { name: actualTagName });
        if (!created || !created.success) {
          throw new Error(created?.error || '建立標籤失敗');
        }
      }

      const result = await window.api.invoke('add-video-tag', this.selectedVideo.fingerprint, actualTagName);
      if (!result || !result.success) {
        throw new Error(result?.error || '新增標籤失敗');
      }

      this.selectedVideo.tags.push(actualTagName);

      // 同步更新當前影片列表中的數據
      const videoIndex = this.currentVideos.findIndex(v => v.id === this.selectedVideo.id);
      if (videoIndex >= 0) {
        this.currentVideos[videoIndex].tags = [...this.selectedVideo.tags];
      }

      this.renderModalTags();
      this.updateTagSelectorState();
      this.updateVideoTagsDisplay(this.selectedVideo.id);
      await this.loadTags();
      this.renderTagsFilter();
    } catch (error) {
      console.error('新增標籤錯誤:', error);
      alert(`新增標籤失敗：${error.message}`);
    }
  }

  async removeVideoTag(tagName) {
    try {
      // 只使用基於指紋的新方法
      if (!this.selectedVideo.fingerprint) {
        throw new Error('影片缺少 fingerprint，無法移除標籤');
      }

      const result = await window.api.invoke('remove-video-tag', this.selectedVideo.fingerprint, tagName);
      if (!result || !result.success) {
        throw new Error(result?.error || '移除標籤失敗');
      }

      this.selectedVideo.tags = this.selectedVideo.tags.filter(tag => tag !== tagName);

      // 同步更新當前影片列表中的數據
      const videoIndex = this.currentVideos.findIndex(v => v.id === this.selectedVideo.id);
      if (videoIndex >= 0) {
        this.currentVideos[videoIndex].tags = [...this.selectedVideo.tags];
      }

      this.renderModalTags();
      this.updateTagSelectorState();
      this.updateVideoTagsDisplay(this.selectedVideo.id);
      await this.loadTags();
      this.renderTagsFilter();
    } catch (error) {
      console.error('移除標籤錯誤:', error);
      alert(`移除標籤失敗：${error.message}`);
    }
  }

  updateTagSelectorState() {
    // 更新標籤選擇器中的選中狀態
    const tagSelector = document.getElementById('tag-selector');
    if (!tagSelector) return;

    tagSelector.querySelectorAll('.tag-item-selector').forEach(tagItem => {
      const tagName = tagItem.dataset.tagName;
      const isSelected = this.selectedVideo.tags.includes(tagName);
      tagItem.classList.toggle('selected', isSelected);
    });
    this._updateSelectorGroupCounts();
  }

  updateVideoTagsDisplay(videoId) {
    // 更新首頁影片卡片的標籤顯示，不重新加載圖片
    const videoCard = document.querySelector(`[data-video-id="${CSS.escape(String(videoId))}"]`);
    if (!videoCard) return;

    const video = this.currentVideos.find(v => v.id === videoId);
    if (!video) return;

    const tagsElement = videoCard.querySelector('.video-tags');
    if (videoCard.classList.contains('video-card')) {
      this.fitCardTags(videoCard, video);
    } else if (tagsElement) {
      tagsElement.innerHTML = this._videoTagsHtml(video);
    }
  }

  async saveVideoChanges() {
    const description = document.getElementById('modal-description').value;
    const rating = document.querySelectorAll('#video-modal .rating .star.active').length;

    try {
      // 使用基於指紋的新方法來儲存評分和描述
      if (this.selectedVideo.fingerprint) {
        await window.api.invoke('set-video-metadata', this.selectedVideo.fingerprint, {
          description,
          rating
        });
      } else {
        // 回退到舊方法（向後兼容）
        await window.api.invoke('update-video', this.selectedVideo.id, {
          description,
          rating
        });
      }

      this.selectedVideo.description = description;
      this.selectedVideo.rating = rating;

      // 更新當前影片數據在影片列表中
      const videoIndex = this.currentVideos.findIndex(v => v.id === this.selectedVideo.id);
      if (videoIndex >= 0) {
        this.currentVideos[videoIndex] = { ...this.selectedVideo };
      }

      this.hideVideoModal();

      // 只重新載入標籤過濾器，不重新載入整個影片列表
      await this.loadTags();
      this.renderTagsFilter();
    } catch (error) {
      console.error('儲存變更錯誤:', error);
    }
  }

  async deleteVideo() {
    if (!confirm('確定要刪除這個影片記錄嗎？（不會刪除實際檔案）')) {
      return;
    }

    try {
      await window.api.invoke('delete-video', this.selectedVideo.id);
      this.hideVideoModal();
      // 保持搜尋條件重新載入
      await this.refreshCurrentView();
    } catch (error) {
      console.error('刪除影片錯誤:', error);
    }
  }

  async deleteVideoWithFile() {
    const filename = this.selectedVideo.filename;

    try {
      // 使用 Electron 原生對話框進行確認
      const confirmation = await window.api.invoke('show-delete-confirmation', filename);

      if (!confirmation.confirmed) {
        if (!confirmation.checkboxChecked) {
          alert('請勾選確認選項才能執行刪除操作');
        }
        return;
      }

      const result = await window.api.invoke('delete-video-with-file', this.selectedVideo.id);

      if (result.success) {
        const { recordDeleted, fileDeleted, folderDeleted, folderDeleteError, error } = result.result;

        if (recordDeleted && fileDeleted) {
          let message = '影片記錄和檔案已成功刪除';
          if (folderDeleted) {
            message += '\n資料夾已清空並刪除';
          } else if (folderDeleteError) {
            message += `\n資料夾刪除失敗：${folderDeleteError}`;
          }
          alert(message);
        } else if (!fileDeleted) {
          // 檔案刪不掉就保留記錄，避免留下無從追查的殘留檔案
          alert(`檔案刪除失敗，已保留影片記錄：\n${error}\n\n若只想移除記錄，請改用「刪除記錄」。`);
          return;
        }

        this.hideVideoModal();
        // 保持搜尋條件重新載入
        await this.refreshCurrentView();
      } else {
        alert(`刪除失敗：${result.error}`);
      }
    } catch (error) {
      console.error('刪除影片和檔案錯誤:', error);
      alert(`刪除過程中發生錯誤：${error.message}`);
    }
  }

  renderModalPlayStats() {
    const video = this.selectedVideo;
    const count = Number(video.play_count) || 0;
    document.getElementById('modal-play-stats').textContent = count === 0
      ? '尚未開啟過'
      : `${count} 次・最後開啟 ${video.last_played_at ? new Date(video.last_played_at).toLocaleString() : '未知'}`;
  }

  async openVideoFile() {
    const video = this.selectedVideo;
    if (!video) return;
    const result = await window.api.invoke('open-path', video.filepath);
    if (result && result.success && result.playStats) {
      video.play_count = result.playStats.play_count;
      video.last_played_at = result.playStats.last_played_at;
      if (this.selectedVideo === video) this.renderModalPlayStats();
      this.updateVideoPlayCount(video);
    } else if (result && !result.success) {
      alert(`無法開啟影片：${result.error}`);
    }
  }

  async uploadSubtitle() {
    if (!this.selectedVideo) {
      alert('請先選擇一個影片');
      return;
    }

    const btn = document.getElementById('upload-subtitle');
    const originalText = btn ? btn.textContent : '';
    try {
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ 上傳中...';
      }

      const result = await window.api.invoke('upload-subtitle', this.selectedVideo.filepath);

      if (result.success) {
        alert(`字幕上傳成功！\n${result.targetPath}`);
      } else if (!result.canceled) {
        alert(`字幕上傳失敗：${result.error}`);
      }
    } catch (error) {
      console.error('上傳字幕錯誤:', error);
      alert(`上傳字幕時發生錯誤：${error.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }
}

export default VideoModalMethods;
