// VideoManager 的方法群組：批次多選（Ctrl / Shift 點選卡片）與底部批次操作列：加 / 移除標籤、評分、刪除記錄
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
import { escapeHtml } from '../shared/util.js';

const tagNameOf = (tag) => (typeof tag === 'string' ? tag : tag && tag.name);

class BatchSelectionMethods {
  initBatchSelection() {
    // 已選影片：id -> { id, fingerprint, filename, tags }。換頁、改篩選都保留，才能跨頁挑選
    this.selection = new Map();
    this._selectionAnchor = null;

    const bar = document.getElementById('batch-bar');
    bar.addEventListener('click', (e) => {
      const ratingBtn = e.target.closest('[data-batch-rating]');
      if (ratingBtn) {
        this.batchSetRating(Number(ratingBtn.dataset.batchRating));
        return;
      }
      const action = e.target.closest('[data-batch]')?.dataset.batch;
      if (action === 'select-page') this.selectCurrentPage();
      else if (action === 'select-all') this.selectAllMatching();
      else if (action === 'add-tag') this.openBatchTagPicker('add');
      else if (action === 'remove-tag') this.openBatchTagPicker('remove');
      else if (action === 'delete') this.batchDeleteRecords();
      else if (action === 'clear') this.clearSelection();
    });

    // 多選狀態下單擊是切換選取；連按兩下開詳情（兩次單擊的切換剛好互相抵銷）
    this.elements.videosContainer.addEventListener('dblclick', (e) => {
      if (this.selection.size === 0 || e.target.closest('.card-select-box')) return;
      const card = e.target.closest('[data-video-id]');
      if (card) this.showVideoModal(card.dataset.videoId);
    });

    document.getElementById('batch-tag-close').addEventListener('click', () => this.hideBatchTagPicker());
    document.getElementById('batch-tag-cancel').addEventListener('click', () => this.hideBatchTagPicker());
    document.getElementById('batch-tag-apply').addEventListener('click', () => this.applyBatchTagPicker());
    document.getElementById('batch-tag-search').addEventListener('input', () => this.renderBatchTagPicker());
    document.getElementById('batch-tag-search').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        // Enter：選取第一個顯示中的標籤（或新增標籤）
        this._firstPickerItem()?.click();
      } else if (e.key === 'Escape') {
        this.hideBatchTagPicker();
      }
    });
    document.getElementById('batch-tag-list').addEventListener('click', (e) => {
      const item = e.target.closest('.tag-item-selector');
      if (!item) return;
      const name = item.dataset.tagName;
      if (this._batchPicked.has(name)) this._batchPicked.delete(name);
      else this._batchPicked.set(name, item.dataset.newTag === '1');
      if (item.dataset.newTag === '1') document.getElementById('batch-tag-search').value = '';
      this.renderBatchTagPicker();
    });
    document.getElementById('batch-tag-modal').addEventListener('click', (e) => {
      if (e.target.id === 'batch-tag-modal') this.hideBatchTagPicker();
    });

    // Esc 取消選取、Ctrl+A 全選本頁（彈窗開著或正在輸入時不攔截）。
    // 用 capture：比 renderer.js 的 Esc 關彈窗先執行，否則按 Esc 關詳情時彈窗已關、選取也會被一併清掉
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('batch-tag-modal').classList.contains('hidden')) {
        this.hideBatchTagPicker();
        return;
      }
      if (this._isTypingOrModalOpen(e)) return;
      if (e.key === 'Escape' && this.selection.size > 0) {
        this.clearSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && this.currentVideos.length > 0) {
        e.preventDefault();
        this.selectCurrentPage();
      }
    }, true);
  }

  _firstPickerItem() {
    return document.querySelector('#batch-tag-list .tag-item-selector:not(.selected)');
  }

  _isTypingOrModalOpen(e) {
    const t = e.target;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return true;
    return Boolean(document.querySelector('.modal:not(.hidden)'));
  }

  // 卡片點擊：多選相關的操作處理掉就回傳 true（不開詳情）
  handleSelectionClick(e, card) {
    const video = this.currentVideos.find(v => v.id === card.dataset.videoId);
    if (!video) return false;

    if (e.shiftKey) {
      if (this._selectionAnchor) this._selectRange(this._selectionAnchor, video.id);
      else this._toggleSelected(video);
      return true;
    }
    // 勾選框、Ctrl / Cmd 點選，或已在多選狀態下的一般點選：切換這部影片
    if (e.ctrlKey || e.metaKey || e.target.closest('.card-select-box') || this.selection.size > 0) {
      this._toggleSelected(video);
      return true;
    }
    return false;
  }

  _entryOf(video) {
    return {
      id: video.id,
      fingerprint: video.fingerprint || null,
      filename: video.filename,
      tags: (video.tags || []).map(tagNameOf).filter(Boolean)
    };
  }

  _toggleSelected(video) {
    if (this.selection.has(video.id)) this.selection.delete(video.id);
    else this.selection.set(video.id, this._entryOf(video));
    this._selectionAnchor = video.id;
    this.applySelectionState();
  }

  // Shift 點選：選取本頁從上次點選到這次之間的影片
  _selectRange(fromId, toId) {
    const ids = this.currentVideos.map(v => v.id);
    let a = ids.indexOf(fromId);
    const b = ids.indexOf(toId);
    if (b < 0) return;
    if (a < 0) a = b;
    const [start, end] = a <= b ? [a, b] : [b, a];
    for (const video of this.currentVideos.slice(start, end + 1)) {
      this.selection.set(video.id, this._entryOf(video));
    }
    this._selectionAnchor = toId;
    this.applySelectionState();
  }

  selectCurrentPage() {
    for (const video of this.currentVideos) this.selection.set(video.id, this._entryOf(video));
    this.applySelectionState();
  }

  async selectAllMatching() {
    const searchTerm = this.elements.searchInput.value.trim();
    const filters = this._buildPageFilters();
    delete filters.limit;
    delete filters.offset;
    this._setBatchStatus('正在選取全部符合條件的影片…');
    const result = await window.api.invoke('get-matching-video-refs', searchTerm, Array.from(this.activeTags), filters);
    if (!result.success) {
      this._setBatchStatus(`選取失敗：${result.error}`);
      return;
    }
    for (const ref of result.refs) this.selection.set(ref.id, this._entryOf(ref));
    this._setBatchStatus('');
    this.applySelectionState();
  }

  clearSelection() {
    this.selection.clear();
    this._selectionAnchor = null;
    this.applySelectionState();
  }

  // 依目前選取更新卡片外觀與批次操作列；重繪列表後也要呼叫
  applySelectionState() {
    const container = this.elements.videosContainer;
    const selecting = this.selection.size > 0;
    container.classList.toggle('selecting', selecting);
    container.querySelectorAll('[data-video-id]').forEach(card => {
      const selected = this.selection.has(card.dataset.videoId);
      card.classList.toggle('selected', selected);
      const box = card.querySelector('.card-select-box');
      if (box) box.setAttribute('aria-pressed', String(selected));
    });
    // 本頁影片的標籤可能剛被改過，同步到已選項目（移除標籤時的計數要準）
    for (const video of this.currentVideos) {
      if (this.selection.has(video.id)) this.selection.set(video.id, this._entryOf(video));
    }

    const bar = document.getElementById('batch-bar');
    bar.classList.toggle('hidden', !selecting);
    if (!selecting) return;
    document.getElementById('batch-count').textContent = `已選 ${this.selection.size} 部`;
    // 結果只有一頁且已全選時，「選取全部符合」等於「全選本頁」，不必顯示
    const selectAll = bar.querySelector('[data-batch="select-all"]');
    selectAll.textContent = `選取全部符合 (${this.totalVideos})`;
    const onlyPageAllSelected = this.totalVideos <= this.currentVideos.length &&
      this.currentVideos.every(v => this.selection.has(v.id));
    selectAll.classList.toggle('hidden', this.totalVideos === 0 || onlyPageAllSelected);
  }

  _setBatchStatus(text) {
    const el = document.getElementById('batch-status');
    el.textContent = text;
    clearTimeout(this._batchStatusTimer);
    if (text) this._batchStatusTimer = setTimeout(() => { el.textContent = ''; }, 5000);
  }

  _selectedFingerprints() {
    return [...this.selection.values()].map(entry => entry.fingerprint).filter(Boolean);
  }

  // 批次操作後重新載入目前頁與標籤（保持搜尋 / 篩選條件），選取保留以便接著做下一個操作
  async _afterBatchChange(message) {
    await this.refreshCurrentView();
    this.applySelectionState();
    this._setBatchStatus(message);
  }

  // ---------- 標籤選擇器（加 / 移除） ----------

  openBatchTagPicker(mode) {
    if (this.selection.size === 0) return;
    this._batchTagMode = mode;
    this._batchPicked = new Map(); // 標籤名稱 -> 是否為新建標籤
    document.getElementById('batch-tag-title').textContent =
      mode === 'add' ? `為 ${this.selection.size} 部影片加上標籤` : `從 ${this.selection.size} 部影片移除標籤`;
    const search = document.getElementById('batch-tag-search');
    search.value = '';
    search.placeholder = mode === 'add' ? '搜尋標籤，或輸入新標籤名稱後按 Enter…' : '搜尋標籤…';
    this.renderBatchTagPicker();
    document.getElementById('batch-tag-modal').classList.remove('hidden');
    search.focus();
  }

  hideBatchTagPicker() {
    document.getElementById('batch-tag-modal').classList.add('hidden');
  }

  // 每個標籤在已選影片中出現幾次
  _selectionTagCounts() {
    const counts = new Map();
    for (const entry of this.selection.values()) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return counts;
  }

  renderBatchTagPicker() {
    const mode = this._batchTagMode;
    const total = this.selection.size;
    const counts = this._selectionTagCounts();
    const query = document.getElementById('batch-tag-search').value.trim();
    const lower = query.toLowerCase();
    const matches = (name) => !lower || name.toLowerCase().includes(lower);

    const chip = (name, color, { isNew = false } = {}) => {
      const count = counts.get(name) || 0;
      const hint = isNew ? '新標籤' : (count > 0 ? `${count}/${total}` : '');
      return `
        <div class="tag-item-selector ${this._batchPicked.has(name) ? 'selected' : ''}"
             style="--tag-color: ${escapeHtml(color || '#3b82f6')};"
             data-tag-name="${escapeHtml(name)}" data-new-tag="${isNew ? '1' : '0'}">
          <div class="tag-color-selector" style="background-color: ${escapeHtml(color || '#3b82f6')};"></div>
          <div class="tag-name-selector">${isNew ? '＋ ' : ''}${escapeHtml(name)}</div>
          ${hint ? `<span class="batch-tag-count">${escapeHtml(hint)}</span>` : ''}
        </div>`;
    };

    const known = new Set();
    const groupsHtml = (this.tagsByGroup || []).map(group => {
      const tags = (group.tags || []).filter(tag => {
        known.add(tag.name);
        if (mode === 'remove' && !counts.has(tag.name)) return false;
        return matches(tag.name);
      });
      if (tags.length === 0) return '';
      return `
        <div class="tag-group-selector">
          <div class="tag-group-header-selector">
            <div class="tag-group-color-selector" style="background-color: ${escapeHtml(group.color)};"></div>
            <div class="tag-group-name-selector">${escapeHtml(group.name)}</div>
          </div>
          <div class="tags-list-selector">${tags.map(tag => chip(tag.name, tag.color)).join('')}</div>
        </div>`;
    }).join('');

    // 移除模式：影片上有、但標籤表沒有的孤兒標籤也要能移除
    let extraHtml = '';
    if (mode === 'remove') {
      const orphans = [...counts.keys()].filter(name => !known.has(name) && matches(name));
      if (orphans.length > 0) {
        extraHtml = `<div class="tag-group-selector"><div class="tag-group-header-selector"><div class="tag-group-name-selector">其他</div></div>
          <div class="tags-list-selector">${orphans.map(name => chip(name)).join('')}</div></div>`;
      }
    }

    // 加標籤模式：輸入的名稱不是既有標籤時，提供「新增」選項（建立在未分類）
    let newHtml = '';
    const allNames = [...known].map(name => name.toLowerCase());
    if (mode === 'add' && query && !allNames.includes(lower)) {
      newHtml = `<div class="tags-list-selector batch-new-tag">${chip(query, null, { isNew: true })}</div>`;
    }
    // 已點選的新標籤（搜尋框清掉後仍要顯示）
    const pickedNew = [...this._batchPicked].filter(([name, isNew]) => isNew && name !== query).map(([name]) => name);
    if (pickedNew.length > 0) {
      newHtml += `<div class="tags-list-selector batch-new-tag">${pickedNew.map(name => chip(name, null, { isNew: true })).join('')}</div>`;
    }

    const list = document.getElementById('batch-tag-list');
    const body = newHtml + groupsHtml + extraHtml;
    list.innerHTML = body || `<p class="batch-tag-empty">${mode === 'remove' ? '已選影片沒有符合的標籤' : '沒有符合的標籤'}</p>`;

    const apply = document.getElementById('batch-tag-apply');
    apply.disabled = this._batchPicked.size === 0;
    apply.textContent = this._batchPicked.size > 0
      ? `${mode === 'add' ? '加上' : '移除'} ${this._batchPicked.size} 個標籤`
      : '套用';
  }

  async applyBatchTagPicker() {
    const fingerprints = this._selectedFingerprints();
    if (fingerprints.length === 0 || this._batchPicked.size === 0) return;
    const mode = this._batchTagMode;
    const apply = document.getElementById('batch-tag-apply');
    apply.disabled = true;

    let changed = 0;
    try {
      for (const [name, isNew] of this._batchPicked) {
        if (isNew) {
          // 不指定群組 → 歸入「未分類」，與詳情頁手動輸入新標籤相同
          const created = await window.api.invoke('create-tag', { name });
          if (!created || !created.success) throw new Error(created?.error || `建立標籤「${name}」失敗`);
        }
        const result = await window.api.invoke(mode === 'add' ? 'batch-add-tag' : 'batch-remove-tag', fingerprints, name);
        if (!result.success) throw new Error(result.error);
        changed += result.changed;
      }
    } catch (error) {
      alert(`批次${mode === 'add' ? '加上' : '移除'}標籤失敗：${error.message}`);
    }

    this.hideBatchTagPicker();
    const names = [...this._batchPicked.keys()].map(n => `「${n}」`).join('');
    await this._afterBatchChange(`已${mode === 'add' ? '加上' : '移除'}${names}（${changed} 筆變更）`);
  }

  // ---------- 評分、刪除 ----------

  async batchSetRating(rating) {
    const fingerprints = this._selectedFingerprints();
    if (fingerprints.length === 0) return;
    const label = rating === 0 ? '清除評分' : `評為 ${rating} 星`;
    if (!confirm(`確定要把 ${fingerprints.length} 部影片${label}嗎？原本的評分會被覆蓋。`)) return;
    const result = await window.api.invoke('batch-set-rating', fingerprints, rating);
    if (!result.success) {
      alert(`批次評分失敗：${result.error}`);
      return;
    }
    await this._afterBatchChange(`已將 ${result.changed} 部影片${label}`);
  }

  async batchDeleteRecords() {
    const ids = [...this.selection.keys()];
    if (ids.length === 0) return;
    if (!confirm(`確定要刪除 ${ids.length} 部影片的資料庫記錄嗎？\n\n不會刪除實際檔案；之後重新掃描會再加回來，標籤也會保留。`)) return;
    const result = await window.api.invoke('batch-delete-records', ids);
    if (!result.success) {
      alert(`批次刪除失敗：${result.error}`);
      return;
    }
    this.selection.clear();
    this._selectionAnchor = null;
    await this._afterBatchChange(`已刪除 ${result.changed} 筆記錄`);
  }
}

export default BatchSelectionMethods;
