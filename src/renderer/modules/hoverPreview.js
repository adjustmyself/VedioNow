// VideoManager 的方法群組：滑過預覽：滑鼠停在網格卡片的縮圖上一下子，就顯示多格預覽，左右移動切換畫面
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
import { toFileUrl } from '../shared/util.js';

// 滑鼠停留多久才開始（快速掃過卡片時不觸發 FFmpeg）
const HOVER_DELAY_MS = 350;

class HoverPreviewMethods {
  initHoverPreview() {
    // filepath -> { path, frames }（格數由主行程的 PREVIEW_FRAMES 決定）；產生失敗記為 null，本次執行不再重試
    this._previewCache = new Map();
    this._previewThumb = null;
    this._previewOverlay = null;
    this._previewFrames = 0;
    this._previewTimer = null;
    this._previewMouseX = 0;

    const container = this.elements.videosContainer;
    container.addEventListener('mouseover', (e) => {
      const thumb = e.target.closest('.video-thumbnail');
      if (!thumb || thumb === this._previewThumb) return;
      this._previewMouseX = e.clientX;
      this._startHoverPreview(thumb);
    });
    container.addEventListener('mouseout', (e) => {
      const thumb = e.target.closest('.video-thumbnail');
      if (!thumb || thumb.contains(e.relatedTarget)) return;
      if (thumb === this._previewThumb) this._stopHoverPreview();
    });
    container.addEventListener('mousemove', (e) => {
      if (!this._previewThumb) return;
      this._previewMouseX = e.clientX;
      if (this._previewOverlay) this._scrubHoverPreview();
    });
  }

  _startHoverPreview(thumb) {
    this._stopHoverPreview();
    this._previewThumb = thumb;

    // 有描述的影片維持滑過顯示描述
    if (thumb.querySelector('.thumbnail-description')) return;
    const filepath = thumb.dataset.filepath;
    if (!filepath || this._previewCache.get(filepath) === null) return;

    this._previewTimer = setTimeout(async () => {
      if (this._previewThumb !== thumb || !thumb.isConnected) return;

      let preview = this._previewCache.get(filepath);
      if (!preview) {
        thumb.classList.add('preview-loading');
        const video = this.currentVideos.find(v => v.filepath === filepath);
        let result;
        try {
          result = await window.api.invoke('get-preview', filepath, thumb.dataset.fingerprint || null, video?.duration || 0);
        } catch (error) {
          result = { success: false, error: error.message };
        }
        thumb.classList.remove('preview-loading');
        if (!result.success) {
          // 設定關閉時不記入快取：之後重新開啟就能使用
          if (!result.disabled) {
            this._previewCache.set(filepath, null);
            console.warn(`滑過預覽產生失敗: ${filepath}`, result.error);
          }
          return;
        }
        preview = { path: result.path, frames: result.frames };
        this._previewCache.set(filepath, preview);
      }
      if (this._previewThumb !== thumb || !thumb.isConnected) return;
      this._showHoverPreview(thumb, preview);
    }, HOVER_DELAY_MS);
  }

  _showHoverPreview(thumb, { path, frames }) {
    const overlay = document.createElement('div');
    overlay.className = 'hover-preview';
    const frame = document.createElement('div');
    frame.className = 'hover-preview-frame';
    frame.style.backgroundImage = `url("${toFileUrl(path)}")`;
    frame.style.backgroundSize = `${frames * 100}% 100%`;
    const bar = document.createElement('div');
    bar.className = 'hover-preview-bar';
    overlay.append(frame, bar);
    thumb.appendChild(overlay);
    this._previewOverlay = overlay;
    this._previewFrames = frames;
    this._scrubHoverPreview();
  }

  // 依滑鼠在縮圖上的水平位置選格
  _scrubHoverPreview() {
    const thumb = this._previewThumb;
    const overlay = this._previewOverlay;
    if (!thumb || !overlay) return;
    const rect = thumb.getBoundingClientRect();
    const ratio = Math.min(0.9999, Math.max(0, (this._previewMouseX - rect.left) / rect.width));
    const frames = this._previewFrames;
    const index = Math.floor(ratio * frames);
    overlay.firstChild.style.backgroundPosition = `${(index * 100) / (frames - 1)}% 0`;
    overlay.lastChild.style.width = `${((index + 1) / frames) * 100}%`;
  }

  _stopHoverPreview() {
    clearTimeout(this._previewTimer);
    this._previewTimer = null;
    if (this._previewOverlay) this._previewOverlay.remove();
    if (this._previewThumb) this._previewThumb.classList.remove('preview-loading');
    this._previewOverlay = null;
    this._previewThumb = null;
  }
}

export default HoverPreviewMethods;
