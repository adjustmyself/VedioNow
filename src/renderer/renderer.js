const { ipcRenderer } = require('electron');
const { shell } = require('electron');

class VideoManager {
  constructor() {
    this.currentVideos = [];
    this.allTags = [];
    this.activeTags = new Set();
    this.selectedRating = 0; // 0 表示全部
    this.selectedDrivePath = ''; // 選中的硬碟路徑
    this.currentSort = 'file_created_at';
    this.sortOrder = 'desc';
    this.viewMode = 'grid';
    this.selectedVideo = null;
    this.loadingThumbnails = new Set(); // 追蹤正在載入的縮圖
    // 分頁相關狀態
    this.currentPage = 1;
    this.pageSize = 9;
    this.totalVideos = 0;
    this.totalPages = 0;
    // 事件綁定標誌，避免重複綁定
    this.modalEventsBound = false;
    this.tagSelectorEventBound = false;
    this.modalTagsEventBound = false;
    this.episodePlayEventBound = false;

    this.initializeElements();
    this.bindEvents();
    this.loadData();
  }

  initializeElements() {
    this.elements = {
      tagManagerBtn: document.getElementById('tag-manager-btn'),
      settingsBtn: document.getElementById('settings-btn'),
      scanBtn: document.getElementById('scan-btn'),
      searchInput: document.getElementById('search-input'),
      driveFilterSelect: document.getElementById('drive-filter-select'),
      tagsFilter: document.getElementById('tags-filter'),
      resetTagsBtn: document.getElementById('reset-tags-btn'),
      resetAllBtn: document.getElementById('reset-all-btn'),
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
      cleanupMissing: document.getElementById('cleanup-missing'),
      scanDateFilterAll: document.getElementById('scan-range-all'),
      scanDateFilterWeek: document.getElementById('scan-range-week'),
      scanDateFilterMonth: document.getElementById('scan-range-month'),
      scanProgress: document.getElementById('scan-progress'),
      scanStatus: document.getElementById('scan-status'),
      scanPhase: document.getElementById('scan-phase'),
      scanCounter: document.getElementById('scan-counter'),
      scanPercentage: document.getElementById('scan-percentage'),
      progressFill: document.getElementById('progress-fill'),
      currentFile: document.getElementById('current-file'),
      // 合集相關元素
      createCollectionBtn: document.getElementById('create-collection-btn'),
      removeCollectionBtn: document.getElementById('remove-collection-btn'),
      collectionSelectModal: document.getElementById('collection-select-modal'),
      collectionSelectClose: document.getElementById('collection-select-close'),
      confirmCollection: document.getElementById('confirm-collection'),
      cancelCollection: document.getElementById('cancel-collection'),
      collectionFolderPath: document.getElementById('collection-folder-path'),
      folderVideoCount: document.getElementById('folder-video-count'),
      collectionNameNew: document.getElementById('collection-name-new'),
      mainVideoSelect: document.getElementById('main-video-select'),
      childVideosList: document.getElementById('child-videos-list'),
      collectionList: document.getElementById('collection-list'),
      collectionEpisodes: document.getElementById('collection-episodes')
    };
  }

  bindEvents() {
    this.elements.tagManagerBtn.addEventListener('click', () => this.openTagManager());
    this.elements.settingsBtn.addEventListener('click', () => this.openSettings());
    this.elements.scanBtn.addEventListener('click', () => this.showScanModal());
    this.elements.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
    this.elements.driveFilterSelect.addEventListener('change', (e) => this.handleDriveFilterChange(e.target.value));
    this.elements.resetTagsBtn.addEventListener('click', () => this.resetTagsFilter());
    this.elements.resetAllBtn.addEventListener('click', () => this.resetAllFilters());
    this.elements.gridViewBtn.addEventListener('click', () => this.setViewMode('grid'));
    this.elements.listViewBtn.addEventListener('click', () => this.setViewMode('list'));
    this.elements.sortSelect.addEventListener('change', (e) => this.setSortField(e.target.value));
    this.elements.sortOrderBtn.addEventListener('click', () => this.toggleSortOrder());
    this.elements.modalClose.addEventListener('click', () => this.hideVideoModal());
    this.elements.scanModalClose.addEventListener('click', () => this.hideScanModal());
    this.elements.browseFolder.addEventListener('click', () => this.selectFolder());
    this.elements.startScan.addEventListener('click', () => this.startScan());
    this.elements.cancelScan.addEventListener('click', () => this.hideScanModal());
    this.bindRatingFilterEvents();

    // 合集相關事件
    this.elements.createCollectionBtn?.addEventListener('click', () => this.showCollectionModal());
    this.elements.removeCollectionBtn?.addEventListener('click', () => this.removeCollection());
    this.elements.collectionSelectClose?.addEventListener('click', () => this.hideCollectionModal());
    this.elements.confirmCollection?.addEventListener('click', () => this.confirmCreateCollection());
    this.elements.cancelCollection?.addEventListener('click', () => this.hideCollectionModal());

    // 監聽掃描進度
    ipcRenderer.on('scan-progress', (event, progressData) => {
      this.updateScanProgress(progressData);
    });

    document.addEventListener('click', (e) => {
      if (e.target === this.elements.videoModal) {
        this.hideVideoModal();
      }
      if (e.target === this.elements.scanModal) {
        this.hideScanModal();
      }
      if (e.target === this.elements.collectionSelectModal) {
        this.hideCollectionModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideVideoModal();
        this.hideScanModal();
        this.hideCollectionModal();
      }
    });
  }


