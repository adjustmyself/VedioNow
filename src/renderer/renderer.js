const { ipcRenderer } = require('electron');
const { shell } = require('electron');

class VideoManager {
  constructor() {
    this.currentVideos = [];
    this.allTags = [];
    this.activeTags = new Set();
    this.currentSort = 'created_at';
    this.sortOrder = 'desc';
    this.viewMode = 'grid';
    this.selectedVideo = null;

    this.initializeElements();
    this.bindEvents();
    this.loadData();
  }

  initializeElements() {
    this.elements = {
      tagManagerBtn: document.getElementById('tag-manager-btn'),
      scanBtn: document.getElementById('scan-btn'),
      searchInput: document.getElementById('search-input'),
      tagsFilter: document.getElementById('tags-filter'),
      videosContainer: document.getElementById('videos-container'),
      totalVideos: document.getElementById('total-videos'),
      totalTags: document.getElementById('total-tags'),
      loading: document.getElementById('loading'),
      emptyState: document.getElementById('empty-state'),
      gridViewBtn: document.getElementById('grid-view'),
      listViewBtn: document.getElementById('list-view'),
      sortSelect: document.getElementById('sort-select'),
      sortOrderBtn: document.getElementById('sort-order'),
      videoModal: document.getElementById('video-modal'),
      scanModal: document.getElementById('scan-modal'),
      modalClose: document.getElementById('modal-close'),
      scanModalClose: document.getElementById('scan-modal-close'),
      folderPath: document.getElementById('folder-path'),
      browseFolder: document.getElementById('browse-folder'),
      startScan: document.getElementById('start-scan'),
      cancelScan: document.getElementById('cancel-scan'),
      recursiveScan: document.getElementById('recursive-scan'),
      watchChanges: document.getElementById('watch-changes'),
      scanProgress: document.getElementById('scan-progress'),
      scanStatus: document.getElementById('scan-status')
    };
  }

  bindEvents() {
    this.elements.tagManagerBtn.addEventListener('click', () => this.openTagManager());
    this.elements.scanBtn.addEventListener('click', () => this.showScanModal());
    this.elements.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
    this.elements.gridViewBtn.addEventListener('click', () => this.setViewMode('grid'));
    this.elements.listViewBtn.addEventListener('click', () => this.setViewMode('list'));
    this.elements.sortSelect.addEventListener('change', (e) => this.setSortField(e.target.value));
    this.elements.sortOrderBtn.addEventListener('click', () => this.toggleSortOrder());
    this.elements.modalClose.addEventListener('click', () => this.hideVideoModal());
    this.elements.scanModalClose.addEventListener('click', () => this.hideScanModal());
    this.elements.browseFolder.addEventListener('click', () => this.selectFolder());
    this.elements.startScan.addEventListener('click', () => this.startScan());
    this.elements.cancelScan.addEventListener('click', () => this.hideScanModal());

    document.addEventListener('click', (e) => {
      if (e.target === this.elements.videoModal) {
        this.hideVideoModal();
      }
      if (e.target === this.elements.scanModal) {
        this.hideScanModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideVideoModal();
        this.hideScanModal();
      }
    });
  }

  async loadData() {
    this.showLoading();
    try {
      await Promise.all([
        this.loadVideos(),
        this.loadTags()
      ]);
      this.updateStats();
      this.renderVideos();
      this.renderTagsFilter();
    } catch (error) {
      console.error('載入資料錯誤:', error);
    } finally {
      this.hideLoading();
    }
  }

  async loadVideos() {
    this.currentVideos = await ipcRenderer.invoke('get-videos');
  }

  async loadTags() {
    this.tagsByGroup = await ipcRenderer.invoke('get-tags-by-group');
    // 展平標籤用於統計
    this.allTags = [];
    this.tagsByGroup.forEach(group => {
      this.allTags.push(...group.tags);
    });
    console.log('載入的標籤群組:', this.tagsByGroup);
    console.log('所有標籤:', this.allTags);
  }

