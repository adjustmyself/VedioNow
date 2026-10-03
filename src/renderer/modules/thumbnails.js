// VideoManager 的方法群組：影片卡片縮圖：快取查詢、延遲載入、瀏覽器解碼 / 後端 FFmpeg 產生、手動重產
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
const { ipcRenderer } = require('electron');
const { escapeHtml, toFileUrl } = require('../shared/util');

// 瀏覽器無法解碼、需交給後端 FFmpeg 的格式
const UNSUPPORTED_FORMATS = new Set(['avi', 'wmv', 'flv', 'rmvb', 'rm', 'asf', 'ts', 'mts', 'm2ts']);

let rendererThumbnailGenerator = null;
function getRendererThumbnailGenerator() {
  if (!rendererThumbnailGenerator) {
    const ThumbnailGenerator = require('../../thumbnailGenerator');
    rendererThumbnailGenerator = new ThumbnailGenerator();
  }
  return rendererThumbnailGenerator;
}

class ThumbnailMethods {
  // 元素接近可視範圍時才執行 callback（每次重繪列表會重置）
  _whenVisible(element, callback) {
    if (typeof IntersectionObserver === 'undefined') {
      callback();
      return;
    }
    if (!this._thumbObserver) {
      this._thumbCallbacks = new Map();
      this._thumbObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          this._thumbObserver.unobserve(entry.target);
          const cb = this._thumbCallbacks.get(entry.target);
          this._thumbCallbacks.delete(entry.target);
          if (cb) cb();
        }
      }, { rootMargin: '300px' });
    }
    this._thumbCallbacks.set(element, callback);
    this._thumbObserver.observe(element);
  }

  _loadThumbnailLazily(container, videoPath) {
    if (this.thumbnailCache.get(videoPath)) {
      // 已有縮圖檔：直接建立 <img loading="lazy">，成本很低
      this.loadThumbnail(container, videoPath);
    } else {
      this._whenVisible(container, () => this.loadThumbnail(container, videoPath));
    }
  }

  loadAllThumbnails() {
    // 清理載入狀態
    this.loadingThumbnails.clear();
    // 舊卡片已被 innerHTML 換掉，停止觀察
    if (this._thumbObserver) {
      this._thumbObserver.disconnect();
      this._thumbCallbacks.clear();
    }

    const thumbnailContainers = this.elements.videosContainer.querySelectorAll('.video-thumbnail, .video-list-thumbnail');

    // 收集所有需要查詢的路徑（已快取的略過 IPC）
    const pathsToCheck = [];
    const containerByPath = new Map();
    thumbnailContainers.forEach((container) => {
      const videoPath = container.dataset.filepath;
      if (!videoPath) return;
      this.addLoadingPlaceholder(container);
      this.loadingThumbnails.add(videoPath);
      if (!this.thumbnailCache.has(videoPath)) {
        pathsToCheck.push(videoPath);
      }
      // 同一路徑可能對應多個 container（不太會發生但保險）
      if (!containerByPath.has(videoPath)) containerByPath.set(videoPath, []);
      containerByPath.get(videoPath).push(container);
    });

    // 一次性批次查詢
    if (pathsToCheck.length > 0) {
      ipcRenderer.invoke('check-thumbnails-batch', pathsToCheck).then(res => {
        if (res && res.success && res.results) {
          for (const [p, thumb] of Object.entries(res.results)) {
            this.thumbnailCache.set(p, thumb || null);
          }
        }
        // 批次查詢回來後，再去逐個 render
        containerByPath.forEach((containers, videoPath) => {
          containers.forEach(c => this._loadThumbnailLazily(c, videoPath));
        });
      }).catch(err => {
        console.error('批次縮圖查詢失敗，改逐個查詢:', err);
        containerByPath.forEach((containers, videoPath) => {
          containers.forEach(c => this._loadThumbnailLazily(c, videoPath));
        });
      });
    } else {
      // 全部命中快取，直接 render
      containerByPath.forEach((containers, videoPath) => {
        containers.forEach(c => this._loadThumbnailLazily(c, videoPath));
      });
    }
  }

  // 瀏覽器能播的格式由 <video> 產縮圖、不經過 FFmpeg，長度在這裡取得後寫回資料庫，
  // 並就地補上卡片的長度標記（不必等重新載入）
  _recordVideoDuration(container, videoPath, seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const video = this.currentVideos.find(v => v.filepath === videoPath);
    if (!video || video.duration > 0) return;

    video.duration = seconds;
    ipcRenderer.invoke('set-video-duration', videoPath, seconds).catch(err =>
      console.warn('寫入影片長度失敗:', err)
    );
    if (container.classList.contains('video-thumbnail') && !container.querySelector('.thumbnail-duration')) {
      const badge = document.createElement('div');
      badge.className = 'thumbnail-duration';
      badge.textContent = this.formatDuration(seconds);
      container.appendChild(badge);
    }
  }

  addLoadingPlaceholder(container) {
    // 為尚未載入的縮圖添加占位符
    const fallbackElement = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');
    if (fallbackElement) {
      fallbackElement.classList.add('loading');
      fallbackElement.classList.remove('unavailable');
      fallbackElement.innerHTML = '<div style="font-size: 0.8rem;">⏳ 等待載入</div>';
      fallbackElement.style.display = 'flex';
    }
  }

  async loadThumbnail(container, videoPath) {
    try {
      // 先看前端快取：已知有縮圖路徑直接用、已知沒有就直接走 fallback，省一次 IPC
      if (this.thumbnailCache.has(videoPath)) {
        const cached = this.thumbnailCache.get(videoPath);
        if (cached) {
          this.showCachedThumbnail(container, cached);
        } else if (this.isVideoFormatSupported(videoPath)) {
          this.setupVideoThumbnail(container, videoPath);
        } else {
          await this.generateThumbnailWithBackend(container, videoPath);
        }
        return;
      }

      const result = await ipcRenderer.invoke('check-thumbnail', videoPath);
      if (result.success && result.exists) {
        this.thumbnailCache.set(videoPath, result.path);
        this.showCachedThumbnail(container, result.path);
      } else {
        this.thumbnailCache.set(videoPath, null);
        if (this.isVideoFormatSupported(videoPath)) {
          this.setupVideoThumbnail(container, videoPath);
        } else {
          console.warn(`格式可能不支援瀏覽器播放: ${videoPath}`);
          await this.generateThumbnailWithBackend(container, videoPath);
        }
      }
    } catch (error) {
      console.error('載入縮圖失敗:', error);
      this.showDefaultThumbnail(container, videoPath);
    } finally {
      this.loadingThumbnails.delete(videoPath);
    }
  }

  isVideoFormatSupported(videoPath) {
    const extension = videoPath.toLowerCase().split('.').pop();
    if (UNSUPPORTED_FORMATS.has(extension)) return false;
    return true;
  }

  async generateThumbnailWithBackend(container, videoPath, { quiet = false } = {}) {
    try {
      // 嘗試使用後端 FFmpeg 生成縮圖
      const result = await ipcRenderer.invoke('get-thumbnail', videoPath);
      if (result.success && result.thumbnail) {
        this.thumbnailCache.set(videoPath, result.thumbnail);
        this.showCachedThumbnail(container, result.thumbnail);
        return true;
      }
      throw new Error(result.error || '後端縮圖生成失敗');
    } catch (error) {
      console.warn('後端縮圖生成失敗:', error);
      if (!quiet) this.showDefaultThumbnail(container, videoPath);
      return false;
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
          <div style="font-size: 0.7rem; opacity: 0.8;">${escapeHtml(extension)}</div>
          <div style="font-size: 0.6rem; opacity: 0.6;">無法預覽</div>
        </div>
      `;
      fallbackElement.style.display = 'flex';
      fallbackElement.classList.add('unavailable');
    }
  }

  showCachedThumbnail(container, thumbnailPath) {
    // 移除原有的 video 元素
    const videoElement = container.querySelector('.thumbnail-video, .thumbnail-video-small');
    const fallbackElement = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');

    if (videoElement) {
      videoElement.remove();
    }

    // 移除舊的 img，避免重產時殘留舊圖
    const oldImg = container.querySelector('img.thumbnail-img, img.thumbnail-img-small');
    if (oldImg) oldImg.remove();

    // 建立圖片元素顯示縮圖
    const img = document.createElement('img');
    img.className = videoElement ? videoElement.className.replace('thumbnail-video', 'thumbnail-img') : 'thumbnail-img';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    // 縮圖檔名固定（路徑 hash），重產後需用版本號破壞渲染器快取，否則沿用舊圖。
    // 版本號持久化於 thumbnailVersions，重新渲染列表時仍會帶上，避免又跳回舊圖。
    const version = this.thumbnailVersions.get(container.dataset.filepath);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = toFileUrl(thumbnailPath, version);

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
    const fallback = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');

    // 重試時換一個新的 video 元素：沿用舊元素會讓事件監聽器一層層疊加
    const oldVideo = container.querySelector('.thumbnail-video, .thumbnail-video-small');
    if (oldVideo) {
      oldVideo.removeAttribute('src');
      oldVideo.load();
      oldVideo.remove();
    }

    const video = document.createElement('video');
    video.className = videoClass;
    video.preload = 'metadata';
    video.muted = true;
    video.style.opacity = '0';
    video.style.transition = 'opacity 0.3s';

    const showRetry = (html) => {
      if (!fallback) return;
      fallback.classList.remove('loading');
      fallback.innerHTML = html;
      fallback.style.display = 'flex';
      const retryBtn = fallback.querySelector('.retry-btn');
      if (retryBtn) {
        retryBtn.onclick = (e) => {
          e.stopPropagation(); // 阻止事件冒泡到父元素
          e.preventDefault();
          this.setupVideoThumbnail(container, videoPath);
        };
      }
    };

    // 顯示載入提示
    if (fallback) {
      fallback.innerHTML = '<div style="font-size: 0.8rem;">📹 載入中...</div>';
      fallback.classList.add('loading');
      fallback.style.display = 'flex';
    }

    // 設定載入超時 (15秒，給大檔案和網路磁碟更多時間)
    const timeoutId = setTimeout(() => {
      console.warn(`影片載入超時: ${videoPath}`);
      showRetry('<div style="font-size: 0.7rem;">⏱️ 載入超時<br><span class="retry-btn">點擊重試</span></div>');
    }, 15000);

    video.addEventListener('loadeddata', () => {
      clearTimeout(timeoutId);
      this._recordVideoDuration(container, videoPath, video.duration);
      // 跳過開頭避免黑幀
      video.currentTime = Math.max(10, video.duration * 0.1);
    }, { once: true });

    video.addEventListener('seeked', async () => {
      clearTimeout(timeoutId);
      video.style.opacity = '1';
      if (fallback) {
        fallback.classList.remove('loading');
        fallback.style.display = 'none';
      }

      // 存成縮圖快取，之後重繪直接用圖片，不必再從（可能是網路磁碟的）影片讀一次
      try {
        const thumbnailPath = await getRendererThumbnailGenerator().generateThumbnailInRenderer(video, videoPath);
        if (thumbnailPath) this.thumbnailCache.set(videoPath, thumbnailPath);
      } catch (error) {
        console.warn('生成縮圖快取失敗:', error);
      }
    }, { once: true });

    video.addEventListener('error', async () => {
      clearTimeout(timeoutId);
      console.warn(`影片載入錯誤，改用後端產生縮圖: ${videoPath}`);
      video.remove();
      const ok = await this.generateThumbnailWithBackend(container, videoPath, { quiet: true });
      if (!ok) {
        const extension = videoPath.toLowerCase().split('.').pop().toUpperCase();
        showRetry(`
          <div style="text-align: center; font-size: 0.7rem;">
            <div>🎬 ${escapeHtml(extension)}</div>
            <div style="margin: 2px 0;">載入失敗</div>
            <div class="retry-btn">點擊重試</div>
          </div>
        `);
      }
    }, { once: true });

    // 直接設 video.src：用 <source> 子元素時載入失敗的 error 事件不會送到 video 上
    video.src = toFileUrl(videoPath);
    container.insertBefore(video, fallback);
  }

  async generateThumbnailManually(timeOffset) {
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

      // 呼叫後端使用 FFmpeg 生成縮圖（指定擷取秒數）
      const result = await ipcRenderer.invoke('generate-thumbnail-force', videoPath, timeOffset);

      if (result.success && result.thumbnail) {
        this.thumbnailCache.set(videoPath, result.thumbnail);
        // 更新版本號以破壞渲染器圖片快取
        this.thumbnailVersions.set(videoPath, Date.now());
        alert('縮圖生成成功！');

        // 重新載入頁面上的縮圖（如果當前影片在列表中顯示）
        const videoCard = document.querySelector(`[data-video-id="${CSS.escape(String(this.selectedVideo.id))}"]`);
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

  // 顯示擷取秒數選單，選定後以 onPick(seconds) 回呼
  showThumbnailSecondsMenu(anchorButton, onPick) {
    // 移除已開啟的選單
    this.closeThumbnailSecondsMenu();

    const presets = [
      { label: '30 秒（預設）', value: 30 },
      { label: '60 秒', value: 60 },
      { label: '90 秒', value: 90 },
      { label: '120 秒', value: 120 }
    ];

    const menu = document.createElement('div');
    menu.className = 'thumb-seconds-menu';

    const pick = (seconds) => {
      this.closeThumbnailSecondsMenu();
      onPick(seconds);
    };

    presets.forEach((opt) => {
      const item = document.createElement('button');
      item.className = 'thumb-seconds-item';
      item.textContent = opt.label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        pick(opt.value);
      });
      menu.appendChild(item);
    });

    // 自訂秒數：內嵌輸入框（Electron 不支援 window.prompt，故不能用它）
    const customRow = document.createElement('div');
    customRow.className = 'thumb-seconds-custom';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.placeholder = '自訂秒數';
    input.className = 'thumb-seconds-input';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'thumb-seconds-confirm';
    confirmBtn.textContent = '確定';

    const submitCustom = () => {
      const seconds = parseInt(input.value, 10);
      if (!Number.isFinite(seconds) || seconds < 0) {
        input.classList.add('invalid');
        input.focus();
        return;
      }
      pick(seconds);
    };

    // 在輸入框內攔截鍵盤事件，避免冒泡觸發全域快捷鍵或關閉選單
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submitCustom();
      else if (e.key === 'Escape') this.closeThumbnailSecondsMenu();
    });
    input.addEventListener('input', () => input.classList.remove('invalid'));
    confirmBtn.addEventListener('click', (e) => { e.stopPropagation(); submitCustom(); });

    customRow.appendChild(input);
    customRow.appendChild(confirmBtn);
    menu.appendChild(customRow);

    document.body.appendChild(menu);

    // 定位在按鈕上方（空間不足則改下方）
    const rect = anchorButton.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let top = rect.top - menuRect.height - 6;
    if (top < 4) top = rect.bottom + 6;
    let left = rect.left + rect.width / 2 - menuRect.width / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - menuRect.width - 4));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;

    // 點到選單以外或按 Esc 才關閉（點選單內部不關，才能在輸入框輸入）
    const onDocClick = (ev) => { if (!menu.contains(ev.target)) this.closeThumbnailSecondsMenu(); };
    const onKey = (ev) => { if (ev.key === 'Escape') this.closeThumbnailSecondsMenu(); };
    this._thumbMenuCleanup = () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
      if (menu.parentNode) menu.parentNode.removeChild(menu);
      this._thumbMenuEl = null;
      this._thumbMenuCleanup = null;
    };
    this._thumbMenuEl = menu;
    // 延後綁定，避免本次點擊立即觸發關閉
    setTimeout(() => {
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onKey);
    }, 0);
  }

  closeThumbnailSecondsMenu() {
    if (this._thumbMenuCleanup) this._thumbMenuCleanup();
  }
}

module.exports = ThumbnailMethods;