  async loadData() {
    this.showLoading();
    try {
      await Promise.all([
        this.loadVideos(),
        this.loadTags(),
        this.loadDrivePaths()
      ]);
      this.updateStats();
      this.renderVideos();
      this.renderTagsFilter();
      this.renderPagination();
    } catch (error) {
      console.error('載入資料錯誤:', error);
    } finally {
      this.hideLoading();
    }
  }

  async refreshCurrentView() {
    // 保持當前搜尋條件重新載入資料
    const searchTerm = this.elements.searchInput.value.trim();

    // 重新載入標籤和硬碟路徑列表
    await Promise.all([
      this.loadTags(),
      this.loadDrivePaths()
    ]);

    // 如果有搜尋條件或篩選，使用 handleSearch 保持條件
    if (searchTerm || this.activeTags.size > 0 || this.selectedRating > 0 || this.selectedDrivePath) {
      await this.handleSearch(searchTerm);
    } else {
      // 沒有任何條件，直接載入
      await this.loadVideos();
      this.renderVideos();
      this.renderPagination();
    }

    this.updateStats();
    this.renderTagsFilter();
  }

  async loadVideos() {
    const filters = {
      limit: this.pageSize,
      offset: (this.currentPage - 1) * this.pageSize,
      rating: this.selectedRating,
      drivePath: this.selectedDrivePath
    };

    const result = await ipcRenderer.invoke('get-videos', filters);

    if (Array.isArray(result)) {
      // 向下兼容舊格式 - 但這不應該發生在分頁模式下
      console.warn('收到舊格式資料，分頁功能可能異常');
      this.currentVideos = result;
      this.totalVideos = result.length;
      this.totalPages = Math.ceil(result.length / this.pageSize);
    } else {
      // 新的分頁格式
      this.currentVideos = result.videos || [];
      this.totalVideos = result.total || 0;
      this.totalPages = result.totalPages || 0;
      this.currentPage = result.page || 1;
    }
  }

  async loadTags() {
    this.tagsByGroup = await ipcRenderer.invoke('get-tags-by-group');
    // 展平標籤用於統計
    this.allTags = [];
    this.tagsByGroup.forEach(group => {
      if (group.tags && Array.isArray(group.tags)) {
        this.allTags.push(...group.tags);
      }
    });
    console.log('載入的標籤群組:', this.tagsByGroup);
    console.log('所有標籤:', this.allTags);
  }

  async loadDrivePaths() {
    try {
      const drivePaths = await ipcRenderer.invoke('get-drive-paths');
      console.log('載入的硬碟路徑:', drivePaths);

      // 清空現有選項（保留"全部硬碟"）
      this.elements.driveFilterSelect.innerHTML = '<option value="">全部硬碟</option>';

      // 加入硬碟路徑選項
      drivePaths.forEach(drive => {
        const option = document.createElement('option');
        option.value = drive.path;
        option.textContent = `${drive.path} (${drive.count})`;
        this.elements.driveFilterSelect.appendChild(option);
      });
    } catch (error) {
      console.error('載入硬碟路徑錯誤:', error);
    }
  }

  handleDriveFilterChange(drivePath) {
    this.selectedDrivePath = drivePath;
    this.currentPage = 1; // 重置到第一頁
    this.handleSearch(this.elements.searchInput.value);
  }

