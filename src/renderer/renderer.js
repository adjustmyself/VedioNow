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
    this.thumbnailObserver = null;
    this.loadingThumbnails = new Set(); // 追蹤正在載入的縮圖

    this.initializeElements();
    this.bindEvents();
    this.initializeThumbnailObserver();
    this.loadData();
  }

  initializeElements() {
    this.elements = {
      tagManagerBtn: document.getElementById('tag-manager-btn'),
      settingsBtn: document.getElementById('settings-btn'),
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
      cleanupMissing: document.getElementById('cleanup-missing'),
      scanProgress: document.getElementById('scan-progress'),
      scanStatus: document.getElementById('scan-status')
    };
  }

  bindEvents() {
    this.elements.tagManagerBtn.addEventListener('click', () => this.openTagManager());
    this.elements.settingsBtn.addEventListener('click', () => this.openSettings());
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

  initializeThumbnailObserver() {
    // 創建 Intersection Observer 用於懶載入
    this.thumbnailObserver = new IntersectionObserver((entries) => {
      console.log(`Intersection Observer 觸發，檢查 ${entries.length} 個元素`);

      entries.forEach(entry => {
        console.log(`元素 ${entry.target.dataset.filepath} intersecting: ${entry.isIntersecting}`);

        if (entry.isIntersecting) {
          const container = entry.target;
          const videoPath = container.dataset.filepath;

          if (videoPath && !this.loadingThumbnails.has(videoPath)) {
            console.log(`開始載入縮圖: ${videoPath}`);
            this.loadingThumbnails.add(videoPath);
            this.loadThumbnail(container, videoPath);
            // 停止觀察已載入的元素
            this.thumbnailObserver.unobserve(container);
          }
        }
      });
    }, {
      root: null, // 使用視窗作為根元素
      rootMargin: '200px', // 增加到200px，提早觸發
      threshold: 0.01 // 降低到1%，更容易觸發
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
        const videoId = element.dataset.videoId;
        // 嘗試轉換為數字（SQLite），如果失敗則保持字串（MongoDB）
        const id = isNaN(videoId) ? videoId : parseInt(videoId);
        this.showVideoModal(id);
      });
    });

    this.setupThumbnails();
  }

  setupThumbnails() {
    // 清理之前的 Observer
    if (this.thumbnailObserver) {
      this.thumbnailObserver.disconnect();
      this.loadingThumbnails.clear();
    }

    const thumbnailContainers = this.elements.videosContainer.querySelectorAll('.video-thumbnail, .video-list-thumbnail');

    // 將所有縮圖容器加入 Intersection Observer 進行懶載入
    thumbnailContainers.forEach((container, index) => {
      const videoPath = container.dataset.filepath;
      if (videoPath) {
        // 添加載入中的視覺提示
        this.addLoadingPlaceholder(container);

        // 立即載入前幾個縮圖，不用等待滾動
        if (index < 6) {
          console.log(`立即載入前方縮圖: ${videoPath}`);
          this.loadingThumbnails.add(videoPath);
          this.loadThumbnail(container, videoPath);
        } else {
          // 其他的使用懒载入
          this.thumbnailObserver.observe(container);
        }
      }
    });

    console.log(`開始懶載入觀察 ${thumbnailContainers.length} 個縮圖容器，立即載入前6個`);

    // 添加一個後備機制，確保可見的縮圖會載入
    setTimeout(() => {
      this.ensureVisibleThumbnailsLoaded();
    }, 1000);
  }

  ensureVisibleThumbnailsLoaded() {
    const thumbnailContainers = this.elements.videosContainer.querySelectorAll('.video-thumbnail, .video-list-thumbnail');

    thumbnailContainers.forEach(container => {
      const rect = container.getBoundingClientRect();
      const isVisible = rect.top < window.innerHeight && rect.bottom > 0;

      if (isVisible) {
        const videoPath = container.dataset.filepath;
        if (videoPath && !this.loadingThumbnails.has(videoPath)) {
          console.log(`後備載入可見縮圖: ${videoPath}`);
          this.loadingThumbnails.add(videoPath);
          this.loadThumbnail(container, videoPath);
          // 如果正在被觀察，停止觀察
          try {
            this.thumbnailObserver.unobserve(container);
          } catch (e) {
            // 忽略錯誤
          }
        }
      }
    });
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
    const partialSupport = ['avi', 'mov', 'mkv', '3gp', 'mpg', 'mpeg'];
    // 通常不支援的格式 (直接使用後端處理)
    const unsupportedFormats = ['wmv', 'flv', 'rmvb', 'rm', 'asf', 'ts', 'mts', 'm2ts'];

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
    const deleteVideoFileBtn = document.getElementById('delete-video-file');
    const openFileBtn = document.getElementById('open-file');

    // 克隆元素來移除所有事件監聽器
    addTagBtn.replaceWith(addTagBtn.cloneNode(true));
    newTagInput.replaceWith(newTagInput.cloneNode(true));
    saveChangesBtn.replaceWith(saveChangesBtn.cloneNode(true));
    deleteVideoBtn.replaceWith(deleteVideoBtn.cloneNode(true));
    deleteVideoFileBtn.replaceWith(deleteVideoFileBtn.cloneNode(true));
    openFileBtn.replaceWith(openFileBtn.cloneNode(true));

    // 重新獲取元素引用
    const newAddTagBtn = document.getElementById('add-tag-btn');
    const newNewTagInput = document.getElementById('new-tag-input');
    const newSaveChangesBtn = document.getElementById('save-changes');
    const newDeleteVideoBtn = document.getElementById('delete-video');
    const newDeleteVideoFileBtn = document.getElementById('delete-video-file');
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

    newDeleteVideoFileBtn.addEventListener('click', () => {
      this.deleteVideoWithFile();
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
      // 使用基於指紋的新方法
      if (this.selectedVideo.fingerprint) {
        await ipcRenderer.invoke('add-video-tag', this.selectedVideo.fingerprint, actualTagName);
      } else {
        // 回退到舊方法（向後兼容）
        await ipcRenderer.invoke('add-tag', this.selectedVideo.id, actualTagName);
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
    }
  }

  async removeVideoTag(tagName) {
    try {
      // 使用基於指紋的新方法
      if (this.selectedVideo.fingerprint) {
        await ipcRenderer.invoke('remove-video-tag', this.selectedVideo.fingerprint, tagName);
      } else {
        // 回退到舊方法（向後兼容）
        await ipcRenderer.invoke('remove-tag', this.selectedVideo.id, tagName);
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
      await this.loadData();
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
        const { recordDeleted, fileDeleted, error } = result.result;

        if (recordDeleted && fileDeleted) {
          alert('影片記錄和檔案已成功刪除');
        } else if (recordDeleted && !fileDeleted) {
          alert(`影片記錄已刪除，但檔案刪除失敗：\n${error}`);
        }

        this.hideVideoModal();
        await this.loadData();
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

    const options = {
      recursive: this.elements.recursiveScan.checked,
      watchChanges: this.elements.watchChanges.checked,
      cleanupMissing: this.elements.cleanupMissing.checked
    };

    this.elements.scanProgress.classList.remove('hidden');
    this.elements.scanStatus.textContent = '正在掃描...';

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

  // 清理 Observer (當頁面卸載或重新載入時)
  destroy() {
    if (this.thumbnailObserver) {
      this.thumbnailObserver.disconnect();
      this.thumbnailObserver = null;
    }
    this.loadingThumbnails.clear();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const videoManager = new VideoManager();

  // 頁面卸載時清理資源
  window.addEventListener('beforeunload', () => {
    videoManager.destroy();
  });
});