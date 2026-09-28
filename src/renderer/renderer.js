const { ipcRenderer } = require('electron');

const { escapeHtml, toTagImageUrl, debounce } = require('./shared/util');

class VideoManager {
  constructor() {
    this.currentVideos = [];
    this.allTags = [];
    this.activeTags = new Set();
    this.tagSearchQuery = '';
    // tab 模式：目前選取（展開顯示標籤）的群組名稱；null = 未選取
    this.activeGroup = this.loadActiveGroup();
    // 多面向篩選：當前條件下每個標籤的命中計數；null = 無篩選，使用原始 video_count
    this.filteredTagCounts = null;
    this._tagCountsReqId = 0;
    this._searchReqId = 0;
    this.selectedRating = 0; // 0 表示全部
    this.selectedDrivePath = ''; // 選中的硬碟路徑
    this.duplicatesOnly = false; // 只看有重複檔案的影片
    this.currentSort = 'file_created_at';
    this.sortOrder = 'desc';
    this.viewMode = 'grid';
    this.selectedVideo = null;
    this.loadingThumbnails = new Set(); // 追蹤正在載入的縮圖
    // 縮圖前端快取：filepath -> thumbnailPath（命中快取）或 null（已確認沒快取）
    // 切換排序/檢視模式或翻頁回來時直接用，省掉 N 個 check-thumbnail IPC
    this.thumbnailCache = new Map();
    // 縮圖版本號：filepath -> 時間戳，重產縮圖後用來破壞渲染器圖片快取（檔名不變）
    this.thumbnailVersions = new Map();
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
    this.tagFilterEventBound = false;

    this.initializeElements();
    this.bindEvents();
    this.init();
  }

  async init() {
    try {
      // 先讀設定（單頁顯示數量）再載入影片，避免用預設值多算一次分頁
      await this.loadAppConfig();
      await this.loadData();
    } finally {
      // 通知主行程首批資料已就緒：關掉啟動畫面、顯示主視窗
      // （失敗時也要送，否則使用者會卡在啟動畫面）
      ipcRenderer.send('renderer-ready');
    }
  }

  // 從設定檔讀取應用程式設定（目前：單頁顯示數量）
  async loadAppConfig() {
    try {
      const cfg = await ipcRenderer.invoke('get-config');
      const size = parseInt(cfg?.app?.pageSize, 10);
      if (!isNaN(size) && size > 0) {
        this.pageSize = size;
      }
    } catch (e) {
      console.warn('讀取應用程式設定失敗，使用預設單頁數量:', e);
    }
  }

