// VideoManager 的方法群組：影片卡片縮圖：快取查詢、延遲載入、瀏覽器解碼 / 後端 FFmpeg 產生、手動重產
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
import { escapeHtml, toFileUrl } from '../shared/util.js';

// 瀏覽器無法解碼、需交給後端 FFmpeg 的格式
const UNSUPPORTED_FORMATS = new Set(['avi', 'wmv', 'flv', 'rmvb', 'rm', 'asf', 'ts', 'mts', 'm2ts']);

// 瀏覽器能播的格式：直接從 <video> 擷取畫面存成縮圖（不必跑 FFmpeg）。
// 依影片原始比例縮放成寬 640px 的 JPEG，交給主行程寫檔
const CANVAS_THUMBNAIL_WIDTH = 640;
async function captureVideoFrameJpeg(videoElement) {
  const canvas = document.createElement('canvas');
  const srcW = videoElement.videoWidth || 1280;
  const srcH = videoElement.videoHeight || 720;
  canvas.width = CANVAS_THUMBNAIL_WIDTH;
  canvas.height = Math.round(CANVAS_THUMBNAIL_WIDTH * (srcH / srcW));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!blob) throw new Error('無法從影片擷取畫面');
  return new Uint8Array(await blob.arrayBuffer());
}

// 縮圖容器上的影片指紋（縮圖檔以指紋命名；沒有指紋的影片回傳 null，後端改用路徑命名）
function fingerprintOf(container) {
  return (container && container.dataset.fingerprint) || null;
}

// 無法產生縮圖時顯示的異常圖示（影片框 + 驚嘆號）
const THUMBNAIL_ERROR_ICON = `
  <svg class="thumbnail-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2"/>
    <path d="M7 5v14M17 5v14" opacity="0.45"/>
    <path d="M12 9v4M12 16h.01"/>
  </svg>`;