  async handleSearch(searchTerm) {
    this.showLoading();
    try {
      const activeTagsArray = Array.from(this.activeTags);
      this.currentVideos = await ipcRenderer.invoke('search-videos', searchTerm, activeTagsArray);
      this.updateStats();
      this.renderVideos();
    } catch (error) {
      console.error('搜尋錯誤:', error);
    } finally {
      this.hideLoading();
    }
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.elements.gridViewBtn.classList.toggle('active', mode === 'grid');
    this.elements.listViewBtn.classList.toggle('active', mode === 'list');
    this.elements.videosContainer.className = mode === 'grid' ? 'videos-grid' : 'videos-list';
    this.renderVideos();
  }

  setSortField(field) {
    this.currentSort = field;
    this.sortVideos();
    this.renderVideos();
  }

  toggleSortOrder() {
    this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
    this.elements.sortOrderBtn.textContent = this.sortOrder === 'desc' ? '降序' : '升序';
    this.sortVideos();
    this.renderVideos();
  }

  sortVideos() {
    this.currentVideos.sort((a, b) => {
      let valueA = a[this.currentSort];
      let valueB = b[this.currentSort];

      if (typeof valueA === 'string') {
        valueA = valueA.toLowerCase();
        valueB = valueB.toLowerCase();
      }

      if (this.sortOrder === 'desc') {
        return valueA > valueB ? -1 : valueA < valueB ? 1 : 0;
      } else {
        return valueA < valueB ? -1 : valueA > valueB ? 1 : 0;
      }
    });
  }

  renderVideos() {
    if (this.currentVideos.length === 0) {
      this.elements.videosContainer.style.display = 'none';
      this.elements.emptyState.classList.remove('hidden');
      return;
    }

    this.elements.emptyState.classList.add('hidden');
    this.elements.videosContainer.style.display = this.viewMode === 'grid' ? 'grid' : 'block';

    this.elements.videosContainer.innerHTML = this.currentVideos.map(video =>
      this.viewMode === 'grid' ? this.createVideoCard(video) : this.createVideoListItem(video)
    ).join('');

    this.bindVideoEvents();
  }

  createVideoCard(video) {
    const tags = video.tags && video.tags.length > 0
      ? video.tags.map(tag => `<span class="tag">${tag}</span>`).join('')
      : '<span class="no-tags">無標籤</span>';

    const filename = video.filename || '未知檔名';
    const filesize = this.formatFileSize(video.filesize);
    const createdDate = video.created_at
      ? new Date(video.created_at).toLocaleDateString()
      : '未知日期';

    return `
      <div class="video-card" data-video-id="${video.id}">
        <div class="video-thumbnail" data-filepath="${video.filepath}">
          <video class="thumbnail-video" preload="metadata" muted>
            <source src="${video.filepath}">
          </video>
          <div class="thumbnail-fallback">
            <span>🎬</span>
          </div>
        </div>
        <div class="video-card-content">
          <div class="video-title" title="${filename}">${filename}</div>
          <div class="video-meta">
            ${filesize} • ${createdDate}
          </div>
          <div class="video-tags">${tags}</div>
        </div>
      </div>
    `;
  }

  createVideoListItem(video) {
    const tags = video.tags && video.tags.length > 0
      ? video.tags.map(tag => `<span class="tag">${tag}</span>`).join('')
      : '<span class="no-tags">無標籤</span>';

    const filename = video.filename || '未知檔名';
    const filesize = this.formatFileSize(video.filesize);
    const createdDate = video.created_at
      ? new Date(video.created_at).toLocaleDateString()
      : '未知日期';

    return `
      <div class="video-list-item" data-video-id="${video.id}">
        <div class="video-list-thumbnail" data-filepath="${video.filepath}">
          <video class="thumbnail-video-small" preload="metadata" muted>
            <source src="${video.filepath}">
          </video>
          <div class="thumbnail-fallback-small">
            <span>🎬</span>
          </div>
        </div>
        <div class="video-list-content">
          <div class="video-title">${filename}</div>
          <div class="video-meta">
            ${filesize} • ${createdDate}
          </div>
          <div class="video-tags">${tags}</div>
        </div>
      </div>
    `;
  }