  async handleSearch(searchTerm) {
    this.showLoading();
    try {
      // 重置到第一頁
      this.currentPage = 1;

      const activeTagsArray = Array.from(this.activeTags);
      const filters = {
        limit: this.pageSize,
        offset: (this.currentPage - 1) * this.pageSize,
        rating: this.selectedRating,
        drivePath: this.selectedDrivePath
      };

      const result = await ipcRenderer.invoke('search-videos', searchTerm, activeTagsArray, filters);

      if (Array.isArray(result)) {
        // 向下兼容舊格式 - 但這不應該發生在分頁模式下
        console.warn('搜尋收到舊格式資料，分頁功能可能異常');
        this.currentVideos = result;
        this.totalVideos = result.length;
        this.totalPages = Math.ceil(result.length / this.pageSize);
      } else {
        // 新的分頁格式
        this.currentVideos = result.videos || [];
        this.totalVideos = result.total || 0;
        this.totalPages = result.totalPages || 0;
        this.currentPage = result.page || 1;
      }

      this.updateStats();
      this.renderVideos();
      this.renderPagination();
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
    // 立即載入所有縮圖（移除懶載入）
    this.loadAllThumbnails();
  }

  createVideoCard(video) {
    const tags = video.tags && video.tags.length > 0
      ? video.tags.map(tag => {
          // 支援舊格式（字串）和新格式（物件）
          if (typeof tag === 'string') {
            return `<span class="tag" style="--tag-color: #3b82f6;">${tag}</span>`;
          } else {
            return `<span class="tag" style="--tag-color: ${tag.color};">${tag.name}</span>`;
          }
        }).join('')
      : '<span class="no-tags">無標籤</span>';

    const filename = video.filename || '未知檔名';
    const filesize = this.formatFileSize(video.filesize);
    const createdDate = video.file_created_at
      ? new Date(video.file_created_at).toLocaleDateString()
      : (video.created_at ? new Date(video.created_at).toLocaleDateString() : '未知日期');

    // 生成星星評分
    const rating = video.rating || 0;
    const stars = this.generateStars(rating);

    return `
      <div class="video-card" data-video-id="${video.id}">
        <div class="video-thumbnail" data-filepath="${video.filepath}">
          <video class="thumbnail-video" preload="metadata" muted>
            <source src="${video.filepath}">
          </video>
          <div class="thumbnail-fallback">
            <span>🎬</span>
          </div>
          <div class="thumbnail-toolbar">
            <button class="btn-thumbnail-action btn-generate-thumb" data-video-id="${video.id}" data-filepath="${video.filepath}" title="重新產生縮圖">
              🖼️ 產生縮圖
            </button>
          </div>
        </div>
        <div class="video-card-content">
          <div class="video-title" title="${filename}">${filename}</div>
          <div class="video-meta">
            ${filesize} • ${createdDate}
          </div>
          <div class="video-rating">${stars}</div>
          <div class="video-tags">${tags}</div>
        </div>
      </div>
    `;
  }

  createVideoListItem(video) {
    const tags = video.tags && video.tags.length > 0
      ? video.tags.map(tag => {
          // 支援舊格式（字串）和新格式（物件）
          if (typeof tag === 'string') {
            return `<span class="tag" style="--tag-color: #3b82f6;">${tag}</span>`;
          } else {
            return `<span class="tag" style="--tag-color: ${tag.color};">${tag.name}</span>`;
          }
        }).join('')
      : '<span class="no-tags">無標籤</span>';

    const filename = video.filename || '未知檔名';
    const filesize = this.formatFileSize(video.filesize);
    const createdDate = video.file_created_at
      ? new Date(video.file_created_at).toLocaleDateString()
      : (video.created_at ? new Date(video.created_at).toLocaleDateString() : '未知日期');

    // 生成星星評分
    const rating = video.rating || 0;
    const stars = this.generateStars(rating);

    return `
      <div class="video-list-item" data-video-id="${video.id}">
        <div class="video-list-thumbnail" data-filepath="${video.filepath}">
          <video class="thumbnail-video-small" preload="metadata" muted>
            <source src="${video.filepath}">
          </video>
          <div class="thumbnail-fallback-small">
            <span>🎬</span>
          </div>
          <div class="thumbnail-toolbar">
            <button class="btn-thumbnail-action btn-generate-thumb" data-video-id="${video.id}" data-filepath="${video.filepath}" title="重新產生縮圖">
              🖼️
            </button>
          </div>
        </div>
        <div class="video-list-content">
          <div class="video-title">${filename}</div>
          <div class="video-meta">
            ${filesize} • ${createdDate}
          </div>
          <div class="video-rating">${stars}</div>
          <div class="video-tags">${tags}</div>
        </div>
      </div>
    `;
  }

  bindVideoEvents() {
    const videoElements = this.elements.videosContainer.querySelectorAll('[data-video-id]');
    videoElements.forEach(element => {
      element.addEventListener('click', (e) => {
        // 如果點擊的是工具欄按鈕，不觸發卡片點擊
        if (e.target.closest('.thumbnail-toolbar')) {
          return;
        }
        const videoId = element.dataset.videoId;
        this.showVideoModal(videoId);
      });
    });

    // 綁定縮圖生成按鈕事件
    const generateThumbButtons = this.elements.videosContainer.querySelectorAll('.btn-generate-thumb');
    generateThumbButtons.forEach(button => {
      button.addEventListener('click', async (e) => {
        e.stopPropagation(); // 防止觸發卡片點擊事件
        const videoPath = button.dataset.filepath;
        const videoId = button.dataset.videoId;
        await this.generateThumbnailForCard(videoPath, videoId, button);
      });
    });
  }

  loadAllThumbnails() {
    // 清理載入狀態
    this.loadingThumbnails.clear();

    const thumbnailContainers = this.elements.videosContainer.querySelectorAll('.video-thumbnail, .video-list-thumbnail');

    // 立即載入所有縮圖（移除懶載入機制）
    thumbnailContainers.forEach((container, index) => {
      const videoPath = container.dataset.filepath;
      if (videoPath) {
        // 添加載入中的視覺提示
        this.addLoadingPlaceholder(container);

        console.log(`立即載入縮圖: ${videoPath}`);
        this.loadingThumbnails.add(videoPath);
        this.loadThumbnail(container, videoPath);
      }
    });

    console.log(`開始載入 ${thumbnailContainers.length} 個縮圖`);
  }

  addLoadingPlaceholder(container) {
    // 為尚未載入的縮圖添加占位符
    const fallbackElement = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');
    if (fallbackElement) {
      fallbackElement.classList.add('loading');
      fallbackElement.innerHTML = '<div style="font-size: 0.8rem;">⏳ 等待載入</div>';
      fallbackElement.style.display = 'flex';
    }
  }

  async loadThumbnail(container, videoPath) {
    try {
      // 檢查是否已有快取的縮圖
      const result = await ipcRenderer.invoke('check-thumbnail', videoPath);
      if (result.success && result.exists) {
        // 使用快取的縮圖
        this.showCachedThumbnail(container, result.path);
      } else {
        // 檢查影片格式相容性
        if (this.isVideoFormatSupported(videoPath)) {
          // 支援的格式使用影片預覽
          this.setupVideoThumbnail(container, videoPath);
        } else {
          // 不支援的格式嘗試使用 FFmpeg 後端生成
          console.warn(`格式可能不支援瀏覽器播放: ${videoPath}`);
          await this.generateThumbnailWithBackend(container, videoPath);
        }
      }
    } catch (error) {
      console.error('載入縮圖失敗:', error);
      // 出錯時顯示預設縮圖
      this.showDefaultThumbnail(container, videoPath);
    } finally {
      // 載入完成後從追蹤集合中移除
      this.loadingThumbnails.delete(videoPath);
    }
  }

  isVideoFormatSupported(videoPath) {
    const extension = videoPath.toLowerCase().split('.').pop();
    // Chromium/Electron 較好支援的格式
    const supportedFormats = ['mp4', 'webm', 'ogg', 'ogv', 'm4v'];
    // 部分支援的格式 (讓瀏覽器嘗試，失敗時回退)
    const partialSupport = ['mov', 'mkv', '3gp', 'mpg', 'mpeg'];
    // 通常不支援的格式 (直接使用後端處理)
    const unsupportedFormats = ['avi', 'wmv', 'flv', 'rmvb', 'rm', 'asf', 'ts', 'mts', 'm2ts'];

    if (supportedFormats.includes(extension)) {
      return true;
    }
    if (unsupportedFormats.includes(extension)) {
      return false;
    }
    // 其他格式讓瀏覽器嘗試
    return true;
  }

  async generateThumbnailWithBackend(container, videoPath) {
    try {
      // 嘗試使用後端 FFmpeg 生成縮圖
      const result = await ipcRenderer.invoke('get-thumbnail', videoPath);
      if (result.success && result.thumbnail) {
        this.showCachedThumbnail(container, result.thumbnail);
      } else {
        throw new Error('後端縮圖生成失敗');
      }
    } catch (error) {
      console.warn('後端縮圖生成失敗:', error);
      this.showDefaultThumbnail(container, videoPath);
    }
  }

  showDefaultThumbnail(container, videoPath) {
    const fallbackElement = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');
    if (fallbackElement) {
      fallbackElement.classList.remove('loading');
      const extension = videoPath.toLowerCase().split('.').pop().toUpperCase();
      fallbackElement.innerHTML = `
        <div style="text-align: center;">
          <div style="font-size: 1.5rem; margin-bottom: 0.5rem;">🎬</div>
          <div style="font-size: 0.7rem; opacity: 0.8;">${extension}</div>
          <div style="font-size: 0.6rem; opacity: 0.6;">無法預覽</div>
        </div>
      `;
      fallbackElement.style.display = 'flex';
      fallbackElement.style.background = 'linear-gradient(45deg, #757575, #9e9e9e)';
    }
  }

  showCachedThumbnail(container, thumbnailPath) {
    // 移除原有的 video 元素
    const videoElement = container.querySelector('.thumbnail-video, .thumbnail-video-small');
    const fallbackElement = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');

    if (videoElement) {
      videoElement.remove();
    }

    // 建立圖片元素顯示縮圖
    const img = document.createElement('img');
    img.className = videoElement ? videoElement.className.replace('thumbnail-video', 'thumbnail-img') : 'thumbnail-img';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.src = `file://${thumbnailPath}`;

    img.addEventListener('load', () => {
      if (fallbackElement) {
        fallbackElement.classList.remove('loading');
        fallbackElement.style.display = 'none';
      }
    });

    img.addEventListener('error', () => {
      // 圖片載入失敗，回退到影片預覽
      img.remove();
      if (fallbackElement) {
        fallbackElement.classList.remove('loading');
        fallbackElement.style.display = 'flex';
      }
      this.setupVideoThumbnail(container, container.dataset.filepath);
    });

    container.insertBefore(img, fallbackElement);
  }

  setupVideoThumbnail(container, videoPath) {
    const isSmall = container.classList.contains('video-list-thumbnail');
    const videoClass = isSmall ? 'thumbnail-video-small' : 'thumbnail-video';

    // 檢查是否已有 video 元素
    let video = container.querySelector('.thumbnail-video, .thumbnail-video-small');
    if (!video) {
      video = document.createElement('video');
      video.className = videoClass;
      video.preload = 'metadata';
      video.muted = true;

      const source = document.createElement('source');
      source.src = videoPath;
      video.appendChild(source);

      const fallback = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');
      container.insertBefore(video, fallback);
    }

    // 顯示載入提示
    const fallback = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');
    if (fallback) {
      fallback.innerHTML = '<div style="font-size: 0.8rem;">📹 載入中...</div>';
      fallback.classList.add('loading');
    }

    // 設定載入超時 (15秒，給大檔案和網路磁碟更多時間)
    const timeoutId = setTimeout(() => {
      console.warn(`影片載入超時: ${videoPath}`);
      if (fallback) {
        fallback.innerHTML = '<div style="font-size: 0.7rem;">⏱️ 載入超時<br><span class="retry-btn">點擊重試</span></div>';
        fallback.style.cursor = 'pointer';

        // 移除舊的事件監聽器
        fallback.onclick = null;

        // 為重試按鈕添加事件監聽器，阻止事件冒泡
        const retryBtn = fallback.querySelector('.retry-btn');
        if (retryBtn) {
          retryBtn.onclick = (e) => {
            e.stopPropagation(); // 阻止事件冒泡到父元素
            e.preventDefault();
            this.setupVideoThumbnail(container, videoPath);
          };
        }
      }
    }, 15000);

    video.addEventListener('loadeddata', async () => {
      clearTimeout(timeoutId);
      // 嘗試多個時間點，避免黑幀
      video.currentTime = Math.max(10, video.duration * 0.1);
    });

    video.addEventListener('seeked', async () => {
      clearTimeout(timeoutId);
      video.style.opacity = '1';
      const fallback = video.nextElementSibling;
      if (fallback && fallback.classList.contains('thumbnail-fallback')) {
        fallback.classList.remove('loading');
        fallback.style.display = 'none';
      }

      // 嘗試生成縮圖快取
      try {
        const ThumbnailGenerator = require('../thumbnailGenerator');
        const thumbnailGenerator = new ThumbnailGenerator();
        await thumbnailGenerator.generateThumbnailInRenderer(video, videoPath);
      } catch (error) {
        console.warn('生成縮圖快取失敗:', error);
      }
    });

    video.addEventListener('error', async () => {
      clearTimeout(timeoutId);
      console.warn(`影片載入錯誤: ${videoPath}`);

      // 先嘗試後端生成縮圖
      try {
        await this.generateThumbnailWithBackend(container, videoPath);
      } catch (error) {
        // 如果後端也失敗，顯示格式資訊和重試選項
        if (fallback) {
          const extension = videoPath.toLowerCase().split('.').pop().toUpperCase();
          fallback.innerHTML = `
            <div style="text-align: center; font-size: 0.7rem;">
              <div>🎬 ${extension}</div>
              <div style="margin: 2px 0;">載入失敗</div>
              <div class="retry-btn" style="cursor: pointer; color: #667eea;">點擊重試</div>
            </div>
          `;
          fallback.style.display = 'flex';

          // 為重試按鈕添加事件監聽器，阻止事件冒泡
          const retryBtn = fallback.querySelector('.retry-btn');
          if (retryBtn) {
            retryBtn.onclick = (e) => {
              e.stopPropagation(); // 阻止事件冒泡到父元素
              e.preventDefault();
              this.setupVideoThumbnail(container, videoPath);
            };
          }
        }
      }
    });

    video.style.opacity = '0';
    video.style.transition = 'opacity 0.3s';
  }

  renderTagsFilter() {
    console.log('🎯 [DEBUG] 渲染標籤篩選器開始');
    console.log('🎯 [DEBUG] 群組數量:', this.tagsByGroup.length);
    console.log('🎯 [DEBUG] 標籤群組詳情:', JSON.stringify(this.tagsByGroup, null, 2));

    if (!this.elements.tagsFilter) {
      console.error('🎯 [ERROR] tagsFilter 元素不存在！');
      return;
    }

    if (this.tagsByGroup.length === 0) {
      console.log('🎯 [DEBUG] 無標籤群組，顯示空狀態');
      this.elements.tagsFilter.innerHTML = `
        <div class="no-tags-container">
          <span class="no-tags">尚無標籤</span>
          <p class="no-tags-hint">點選上方「標籤管理」開始建立標籤</p>
        </div>
      `;
      return;
    }

    const html = this.tagsByGroup.map(group => `
      <div class="tag-group-filter">
        <div class="tag-group-header">
          <span class="tag-group-color" style="background-color: ${group.color};"></span>
          <span class="tag-group-name">${group.name}</span>
          <span class="tag-group-count">(${(group.tags || []).length})</span>
        </div>
        <div class="tag-group-tags">
          ${(group.tags || []).map(tag =>
            `<span class="tag ${this.activeTags.has(tag.name) ? 'active' : ''}"
                   data-tag="${tag.name}"
                   style="--tag-color: ${tag.color};">
              ${tag.name} (${tag.video_count})
            </span>`
          ).join('')}
        </div>
      </div>
    `).join('');

    console.log('🎯 [DEBUG] 生成的 HTML:', html);
    this.elements.tagsFilter.innerHTML = html;
    console.log('🎯 [DEBUG] HTML 已設定到 DOM');

    this.bindTagEvents();
    console.log('🎯 [DEBUG] 事件綁定完成');
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

  bindRatingFilterEvents() {
    // 綁定「全部」按鈕
    const allOption = document.querySelector('.rating-option[data-rating="0"]');
    if (allOption) {
      allOption.addEventListener('click', () => {
        this.setRatingFilter(0);
      });
    }

    // 綁定星星點擊事件
    const filterStars = document.querySelectorAll('.filter-star');
    filterStars.forEach((star) => {
      star.addEventListener('click', () => {
        const rating = parseInt(star.dataset.rating);
        this.setRatingFilter(rating);
      });
    });
  }

  setRatingFilter(rating) {
    this.selectedRating = rating;
    this.currentPage = 1; // 重置到第一頁

    // 更新「全部」按鈕狀態
    const allOption = document.querySelector('.rating-option[data-rating="0"]');
    if (allOption) {
      allOption.classList.toggle('active', rating === 0);
    }

    // 更新星星狀態
    const filterStars = document.querySelectorAll('.filter-star');
    filterStars.forEach((star) => {
      const starRating = parseInt(star.dataset.rating);
      if (rating === 0) {
        star.classList.remove('active');
        star.textContent = '☆';
      } else if (starRating <= rating) {
        star.classList.add('active');
        star.textContent = '★';
      } else {
        star.classList.remove('active');
        star.textContent = '☆';
      }
    });

    // 重新載入影片
    this.handleSearch(this.elements.searchInput.value);
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

  resetTagsFilter() {
    this.activeTags.clear();
    this.renderTagsFilter();
    this.handleSearch(this.elements.searchInput.value);
  }

  resetAllFilters() {
    // 清空所有篩選條件
    this.activeTags.clear();
    this.selectedRating = 0;
    this.selectedDrivePath = '';
    this.elements.searchInput.value = '';

    // 重置 UI 元素
    this.elements.driveFilterSelect.value = '';

    // 重置評分篩選 UI
    const allOption = document.querySelector('.rating-option[data-rating="0"]');
    if (allOption) {
      allOption.classList.add('active');
    }
    const filterStars = document.querySelectorAll('.filter-star');
    filterStars.forEach((star) => {
      star.classList.remove('active');
      star.textContent = '☆';
    });

    // 重新載入資料
    this.renderTagsFilter();
    this.handleSearch('');
  }

  async showVideoModal(videoId) {
    this.selectedVideo = this.currentVideos.find(v => v.id === videoId);
    if (!this.selectedVideo) return;

    document.getElementById('modal-filename').textContent = this.selectedVideo.filename;
    document.getElementById('modal-filepath').textContent = this.selectedVideo.filepath;
    document.getElementById('modal-filesize').textContent = this.formatFileSize(this.selectedVideo.filesize);
    const createdText = this.selectedVideo.file_created_at
      ? new Date(this.selectedVideo.file_created_at).toLocaleString()
      : (this.selectedVideo.created_at ? new Date(this.selectedVideo.created_at).toLocaleString() : '未知日期');
    document.getElementById('modal-created').textContent = createdText;
    document.getElementById('modal-description').value = this.selectedVideo.description || '';

    this.renderModalTags();
    this.renderTagSelector();
    this.setModalRating(this.selectedVideo.rating || 0);
    this.bindModalEvents();

    // 載入合集資訊
    if (this.selectedVideo.fingerprint) {
      await this.loadCollectionInfo(this.selectedVideo.fingerprint);
    }

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

    // 使用事件委派綁定標籤移除事件（只綁定一次）
    if (!this.modalTagsEventBound) {
      modalTags.addEventListener('click', (e) => {
        const tagElement = e.target.closest('.tag.removable');
        if (tagElement) {
          this.removeVideoTag(tagElement.dataset.tag);
        }
      });
      this.modalTagsEventBound = true;
    }
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
            ${(group.tags || []).map(tag => `
              <div class="tag-item-selector ${this.selectedVideo.tags.includes(tag.name) ? 'selected' : ''}"
                   data-tag-name="${tag.name}">
                <div class="tag-color-selector" style="background-color: ${tag.color};"></div>
                <div class="tag-name-selector">${tag.name}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('');

      // 使用事件委派綁定標籤選擇事件（只綁定一次）
      if (!this.tagSelectorEventBound) {
        tagSelector.addEventListener('click', (e) => {
          const tagItem = e.target.closest('.tag-item-selector');
          if (tagItem) {
            const tagName = tagItem.dataset.tagName;
            if (tagItem.classList.contains('selected')) {
              this.removeVideoTag(tagName);
            } else {
              this.addVideoTag(tagName);
            }
          }
        });
        this.tagSelectorEventBound = true;
      }
    } catch (error) {
      console.error('載入標籤選擇器錯誤:', error);
      document.getElementById('tag-selector').innerHTML = '<p>載入標籤失敗</p>';
    }
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
        this.generateThumbnailManually();
      } else if (target.id === 'delete-video') {
        this.deleteVideo();
      } else if (target.id === 'delete-video-file') {
        this.deleteVideoWithFile();
      } else if (target.id === 'open-file') {
        this.openVideoFile();
      }
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

    this.modalEventsBound = true;
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
      // 只使用基於指紋的新方法
      if (!this.selectedVideo.fingerprint) {
        throw new Error('影片缺少 fingerprint，無法添加標籤');
      }

      await ipcRenderer.invoke('add-video-tag', this.selectedVideo.fingerprint, actualTagName);

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
      // 只使用基於指紋的新方法
      if (!this.selectedVideo.fingerprint) {
        throw new Error('影片缺少 fingerprint，無法移除標籤');
      }

      await ipcRenderer.invoke('remove-video-tag', this.selectedVideo.fingerprint, tagName);

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
        ? video.tags.map(tag => {
            // 支援舊格式（字串）和新格式（物件）
            if (typeof tag === 'string') {
              return `<span class="tag" style="--tag-color: #3b82f6;">${tag}</span>`;
            } else {
              return `<span class="tag" style="--tag-color: ${tag.color};">${tag.name}</span>`;
            }
          }).join('')
        : '<span class="no-tags">無標籤</span>';
      tagsElement.innerHTML = tags;
    }
  }

  async saveVideoChanges() {
    const description = document.getElementById('modal-description').value;
    const rating = document.querySelectorAll('.star.active').length;

    try {
      // 使用基於指紋的新方法來儲存評分和描述
      if (this.selectedVideo.fingerprint) {
        await ipcRenderer.invoke('set-video-metadata', this.selectedVideo.fingerprint, {
          description,
          rating
        });
      } else {
        // 回退到舊方法（向後兼容）
        await ipcRenderer.invoke('update-video', this.selectedVideo.id, {
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
      await ipcRenderer.invoke('delete-video', this.selectedVideo.id);
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
      const confirmation = await ipcRenderer.invoke('show-delete-confirmation', filename);

      if (!confirmation.confirmed) {
        if (!confirmation.checkboxChecked) {
          alert('請勾選確認選項才能執行刪除操作');
        }
        return;
      }

      const result = await ipcRenderer.invoke('delete-video-with-file', this.selectedVideo.id);

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
        } else if (recordDeleted && !fileDeleted) {
          alert(`影片記錄已刪除，但檔案刪除失敗：\n${error}`);
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

  openVideoFile() {
    if (this.selectedVideo) {
      shell.openPath(this.selectedVideo.filepath);
    }
  }

  async generateThumbnailManually() {
    if (!this.selectedVideo) {
      alert('請先選擇一個影片');
      return;
    }

    const videoPath = this.selectedVideo.filepath;
    const generateBtn = document.getElementById('generate-thumbnail');

    try {
      // 更新按鈕狀態
      generateBtn.textContent = '⏳ 生成中...';
      generateBtn.disabled = true;

      console.log('開始手動生成縮圖:', videoPath);

      // 呼叫後端使用 FFmpeg 生成縮圖
      const result = await ipcRenderer.invoke('generate-thumbnail-force', videoPath);

      if (result.success && result.thumbnail) {
        alert('縮圖生成成功！');
        console.log('縮圖已儲存至:', result.thumbnail);

        // 重新載入頁面上的縮圖（如果當前影片在列表中顯示）
        const videoCard = document.querySelector(`[data-video-id="${this.selectedVideo.id}"]`);
        if (videoCard) {
          const thumbnailContainer = videoCard.querySelector('.video-thumbnail, .video-list-thumbnail');
          if (thumbnailContainer) {
            // 清除現有縮圖並重新載入
            this.showCachedThumbnail(thumbnailContainer, result.thumbnail);
          }
        }
      } else {
        throw new Error(result.error || '縮圖生成失敗');
      }
    } catch (error) {
      console.error('手動生成縮圖失敗:', error);
      alert(`縮圖生成失敗：${error.message}\n\n請確認：\n1. 系統已安裝 FFmpeg\n2. 影片檔案可正常存取\n3. 影片格式受支援`);
    } finally {
      // 恢復按鈕狀態
      generateBtn.textContent = '🖼️ 產生縮圖';
      generateBtn.disabled = false;
    }
  }

  async generateThumbnailForCard(videoPath, videoId, button) {
    try {
      // 更新按鈕狀態
      const originalText = button.textContent;
      button.textContent = '⏳';
      button.disabled = true;
      button.style.opacity = '0.6';

      console.log('從卡片生成縮圖:', videoPath);

      // 呼叫後端使用 FFmpeg 生成縮圖
      const result = await ipcRenderer.invoke('generate-thumbnail-force', videoPath);

      if (result.success && result.thumbnail) {
        console.log('縮圖生成成功:', result.thumbnail);

        // 立即更新當前卡片的縮圖
        const videoCard = document.querySelector(`[data-video-id="${videoId}"]`);
        if (videoCard) {
          const thumbnailContainer = videoCard.querySelector('.video-thumbnail, .video-list-thumbnail');
          if (thumbnailContainer) {
            // 清除現有縮圖並重新載入
            this.showCachedThumbnail(thumbnailContainer, result.thumbnail);
          }
        }

        // 短暫顯示成功提示
        button.textContent = '✓';
        button.style.backgroundColor = '#4caf50';
        button.style.color = 'white';

        setTimeout(() => {
          button.textContent = originalText;
          button.disabled = false;
          button.style.opacity = '1';
          button.style.backgroundColor = '';
          button.style.color = '';
        }, 2000);
      } else {
        throw new Error(result.error || '縮圖生成失敗');
      }
    } catch (error) {
      console.error('卡片生成縮圖失敗:', error);

      // 顯示錯誤狀態
      button.textContent = '✗';
      button.style.backgroundColor = '#f44336';
      button.style.color = 'white';

      setTimeout(() => {
        button.textContent = '🖼️';
        button.disabled = false;
        button.style.opacity = '1';
        button.style.backgroundColor = '';
        button.style.color = '';
      }, 2000);

      alert(`縮圖生成失敗：${error.message}`);
    }
  }

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
        let message = `掃描完成！找到: ${stats.found}, 新增: ${stats.added}, 更新: ${stats.updated}`;
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

  updateStats() {
    this.elements.totalVideos.textContent = this.totalVideos;
    this.elements.totalTags.textContent = this.allTags.length;
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

  // 分頁相關方法
  async goToPage(page) {
    if (page < 1 || page > this.totalPages || page === this.currentPage) {
      return;
    }

    this.currentPage = page;
    this.showLoading();

    try {
      const searchTerm = this.elements.searchInput.value.trim();
      const activeTagsArray = Array.from(this.activeTags);

      if (searchTerm || activeTagsArray.length > 0) {
        // 有搜尋條件時，保持搜尋狀態進行分頁
        const filters = {
          limit: this.pageSize,
          offset: (this.currentPage - 1) * this.pageSize,
          rating: this.selectedRating,
          drivePath: this.selectedDrivePath
        };

        const result = await ipcRenderer.invoke('search-videos', searchTerm, activeTagsArray, filters);

        if (Array.isArray(result)) {
          console.warn('搜尋收到舊格式資料，分頁功能可能異常');
          this.currentVideos = result;
          this.totalVideos = result.length;
          this.totalPages = Math.ceil(result.length / this.pageSize);
        } else {
          this.currentVideos = result.videos || [];
          this.totalVideos = result.total || 0;
          this.totalPages = result.totalPages || 0;
          this.currentPage = result.page || 1;
        }

        this.updateStats();
        this.renderVideos();
        this.renderPagination();
      } else {
        // 沒有搜尋條件時，使用一般載入
        await this.loadVideos();
        this.renderVideos();
        this.renderPagination();
      }
    } catch (error) {
      console.error('切換頁面錯誤:', error);
    } finally {
      this.hideLoading();
    }
  }

  renderPagination() {
    const paginationContainer = document.getElementById('pagination-container');
    console.log('分頁容器:', paginationContainer);
    console.log('總頁數:', this.totalPages, '當前頁:', this.currentPage, '總影片數:', this.totalVideos);

    if (!paginationContainer) {
      console.error('找不到分頁容器元素！');
      return;
    }

    if (this.totalPages <= 1) {
      console.log('只有一頁或沒有資料，隱藏分頁控制器');
      paginationContainer.innerHTML = '';
      return;
    }

    let paginationHTML = '';

    // 上一頁按鈕
    if (this.currentPage > 1) {
      paginationHTML += `<button class="pagination-btn" onclick="videoManager.goToPage(${this.currentPage - 1})">◀ 上一頁</button>`;
    }

    // 頁碼按鈕
    const startPage = Math.max(1, this.currentPage - 2);
    const endPage = Math.min(this.totalPages, this.currentPage + 2);

    if (startPage > 1) {
      paginationHTML += `<button class="pagination-btn" onclick="videoManager.goToPage(1)">1</button>`;
      if (startPage > 2) {
        paginationHTML += `<span class="pagination-ellipsis">...</span>`;
      }
    }

    for (let i = startPage; i <= endPage; i++) {
      const isActive = i === this.currentPage ? 'active' : '';
      paginationHTML += `<button class="pagination-btn ${isActive}" onclick="videoManager.goToPage(${i})">${i}</button>`;
    }

    if (endPage < this.totalPages) {
      if (endPage < this.totalPages - 1) {
        paginationHTML += `<span class="pagination-ellipsis">...</span>`;
      }
      paginationHTML += `<button class="pagination-btn" onclick="videoManager.goToPage(${this.totalPages})">${this.totalPages}</button>`;
    }

    // 下一頁按鈕
    if (this.currentPage < this.totalPages) {
      paginationHTML += `<button class="pagination-btn" onclick="videoManager.goToPage(${this.currentPage + 1})">下一頁 ▶</button>`;
    }

    // 分頁資訊
    const startItem = (this.currentPage - 1) * this.pageSize + 1;
    const endItem = Math.min(this.currentPage * this.pageSize, this.totalVideos);
    paginationHTML += `<div class="pagination-info">顯示第 ${startItem}-${endItem} 筆，共 ${this.totalVideos} 筆影片</div>`;

    paginationContainer.innerHTML = paginationHTML;
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

  async openSettings() {
    try {
      await ipcRenderer.invoke('open-settings');
      // 當設置頁面關閉後，可能需要重新載入資料（如果資料庫類型改變）
      setTimeout(() => {
        this.loadData();
      }, 1000);
    } catch (error) {
      console.error('開啟設定頁面錯誤:', error);
    }
  }

  formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  generateStars(rating) {
    const stars = [];
    for (let i = 1; i <= 5; i++) {
      if (i <= rating) {
        stars.push('<span class="star filled">★</span>');
      } else {
        stars.push('<span class="star">☆</span>');
      }
    }
    return stars.join('');
  }

  // ========== 影片合集相關方法 ==========

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
      const result = await ipcRenderer.invoke('get-folder-videos', folderPath);

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
        `<option value="${v.fingerprint}" ${v.fingerprint === this.selectedVideo.fingerprint ? 'selected' : ''}>
          ${v.filename}
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
        <div class="child-video-item" data-fingerprint="${v.fingerprint}">
          <input type="checkbox" checked>
          <span>${v.filename}</span>
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
      const result = await ipcRenderer.invoke('create-collection',
        mainFingerprint, childFingerprints, collectionName, folderPath
      );

      if (result.success) {
        alert('合集建立成功！');
        this.hideCollectionModal();
        // 重新載入影片列表
        await this.loadVideos();
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
      const collectionResult = await ipcRenderer.invoke('get-collection', this.selectedVideo.fingerprint);
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

      const result = await ipcRenderer.invoke('remove-collection', this.selectedVideo.fingerprint);

      if (result.success) {
        const deletedMsg = result.data?.totalVideosDeleted > 0
          ? `合集已刪除，已移除 ${result.data.totalVideosDeleted} 個影片的資料庫記錄`
          : '合集已刪除';
        alert(deletedMsg);
        this.hideVideoModal();
        // 重新載入影片列表
        await this.loadVideos();
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
      const result = await ipcRenderer.invoke('get-collection', fingerprint);

      if (result.success && result.data) {
        // 顯示合集資訊
        this.elements.collectionList.classList.remove('hidden');
        this.elements.removeCollectionBtn.classList.remove('hidden');

        // 顯示子影片清單
        const collection = result.data;
        this.elements.collectionEpisodes.innerHTML = collection.child_videos.map((v, index) => `
          <div class="episode-item" data-filepath="${v.filepath}">
            <span class="episode-number">${index + 1}</span>
            <span class="episode-name">${v.filename}</span>
            <button class="btn btn-play" data-filepath="${v.filepath}">▶ 播放</button>
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
            shell.openPath(filepath);
          }
        }
      });
      this.episodePlayEventBound = true;
    }
  }

  // 清理資源 (當頁面卸載或重新載入時)
  destroy() {
    this.loadingThumbnails.clear();
  }

  // ========== 最近掃描路徑相關方法 ==========

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

    recentPathsList.innerHTML = paths.map(path => `
      <div class="recent-path-item" data-path="${path}" title="${path}">
        <span class="recent-path-icon">📁</span>
        <span class="recent-path-text">${path}</span>
      </div>
    `).join('');

    // 綁定點擊事件
    recentPathsList.querySelectorAll('.recent-path-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = item.dataset.path;
        this.elements.folderPath.value = path;
        // 可選：自動聚焦到路徑輸入框
        this.elements.folderPath.focus();
      });
    });
  }
}

// 全域變數，讓分頁控制器可以訪問
let videoManager;

document.addEventListener('DOMContentLoaded', () => {
  videoManager = new VideoManager();

  // 頁面卸載時清理資源
  window.addEventListener('beforeunload', () => {
    videoManager.destroy();
  });
});