const THUMBNAIL_ERROR_TITLES = {
  timeout: '載入逾時',
  failed: '無法產生縮圖'
};

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

    // 收集所有需要查詢的影片（已快取的略過 IPC）
    const pathsToCheck = [];
    const containerByPath = new Map();
    thumbnailContainers.forEach((container) => {
      const videoPath = container.dataset.filepath;
      if (!videoPath) return;
      this.addLoadingPlaceholder(container);
      this.loadingThumbnails.add(videoPath);
      if (!this.thumbnailCache.has(videoPath) && !containerByPath.has(videoPath)) {
        pathsToCheck.push({ filepath: videoPath, fingerprint: fingerprintOf(container) });
      }
      // 同一路徑可能對應多個 container（不太會發生但保險）
      if (!containerByPath.has(videoPath)) containerByPath.set(videoPath, []);
      containerByPath.get(videoPath).push(container);
    });

    // 一次性批次查詢
    if (pathsToCheck.length > 0) {
      window.api.invoke('check-thumbnails-batch', pathsToCheck).then(res => {
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
    window.api.invoke('set-video-duration', videoPath, seconds).catch(err =>
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
      fallbackElement.classList.remove('error');
      fallbackElement.innerHTML = '<div style="font-size: 0.8rem;">⏳ 等待載入</div>';
      fallbackElement.style.display = 'flex';
    }
  }

  async loadThumbnail(container, videoPath) {
    try {
      // 先看前端快取：已知有縮圖路徑直接用、已知沒有就直接走 fallback，省一次 IPC
      if (this.thumbnailCache.has(videoPath)) {
        const cached = this.thumbnailCache.get(videoPath);
        const failure = this.thumbnailFailures.get(videoPath);
        if (cached) {
          this.showCachedThumbnail(container, cached);
        } else if (failure && failure.fingerprint === fingerprintOf(container)) {
          // 這次執行期間已失敗過（例如還沒下載完）：直接顯示異常圖，按「重新嘗試」或檔案內容改變才再試
          this.showThumbnailError(container, videoPath, failure.reason);
        } else if (this.isVideoFormatSupported(videoPath)) {
          this.setupVideoThumbnail(container, videoPath);
        } else {
          await this.generateThumbnailWithBackend(container, videoPath);
        }
        return;
      }

      const result = await window.api.invoke('check-thumbnail', videoPath, fingerprintOf(container));
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
      this.showThumbnailError(container, videoPath);
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
      const result = await window.api.invoke('get-thumbnail', videoPath, fingerprintOf(container));
      if (result.success && result.thumbnail) {
        this.thumbnailCache.set(videoPath, result.thumbnail);
        this.showCachedThumbnail(container, result.thumbnail);
        return true;
      }
      throw new Error(result.error || '後端縮圖生成失敗');
    } catch (error) {
      console.warn('後端縮圖生成失敗:', error);
      if (!quiet) this.showThumbnailError(container, videoPath);
      return false;
    }
  }

  // 縮圖產生失敗（常見於還沒下載完、或已損毀的檔案）：顯示異常圖與「重新嘗試」。
  // 失敗會依路徑 + 指紋記下，換頁重繪時不再重跑；檔案下載完成後指紋改變就會自動重試
  showThumbnailError(container, videoPath, reason = 'failed') {
    this.thumbnailFailures.set(videoPath, { fingerprint: fingerprintOf(container), reason });

    const fallbackElement = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');
    if (!fallbackElement) return;

    const extension = videoPath.toLowerCase().split('.').pop().toUpperCase();
    const title = THUMBNAIL_ERROR_TITLES[reason] || THUMBNAIL_ERROR_TITLES.failed;
    const hint = '檔案可能尚未下載完成或已損毀';
    fallbackElement.classList.remove('loading');
    fallbackElement.classList.add('error');
    fallbackElement.title = `${title}（${extension}）：${hint}`;
    fallbackElement.innerHTML = `
      <div class="thumbnail-error-content">
        ${THUMBNAIL_ERROR_ICON}
        <div class="thumbnail-error-title">${escapeHtml(title)}</div>
        <div class="thumbnail-error-hint">${escapeHtml(hint)}</div>
        <button type="button" class="retry-btn" title="重新嘗試產生縮圖">↻ 重新嘗試</button>
      </div>
    `;
    fallbackElement.style.display = 'flex';

    const retryBtn = fallbackElement.querySelector('.retry-btn');
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 不要觸發卡片的點選 / 選取
      e.preventDefault();
      this.retryThumbnail(container, videoPath);
    });
    retryBtn.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  retryThumbnail(container, videoPath) {
    this.thumbnailFailures.delete(videoPath);
    this.thumbnailCache.delete(videoPath);
    const fallbackElement = container.querySelector('.thumbnail-fallback, .thumbnail-fallback-small');
    if (fallbackElement) fallbackElement.removeAttribute('title');
    this.addLoadingPlaceholder(container);
    this.loadThumbnail(container, videoPath);
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

    this.thumbnailFailures.delete(container.dataset.filepath);
    img.addEventListener('load', () => {
      if (fallbackElement) {
        fallbackElement.classList.remove('loading', 'error');
        fallbackElement.removeAttribute('title');
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

    // 顯示載入提示
    if (fallback) {
      fallback.innerHTML = '<div style="font-size: 0.8rem;">📹 載入中...</div>';
      fallback.classList.remove('error');
      fallback.classList.add('loading');
      fallback.style.display = 'flex';
    }

    // 逾時或載入錯誤（未下載完的檔案常見）：停掉 <video>、改用後端 FFmpeg，仍失敗才顯示異常圖。
    // settled 確保逾時後才到的 seeked / error 事件不會再動到畫面
    let settled = false;
    const fail = async (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      video.removeAttribute('src');
      video.load();
      video.remove();
      const ok = await this.generateThumbnailWithBackend(container, videoPath, { quiet: true });
      if (!ok) this.showThumbnailError(container, videoPath, reason);
    };

    // 設定載入超時 (15秒，給大檔案和網路磁碟更多時間)
    const timeoutId = setTimeout(() => {
      console.warn(`影片載入超時，改用後端產生縮圖: ${videoPath}`);
      fail('timeout');
    }, 15000);

    video.addEventListener('loadeddata', () => {
      if (settled) return;
      this._recordVideoDuration(container, videoPath, video.duration);
      // 跳過開頭避免黑幀；未下載完的檔案長度可能是 NaN / Infinity，設給 currentTime 會丟例外
      const target = Math.max(10, video.duration * 0.1);
      if (!Number.isFinite(target)) {
        fail('failed');
        return;
      }
      video.currentTime = target;
    }, { once: true });

    video.addEventListener('seeked', async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      video.style.opacity = '1';
      if (fallback) {
        fallback.classList.remove('loading');
        fallback.style.display = 'none';
      }

      // 存成縮圖快取，之後重繪直接用圖片，不必再從（可能是網路磁碟的）影片讀一次
      try {
        const jpeg = await captureVideoFrameJpeg(video);
        const result = await window.api.invoke('save-renderer-thumbnail', videoPath, fingerprintOf(container), jpeg);
        if (result.success) this.thumbnailCache.set(videoPath, result.thumbnail);
        else console.warn('儲存縮圖失敗:', result.error);
      } catch (error) {
        console.warn('生成縮圖快取失敗:', error);
      }
    }, { once: true });

    video.addEventListener('error', () => {
      if (settled) return;
      console.warn(`影片載入錯誤，改用後端產生縮圖: ${videoPath}`);
      fail('failed');
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
    const originalText = generateBtn.textContent;

    try {
      // 更新按鈕狀態
      generateBtn.textContent = '⏳ 生成中...';
      generateBtn.disabled = true;

      // 呼叫後端使用 FFmpeg 生成縮圖（指定擷取秒數）
      const result = await window.api.invoke('generate-thumbnail-force', videoPath, timeOffset, this.selectedVideo.fingerprint || null);

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
      generateBtn.textContent = originalText;
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

export default ThumbnailMethods;