  bindVideoEvents() {
    const videoElements = this.elements.videosContainer.querySelectorAll('[data-video-id]');
    videoElements.forEach(element => {
      element.addEventListener('click', () => {
        const videoId = parseInt(element.dataset.videoId);
        this.showVideoModal(videoId);
      });
    });

    this.setupThumbnails();
  }

  setupThumbnails() {
    const thumbnailVideos = this.elements.videosContainer.querySelectorAll('.thumbnail-video, .thumbnail-video-small');

    thumbnailVideos.forEach(video => {
      video.addEventListener('loadeddata', () => {
        video.currentTime = 10;
      });

      video.addEventListener('seeked', () => {
        video.style.opacity = '1';
        const fallback = video.nextElementSibling;
        if (fallback) {
          fallback.style.display = 'none';
        }
      });

      video.addEventListener('error', () => {
        video.style.display = 'none';
        const fallback = video.nextElementSibling;
        if (fallback) {
          fallback.style.display = 'flex';
        }
      });

      video.style.opacity = '0';
      video.style.transition = 'opacity 0.3s';
    });
  }

  renderTagsFilter() {
    console.log('渲染標籤篩選器，群組數量:', this.tagsByGroup.length);
    console.log('標籤群組詳情:', this.tagsByGroup);

    if (this.tagsByGroup.length === 0) {
      this.elements.tagsFilter.innerHTML = `
        <div class="no-tags-container">
          <span class="no-tags">尚無標籤</span>
          <p class="no-tags-hint">點選上方「標籤管理」開始建立標籤</p>
        </div>
      `;
      return;
    }

    this.elements.tagsFilter.innerHTML = this.tagsByGroup.map(group => `
      <div class="tag-group-filter">
        <div class="tag-group-header">
          <span class="tag-group-color" style="background-color: ${group.color};"></span>
          <span class="tag-group-name">${group.name}</span>
          <span class="tag-group-count">(${group.tags.length})</span>
        </div>
        <div class="tag-group-tags">
          ${group.tags.map(tag =>
            `<span class="tag ${this.activeTags.has(tag.name) ? 'active' : ''}"
                   data-tag="${tag.name}"
                   style="--tag-color: ${tag.color};">
              ${tag.name} (${tag.video_count})
            </span>`
          ).join('')}
        </div>
      </div>
    `).join('');

    this.bindTagEvents();
  }

  bindTagEvents() {
    const tagElements = this.elements.tagsFilter.querySelectorAll('.tag');
    tagElements.forEach(element => {
      element.addEventListener('click', () => {
        const tagName = element.dataset.tag;
        this.toggleTagFilter(tagName);
      });
    });
  }

  toggleTagFilter(tagName) {
    if (this.activeTags.has(tagName)) {
      this.activeTags.delete(tagName);
    } else {
      this.activeTags.add(tagName);
    }
    this.renderTagsFilter();
    this.handleSearch(this.elements.searchInput.value);
  }

  showVideoModal(videoId) {
    this.selectedVideo = this.currentVideos.find(v => v.id === videoId);
    if (!this.selectedVideo) return;

    document.getElementById('modal-filename').textContent = this.selectedVideo.filename;
    document.getElementById('modal-filepath').textContent = this.selectedVideo.filepath;
    document.getElementById('modal-filesize').textContent = this.formatFileSize(this.selectedVideo.filesize);
    document.getElementById('modal-created').textContent = new Date(this.selectedVideo.created_at).toLocaleString();
    document.getElementById('modal-description').value = this.selectedVideo.description || '';

    this.renderModalTags();
    this.renderTagSelector();
    this.setModalRating(this.selectedVideo.rating || 0);
    this.bindModalEvents();

    this.elements.videoModal.classList.remove('hidden');
  }

  hideVideoModal() {
    this.elements.videoModal.classList.add('hidden');
    this.selectedVideo = null;
  }