  initializeElements() {
    this.elements = {
      tagManagerBtn: document.getElementById('tag-manager-btn'),
      settingsBtn: document.getElementById('settings-btn'),
      scanBtn: document.getElementById('scan-btn'),
      searchInput: document.getElementById('search-input'),
      driveFilterSelect: document.getElementById('drive-filter-select'),
      duplicateFilterToggle: document.getElementById('duplicate-filter-toggle'),
      duplicateFilterCount: document.getElementById('duplicate-filter-count'),
      tagsFilter: document.getElementById('tags-filter'),
      tagFilterSearch: document.getElementById('tag-filter-search'),
      tagFilterSearchClear: document.getElementById('tag-filter-search-clear'),
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
    const debouncedSearch = debounce((value) => this.handleSearch(value), 250);
    this.elements.searchInput.addEventListener('input', (e) => debouncedSearch(e.target.value));
    this.elements.driveFilterSelect.addEventListener('change', (e) => this.handleDriveFilterChange(e.target.value));
    this.elements.duplicateFilterToggle.addEventListener('click', () => this.setDuplicatesOnly(!this.duplicatesOnly));
    this.elements.duplicateFilterToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.setDuplicatesOnly(!this.duplicatesOnly);
      }
    });
    this.elements.resetTagsBtn.addEventListener('click', () => this.resetTagsFilter());
    const debouncedTagFilter = debounce(() => this.renderTagsFilter(), 120);
    this.elements.tagFilterSearch?.addEventListener('input', (e) => {
      this.tagSearchQuery = e.target.value.trim().toLowerCase();
      this.elements.tagFilterSearchClear?.classList.toggle('hidden', !this.tagSearchQuery);
      debouncedTagFilter();
    });
    this.elements.tagFilterSearchClear?.addEventListener('click', () => {
      this.elements.tagFilterSearch.value = '';
      this.tagSearchQuery = '';
      this.elements.tagFilterSearchClear.classList.add('hidden');
      this.renderTagsFilter();
      this.elements.tagFilterSearch.focus();
    });
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

    // 視窗縮放時重算頁碼顯示數量（依容器寬度動態加長）
    window.addEventListener('resize', () => {
      clearTimeout(this._paginationResizeTimer);
      this._paginationResizeTimer = setTimeout(() => this.renderPagination(), 150);
    });

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

    // 設定變更：單頁顯示數量即時生效（不需重啟）
    ipcRenderer.on('page-size-changed', (event, size) => {
      const n = parseInt(size, 10);
      if (isNaN(n) || n <= 0 || n === this.pageSize) return;
      this.pageSize = n;
      this.currentPage = 1;
      this.refreshCurrentView();
    });

    // 資料庫類型變更：主程序已重建 DB，主視窗需重新載入資料
    ipcRenderer.on('database-changed', () => {
      this.loadData();
    });

    // 標籤／群組在標籤管理視窗有異動：立即同步標籤快取與畫面，
    // 讓新標籤不必重開主視窗就能選取
    ipcRenderer.on('tags-changed', async () => {
      await this.refreshTagsUI();
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

    this.setupTagTooltip();
  }

  async loadData() {
    this.showLoading();
    try {
      await Promise.all([
        this.loadVideos(),
        this.loadTags(),
        this.loadDrivePaths(),
        this.loadDuplicateSummary()
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
      this.loadDrivePaths(),
      this.loadDuplicateSummary()
    ]);

    // 如果有搜尋條件或篩選，使用 handleSearch 保持條件
    if (searchTerm || this.isAnyFilterActive()) {
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

  _buildPageFilters() {
    return {
      limit: this.pageSize,
      offset: (this.currentPage - 1) * this.pageSize,
      rating: this.selectedRating,
      drivePath: this.selectedDrivePath,
      duplicatesOnly: this.duplicatesOnly,
      sortBy: this.currentSort,
      sortOrder: this.sortOrder
    };
  }

  _applyPageResult(result) {
    this.currentVideos = result.videos || [];
    this.totalVideos = result.total || 0;
    this.totalPages = result.totalPages || 0;
    this.currentPage = result.page || 1;
  }

  // 依目前搜尋字、標籤、篩選與排序查詢 this.currentPage 那一頁
  _queryCurrentPage() {
    const searchTerm = this.elements.searchInput.value.trim();
    const activeTagsArray = Array.from(this.activeTags);
    return ipcRenderer.invoke('search-videos', searchTerm, activeTagsArray, this._buildPageFilters());
  }

  async loadVideos() {
    this._applyPageResult(await this._queryCurrentPage());
  }

  // 重新查詢並重繪目前頁（換頁、排序共用）
  async fetchPage() {
    // 與 handleSearch 共用 requestId：換頁中若使用者再輸入搜尋，丟棄本次回應
    const reqId = ++this._searchReqId;
    this.showLoading();
    try {
      const result = await this._queryCurrentPage();
      if (reqId !== this._searchReqId) return;
      this._applyPageResult(result);
      this.updateStats();
      this.renderVideos();
      this.renderPagination();
    } catch (error) {
      console.error('載入頁面錯誤:', error);
    } finally {
      if (reqId === this._searchReqId) {
        this.hideLoading();
      }
    }
  }

  async loadTags() {
    this.tagsByGroup = await ipcRenderer.invoke('get-tags-by-group');
    // 展平標籤用於統計
    this.allTags = [];
    // 標籤名稱 -> 顏色 / 說明 / 說明圖片，供只有名稱字串的標籤（影片卡片、詳情）查詢
    this.tagColors = new Map();
    this.tagDescriptions = new Map();
    this.tagImages = new Map();
    // 標籤名稱 -> 在標籤管理中的顯示順序（群組順序 + 群組內順序），供卡片與詳情排序
    this.tagOrder = new Map();
    // 圖片資料庫只存檔名，需組出 userData 下的 file:// URL；資料夾不會變，只查一次
    if (this._tagImagesDir === undefined) {
      this._tagImagesDir = await ipcRenderer.invoke('get-tag-images-dir');
    }
    const toImageUrl = (value) => toTagImageUrl(value, this._tagImagesDir);
    this.tagsByGroup.forEach(group => {
      if (group.tags && Array.isArray(group.tags)) {
        this.allTags.push(...group.tags);
        group.tags.forEach(tag => {
          if (!this.tagOrder.has(tag.name)) this.tagOrder.set(tag.name, this.tagOrder.size);
          if (tag.color) this.tagColors.set(tag.name, tag.color);
          if (tag.description) this.tagDescriptions.set(tag.name, tag.description);
          if (tag.description_image) this.tagImages.set(tag.name, toImageUrl(tag.description_image));
        });
      }
    });
  }

  // 重新載入標籤快取並更新所有用到標籤的畫面（篩選列、統計、開啟中的影片彈窗）
  async refreshTagsUI() {
    try {
      await this.loadTags();
      this.renderTagsFilter();
      this.updateStats();
      // 標籤管理改了順序或顏色：就地更新卡片上的標籤（不重畫整個列表，縮圖不重載）
      this.currentVideos.forEach(video => this.updateVideoTagsDisplay(video.id));

      // 影片彈窗開啟中：重建標籤選擇器，讓剛新增的標籤馬上可以點選
      const modalOpen = this.selectedVideo &&
        !this.elements.videoModal.classList.contains('hidden');
      if (modalOpen) {
        this.renderModalTags();
        await this.renderTagSelector();
        // 重建後會清掉搜尋造成的隱藏狀態，依目前關鍵字重新過濾
        this.applyTagSearchFilter();
      }
    } catch (error) {
      console.error('同步標籤資料錯誤:', error);
    }
  }

  async loadDrivePaths() {
    try {
      const drivePaths = await ipcRenderer.invoke('get-drive-paths');

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

  // 側邊欄「只看有重複的影片」旁顯示有重複的影片數
  async loadDuplicateSummary() {
    try {
      const summary = await ipcRenderer.invoke('get-duplicate-summary');
      this.elements.duplicateFilterCount.textContent = summary && summary.videos > 0 ? `(${summary.videos})` : '(0)';
    } catch (error) {
      console.error('載入重複檔案統計錯誤:', error);
    }
  }

  setDuplicatesOnly(enabled) {
    this.duplicatesOnly = enabled;
    this.elements.duplicateFilterToggle.classList.toggle('active', enabled);
    this.elements.duplicateFilterToggle.setAttribute('aria-pressed', String(enabled));
    this.currentPage = 1;
    this.handleSearch(this.elements.searchInput.value);
  }

  handleDriveFilterChange(drivePath) {
    this.selectedDrivePath = drivePath;
    this.currentPage = 1; // 重置到第一頁
    this.handleSearch(this.elements.searchInput.value);
  }

  async handleSearch(searchTerm) {
    // 連續輸入時每個字元都觸發查詢，短關鍵字命中多、回應慢，
    // 可能比後送出的長關鍵字晚回來；用 requestId 丟棄過時回應
    const reqId = ++this._searchReqId;
    this.showLoading();
    try {
      // 重置到第一頁
      this.currentPage = 1;

      const trimmedTerm = (searchTerm || '').trim();
      const activeTagsArray = Array.from(this.activeTags);

      const result = await ipcRenderer.invoke('search-videos', trimmedTerm, activeTagsArray, this._buildPageFilters());

      if (reqId !== this._searchReqId) return;

      this._applyPageResult(result);

      this.updateStats();
      this.renderVideos();
      this.renderPagination();

      // 更新每個標籤在目前篩選條件下的命中計數
      await this.fetchFilteredTagCounts();
      this.renderTagsFilter();
    } catch (error) {
      console.error('搜尋錯誤:', error);
    } finally {
      // 仍有較新的搜尋在進行時不關閉 loading，由最新的那次負責
      if (reqId === this._searchReqId) {
        this.hideLoading();
      }
    }
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this.elements.gridViewBtn.classList.toggle('active', mode === 'grid');
    this.elements.listViewBtn.classList.toggle('active', mode === 'list');
    this.elements.videosContainer.className = mode === 'grid' ? 'videos-grid' : 'videos-list';
    this.renderVideos();
  }

  // 排序在後端處理，才會對全部結果排序而不是只排目前這一頁
  setSortField(field) {
    this.currentSort = field;
    this.currentPage = 1;
    this.fetchPage();
  }

  toggleSortOrder() {
    this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
    this.elements.sortOrderBtn.textContent = this.sortOrder === 'desc' ? '降序' : '升序';
    this.currentPage = 1;
    this.fetchPage();
  }

  renderVideos() {
    // 資料已到：取消還沒出現的載入提示，免得它在後續 await 期間才觸發、把剛畫好的列表藏起來
    clearTimeout(this._loadingTimer);
    this.elements.loading.classList.add('hidden');

    if (this.currentVideos.length === 0) {
      this.elements.videosContainer.style.display = 'none';
      this.elements.emptyState.classList.remove('hidden');
      return;
    }

    this.elements.emptyState.classList.add('hidden');
    // 列表用 flex（.videos-list 靠 flex gap 維持間距），不可用 block 否則會蓋掉 flex、項目黏在一起
    this.elements.videosContainer.style.display = this.viewMode === 'grid' ? 'grid' : 'flex';

    this.elements.videosContainer.innerHTML = this.currentVideos.map(video =>
      this.viewMode === 'grid' ? this.createVideoCard(video) : this.createVideoListItem(video)
    ).join('');

    this.bindVideoEvents();
    // 立即載入所有縮圖（移除懶載入）
    this.loadAllThumbnails();
  }

  // 影片卡片上的單一標籤；帶 data-tag 供自訂 hover 提示（說明＋圖片）查詢
  _videoTagHtml(tag) {
    const name = typeof tag === 'string' ? tag : tag.name;
    // 字串標籤從顏色對照表查；查不到才用預設色
    const color = (typeof tag === 'string' ? this.tagColors?.get(tag) : tag.color) || '#3b82f6';
    return `<span class="tag" data-tag="${escapeHtml(name)}" style="--tag-color: ${escapeHtml(color)};">${escapeHtml(name)}</span>`;
  }

  // 依標籤管理的群組與標籤順序排列；不在標籤表內的排最後（維持原本相對順序）
  _sortTags(tags) {
    const order = this.tagOrder;
    if (!order || order.size === 0) return [...tags];
    const rank = (tag) => {
      const index = order.get(typeof tag === 'string' ? tag : tag.name);
      return index === undefined ? order.size : index;
    };
    return [...tags].sort((a, b) => rank(a) - rank(b));
  }

  // 卡片 / 清單項目的整排標籤；開詳情改標籤後由 updateVideoTagsDisplay() 就地更新
  _videoTagsHtml(video) {
    if (!video.tags || video.tags.length === 0) return '<span class="no-tags">無標籤</span>';
    return this._sortTags(video.tags).map(tag => this._videoTagHtml(tag)).join('');
  }

  _buildVideoFields(video) {
    const tags = this._videoTagsHtml(video);

    const filename = escapeHtml(video.filename || '未知檔名');
    const filepath = escapeHtml(video.filepath || '');
    const filesize = this.formatFileSize(video.filesize);
    const createdDate = video.file_created_at
      ? new Date(video.file_created_at).toLocaleDateString()
      : (video.created_at ? new Date(video.created_at).toLocaleDateString() : '未知日期');
    const stars = this.generateStars(video.rating || 0);
    const description = escapeHtml((video.description || '').trim());

    const duplicateCount = Number(video.duplicate_count) || 0;
    const duplicateBadge = duplicateCount > 0
      ? `<span class="duplicate-mark" title="另有 ${duplicateCount} 份內容相同的檔案">重複 ×${duplicateCount + 1}</span>`
      : '';

    return {
      tags, filename, filepath, filesize, createdDate, stars, description, duplicateBadge,
      playCount: this._playCountHtml(video),
      videoId: escapeHtml(video.id)
    };
  }

  // 卡片上的開啟次數（沒開過就不顯示）；開檔後由 updateVideoPlayCount() 就地更新
  _playCountHtml(video) {
    const count = Number(video.play_count) || 0;
    if (count === 0) return '<span class="video-play-count"></span>';
    const title = video.last_played_at ? `最後開啟：${new Date(video.last_played_at).toLocaleString()}` : '';
    return `<span class="video-play-count" title="${escapeHtml(title)}"> • ▶ ${count} 次</span>`;
  }

  updateVideoPlayCount(video) {
    const card = this.elements.videosContainer.querySelector(`[data-video-id="${CSS.escape(video.id)}"]`);
    const span = card && card.querySelector('.video-play-count');
    if (span) span.outerHTML = this._playCountHtml(video);
  }

  createVideoCard(video) {
    const f = this._buildVideoFields(video);
    return `
      <div class="video-card" data-video-id="${f.videoId}">
        <div class="video-thumbnail" data-filepath="${f.filepath}">
          <div class="thumbnail-fallback">
            <span>🎬</span>
          </div>
          ${f.duplicateBadge ? `<div class="thumbnail-duplicate-badge">${f.duplicateBadge}</div>` : ''}
          ${f.description ? `<div class="thumbnail-description">${f.description}</div>` : ''}
        </div>
        <div class="video-card-content">
          <div class="video-title" title="${f.filename}">${f.filename}</div>
          <div class="video-meta-row">
            <div class="video-meta">${f.filesize} • ${f.createdDate}${f.playCount}</div>
            <div class="video-rating">${f.stars}</div>
          </div>
          <div class="video-tags">${f.tags}</div>
        </div>
      </div>
    `;
  }

  createVideoListItem(video) {
    const f = this._buildVideoFields(video);
    return `
      <div class="video-list-item" data-video-id="${f.videoId}">
        <div class="video-list-thumbnail" data-filepath="${f.filepath}">
          <div class="thumbnail-fallback-small">
            <span>🎬</span>
          </div>
          ${f.description ? `<div class="thumbnail-description">${f.description}</div>` : ''}
        </div>
        <div class="video-list-content">
          <div class="video-title">${f.filename}</div>
          <div class="video-meta-row">
            <div class="video-meta">${f.filesize} • ${f.createdDate}${f.playCount}${f.duplicateBadge ? ` ${f.duplicateBadge}` : ''}</div>
            <div class="video-rating">${f.stars}</div>
          </div>
          <div class="video-tags">${f.tags}</div>
        </div>
      </div>
    `;
  }

  bindVideoEvents() {
    // 一次性事件委派到 videosContainer，DOM 重 render 時不需重綁
    if (this.videoEventsBound) return;

    this.elements.videosContainer.addEventListener('click', async (e) => {
      const card = e.target.closest('[data-video-id]');
      if (card) {
        this.showVideoModal(card.dataset.videoId);
      }
    });

    this.videoEventsBound = true;
  }

  updateStats() {
    this.elements.totalVideos.textContent = this.totalVideos;
    this.elements.totalTags.textContent = this.allTags.length;
  }

  showLoading() {
    clearTimeout(this._loadingTimer);
    this._loadingTimer = setTimeout(() => {
      this.elements.loading.classList.remove('hidden');
      this.elements.videosContainer.style.display = 'none';
      this.elements.emptyState.classList.add('hidden');
    }, 150);
  }

  hideLoading() {
    clearTimeout(this._loadingTimer);
    this.elements.loading.classList.add('hidden');
  }

  async openTagManager() {
    try {
      // 標籤資料改由 tags-changed 事件即時同步，不需在此輪詢重載
      await ipcRenderer.invoke('open-tag-manager');
    } catch (error) {
      console.error('開啟標籤管理器錯誤:', error);
    }
  }

  async openSettings() {
    try {
      // 只開啟設定視窗；資料是否需要重載交由 database-changed 事件精準觸發，
      // 避免每次點開設定都無條件重刷畫面
      await ipcRenderer.invoke('open-settings');
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

  // 清理資源 (當頁面卸載或重新載入時)
  destroy() {
    this.loadingThumbnails.clear();
  }

  // ========== 最近掃描路徑相關方法 ==========

}

// 各功能區塊的方法放在 modules/，併入 VideoManager
for (const Methods of [
  require('./modules/thumbnails'),
  require('./modules/tagFilterBar'),
  require('./modules/videoModal'),
  require('./modules/scanModal'),
  require('./modules/pagination'),
  require('./modules/collections')
]) {
  for (const name of Object.getOwnPropertyNames(Methods.prototype)) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(VideoManager.prototype, name)) {
      throw new Error(`VideoManager 方法重複定義: ${name}`);
    }
    Object.defineProperty(VideoManager.prototype, name, Object.getOwnPropertyDescriptor(Methods.prototype, name));
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