  renderModalTags() {
    const modalTags = document.getElementById('modal-tags');
    modalTags.innerHTML = this.selectedVideo.tags.map(tag =>
      `<span class="tag removable" data-tag="${tag}">${tag}</span>`
    ).join('');

    modalTags.querySelectorAll('.tag').forEach(element => {
      element.addEventListener('click', () => {
        this.removeVideoTag(element.dataset.tag);
      });
    });
  }

  async renderTagSelector() {
    try {
      const tagsByGroup = await ipcRenderer.invoke('get-tags-by-group');
      const tagSelector = document.getElementById('tag-selector');

      console.log('載入的標籤群組數據:', tagsByGroup);

      if (!tagsByGroup || tagsByGroup.length === 0) {
        tagSelector.innerHTML = `
          <div style="text-align: center; padding: 1rem; color: #666;">
            <p>尚無可用標籤</p>
            <p style="font-size: 0.8rem;">請先到「標籤管理」頁面建立標籤群組和標籤</p>
            <button onclick="ipcRenderer.invoke('open-tag-manager')" style="margin-top: 0.5rem; padding: 0.25rem 0.5rem; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">
              開啟標籤管理
            </button>
          </div>
        `;
        return;
      }

      tagSelector.innerHTML = tagsByGroup.map(group => `
        <div class="tag-group-selector">
          <div class="tag-group-header-selector">
            <div class="tag-group-color-selector" style="background-color: ${group.color};"></div>
            <div class="tag-group-name-selector">${group.name}</div>
          </div>
          <div class="tags-list-selector">
            ${group.tags.map(tag => `
              <div class="tag-item-selector ${this.selectedVideo.tags.includes(tag.name) ? 'selected' : ''}"
                   data-tag-name="${tag.name}">
                <div class="tag-color-selector" style="background-color: ${tag.color};"></div>
                <div class="tag-name-selector">${tag.name}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');

      // 綁定標籤選擇事件
      tagSelector.querySelectorAll('.tag-item-selector').forEach(tagItem => {
        tagItem.addEventListener('click', () => {
          const tagName = tagItem.dataset.tagName;
          if (tagItem.classList.contains('selected')) {
            this.removeVideoTag(tagName);
          } else {
            this.addVideoTag(tagName);
          }
        });
      });
    } catch (error) {
      console.error('載入標籤選擇器錯誤:', error);
      document.getElementById('tag-selector').innerHTML = '<p>載入標籤失敗</p>';
    }
  }

  setModalRating(rating) {
    const stars = document.querySelectorAll('.star');
    stars.forEach((star, index) => {
      star.classList.toggle('active', index < rating);
    });
  }

  bindModalEvents() {
    // 移除舊的事件監聽器
    const addTagBtn = document.getElementById('add-tag-btn');
    const newTagInput = document.getElementById('new-tag-input');
    const saveChangesBtn = document.getElementById('save-changes');
    const deleteVideoBtn = document.getElementById('delete-video');
    const openFileBtn = document.getElementById('open-file');

    // 克隆元素來移除所有事件監聽器
    addTagBtn.replaceWith(addTagBtn.cloneNode(true));
    newTagInput.replaceWith(newTagInput.cloneNode(true));
    saveChangesBtn.replaceWith(saveChangesBtn.cloneNode(true));
    deleteVideoBtn.replaceWith(deleteVideoBtn.cloneNode(true));
    openFileBtn.replaceWith(openFileBtn.cloneNode(true));

    // 重新獲取元素引用
    const newAddTagBtn = document.getElementById('add-tag-btn');
    const newNewTagInput = document.getElementById('new-tag-input');
    const newSaveChangesBtn = document.getElementById('save-changes');
    const newDeleteVideoBtn = document.getElementById('delete-video');
    const newOpenFileBtn = document.getElementById('open-file');

    // 綁定星星評分事件
    const stars = document.querySelectorAll('.star');
    stars.forEach((star, index) => {
      star.addEventListener('click', () => {
        this.setModalRating(index + 1);
      });
    });

    // 綁定新的事件監聽器
    newAddTagBtn.addEventListener('click', () => {
      this.addVideoTag();
    });

    newNewTagInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.addVideoTag();
      }
    });

    newSaveChangesBtn.addEventListener('click', () => {
      this.saveVideoChanges();
    });

    newDeleteVideoBtn.addEventListener('click', () => {
      this.deleteVideo();
    });

    newOpenFileBtn.addEventListener('click', () => {
      this.openVideoFile();
    });
  }

  async addVideoTag(tagName = null) {
    let actualTagName;

    if (tagName) {
      actualTagName = tagName;
    } else {
      const tagInput = document.getElementById('new-tag-input');
      actualTagName = tagInput.value.trim();

      if (!actualTagName) return;

      tagInput.value = '';
    }

    // 檢查標籤是否已存在
    if (this.selectedVideo.tags.includes(actualTagName)) return;

    try {
      await ipcRenderer.invoke('add-tag', this.selectedVideo.id, actualTagName);
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
    }
  }

  async removeVideoTag(tagName) {
    try {
      await ipcRenderer.invoke('remove-tag', this.selectedVideo.id, tagName);
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
  }

  updateVideoTagsDisplay(videoId) {
    // 更新首頁影片卡片的標籤顯示，不重新加載圖片
    const videoCard = document.querySelector(`[data-video-id="${videoId}"]`);
    if (!videoCard) return;

    const video = this.currentVideos.find(v => v.id === videoId);
    if (!video) return;

    const tagsElement = videoCard.querySelector('.video-tags');
    if (tagsElement) {
      const tags = video.tags && video.tags.length > 0
        ? video.tags.map(tag => `<span class="tag">${tag}</span>`).join('')
        : '<span class="no-tags">無標籤</span>';
      tagsElement.innerHTML = tags;
    }
  }

  async saveVideoChanges() {
    const description = document.getElementById('modal-description').value;
    const rating = document.querySelectorAll('.star.active').length;

    try {
      await ipcRenderer.invoke('update-video', this.selectedVideo.id, {
        description,
        rating
      });

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
      await ipcRenderer.invoke('delete-video', this.selectedVideo.id);
      this.hideVideoModal();
      await this.loadData();
    } catch (error) {
      console.error('刪除影片錯誤:', error);
    }
  }

  openVideoFile() {
    if (this.selectedVideo) {
      shell.openPath(this.selectedVideo.filepath);
    }
  }

  showScanModal() {
    this.elements.scanModal.classList.remove('hidden');
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

    this.elements.scanProgress.classList.remove('hidden');
    this.elements.scanStatus.textContent = '正在掃描...';

    try {
      const result = await ipcRenderer.invoke('scan-videos', folderPath);
      if (result.success) {
        this.elements.scanStatus.textContent = `掃描完成！找到 ${result.videos.length} 個影片檔案`;
        setTimeout(() => {
          this.hideScanModal();
          this.loadData();
        }, 2000);
      } else {
        this.elements.scanStatus.textContent = `掃描失敗: ${result.error}`;
      }
    } catch (error) {
      console.error('掃描錯誤:', error);
      this.elements.scanStatus.textContent = `掃描錯誤: ${error.message}`;
    }
  }

  updateStats() {
    this.elements.totalVideos.textContent = this.currentVideos.length;
    this.elements.totalTags.textContent = this.allTags.length;
  }

  showLoading() {
    this.elements.loading.classList.remove('hidden');
    this.elements.videosContainer.style.display = 'none';
    this.elements.emptyState.classList.add('hidden');
  }

  hideLoading() {
    this.elements.loading.classList.add('hidden');
  }

  async openTagManager() {
    try {
      await ipcRenderer.invoke('open-tag-manager');
      // 當標籤管理器關閉後，重新載入標籤資料
      setTimeout(() => {
        this.loadTags().then(() => {
          this.renderTagsFilter();
          this.updateStats();
        });
      }, 1000);
    } catch (error) {
      console.error('開啟標籤管理器錯誤:', error);
    }
  }

  formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new VideoManager();
});