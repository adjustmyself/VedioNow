// VideoManager 的方法群組：儲存的搜尋（側邊欄）：把目前的搜尋字、標籤、篩選與排序存成一筆，點一下套用
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
import { escapeHtml } from '../shared/util.js';

const SORT_LABELS = {
  file_created_at: '檔案建立時間',
  created_at: '掃描時間',
  filename: '檔案名稱',
  filesize: '檔案大小',
  duration: '影片長度',
  rating: '評分',
  play_count: '開啟次數',
  last_played_at: '最近開啟'
};

class SavedSearchMethods {
  async initSavedSearches() {
    this.savedSearches = [];

    const saveBtn = document.getElementById('saved-search-add');
    const form = document.getElementById('saved-search-form');
    const nameInput = document.getElementById('saved-search-name');

    saveBtn.addEventListener('click', () => {
      form.classList.remove('hidden');
      saveBtn.classList.add('hidden');
      nameInput.value = this._defaultSavedSearchName();
      nameInput.focus();
      nameInput.select();
    });
    document.getElementById('saved-search-cancel').addEventListener('click', () => this._closeSavedSearchForm());
    document.getElementById('saved-search-confirm').addEventListener('click', () => this.saveCurrentSearch());
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.saveCurrentSearch();
      else if (e.key === 'Escape') this._closeSavedSearchForm();
    });

    document.getElementById('saved-search-list').addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.saved-search-remove');
      if (removeBtn) {
        e.stopPropagation();
        this.deleteSavedSearch(removeBtn.dataset.id);
        return;
      }
      const item = e.target.closest('.saved-search-item');
      if (item) this.applySavedSearch(item.dataset.id);
    });
    document.getElementById('saved-search-list').addEventListener('keydown', (e) => {
      const item = e.target.closest('.saved-search-item');
      if (item && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.applySavedSearch(item.dataset.id);
      }
    });

    try {
      const result = await window.api.invoke('get-saved-searches');
      this.savedSearches = result.success ? result.searches : [];
    } catch (error) {
      console.error('載入儲存的搜尋失敗:', error);
    }
    this.renderSavedSearches();
  }

  _closeSavedSearchForm() {
    document.getElementById('saved-search-form').classList.add('hidden');
    document.getElementById('saved-search-add').classList.remove('hidden');
    this.renderSavedSearches();
  }

  // 目前的條件（與儲存格式相同，方便比對哪一筆正在套用）
  _currentSearchState() {
    return {
      searchTerm: this.elements.searchInput.value.trim(),
      tags: [...this.activeTags].sort(),
      rating: this.selectedRating,
      drivePath: this.selectedDrivePath || '',
      duplicatesOnly: !!this.duplicatesOnly,
      unwatchedOnly: !!this.unwatchedOnly,
      sortBy: this.currentSort,
      sortOrder: this.sortOrder
    };
  }

  _sameSearch(a, b) {
    return a.searchTerm === b.searchTerm &&
      JSON.stringify([...a.tags].sort()) === JSON.stringify([...b.tags].sort()) &&
      a.rating === b.rating && a.drivePath === b.drivePath &&
      a.duplicatesOnly === b.duplicatesOnly && a.unwatchedOnly === b.unwatchedOnly &&
      a.sortBy === b.sortBy && a.sortOrder === b.sortOrder;
  }

  // 依條件組出預設名稱，例如「動作 + 喜劇・★3 以上・未觀看」
  _defaultSavedSearchName() {
    const s = this._currentSearchState();
    const parts = [];
    if (s.searchTerm) parts.push(`「${s.searchTerm}」`);
    if (s.tags.length > 0) parts.push(s.tags.join(' + '));
    if (s.rating > 0) parts.push(`★${s.rating} 以上`);
    if (s.drivePath) parts.push(s.drivePath);
    if (s.duplicatesOnly) parts.push('有重複');
    if (s.unwatchedOnly) parts.push('未觀看');
    if (s.sortBy !== 'file_created_at' || s.sortOrder !== 'desc') {
      parts.push(`依${SORT_LABELS[s.sortBy] || s.sortBy}${s.sortOrder === 'asc' ? '升序' : '降序'}`);
    }
    return (parts.join('・') || '全部影片').slice(0, 60);
  }

  // 條件的簡短說明（滑過時的提示）
  _describeSavedSearch(s) {
    const lines = [];
    if (s.searchTerm) lines.push(`搜尋：${s.searchTerm}`);
    if (s.tags.length > 0) lines.push(`標籤：${s.tags.join('、')}`);
    if (s.rating > 0) lines.push(`評分：${s.rating} 星以上`);
    if (s.drivePath) lines.push(`硬碟：${s.drivePath}`);
    if (s.duplicatesOnly) lines.push('只看有重複的影片');
    if (s.unwatchedOnly) lines.push('只看未觀看的影片');
    lines.push(`排序：${SORT_LABELS[s.sortBy] || s.sortBy}（${s.sortOrder === 'asc' ? '升序' : '降序'}）`);
    return lines.join('\n');
  }

  renderSavedSearches() {
    const list = document.getElementById('saved-search-list');
    if (!list || !this.savedSearches) return;
    const current = this._currentSearchState();
    list.innerHTML = this.savedSearches.map(s => `
      <div class="rating-option saved-search-item ${this._sameSearch(current, s) ? 'active' : ''}"
           role="button" tabindex="0" data-id="${escapeHtml(s.id)}" title="${escapeHtml(this._describeSavedSearch(s))}">
        <span class="rating-label saved-search-name">${escapeHtml(s.name)}</span>
        <button type="button" class="saved-search-remove" data-id="${escapeHtml(s.id)}" title="刪除這個儲存的搜尋">✕</button>
      </div>
    `).join('');

    // 沒有任何條件時（等於全部影片）不必儲存
    document.getElementById('saved-search-add').disabled = !this.isAnyFilterActive() &&
      current.sortBy === 'file_created_at' && current.sortOrder === 'desc';
  }

  async saveCurrentSearch() {
    const nameInput = document.getElementById('saved-search-name');
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const existing = this.savedSearches.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (existing && !confirm(`已經有名為「${existing.name}」的搜尋，要用目前的條件取代嗎？`)) return;

    const result = await window.api.invoke('save-search', { name, ...this._currentSearchState() });
    if (!result.success) {
      alert(`儲存失敗：${result.error}`);
      return;
    }
    this.savedSearches = result.searches;
    this._closeSavedSearchForm();
  }

  async deleteSavedSearch(id) {
    const target = this.savedSearches.find(s => s.id === id);
    if (!target || !confirm(`刪除儲存的搜尋「${target.name}」？`)) return;
    const result = await window.api.invoke('delete-saved-search', id);
    if (!result.success) {
      alert(`刪除失敗：${result.error}`);
      return;
    }
    this.savedSearches = result.searches;
    this.renderSavedSearches();
  }

  // 套用：一次設定所有條件與對應的畫面狀態，只查詢一次
  applySavedSearch(id) {
    const s = this.savedSearches.find(item => item.id === id);
    if (!s) return;

    // 標籤改名或刪除後，篩選列上看不到它、也無法取消，這類標籤略過
    const knownTags = new Set((this.allTags || []).map(t => t.name));
    const tags = s.tags.filter(t => knownTags.has(t));
    const missing = s.tags.filter(t => !knownTags.has(t));

    this.activeTags = new Set(tags);
    this.elements.searchInput.value = s.searchTerm;

    this.selectedRating = s.rating;
    this._updateRatingFilterUI(s.rating);

    this.selectedDrivePath = s.drivePath;
    const select = this.elements.driveFilterSelect;
    if (s.drivePath && ![...select.options].some(o => o.value === s.drivePath)) {
      select.add(new Option(s.drivePath, s.drivePath));
    }
    select.value = s.drivePath;

    this.duplicatesOnly = s.duplicatesOnly;
    this.elements.duplicateFilterToggle.classList.toggle('active', s.duplicatesOnly);
    this.elements.duplicateFilterToggle.setAttribute('aria-pressed', String(s.duplicatesOnly));
    this.unwatchedOnly = s.unwatchedOnly;
    this.elements.unwatchedFilterToggle.classList.toggle('active', s.unwatchedOnly);
    this.elements.unwatchedFilterToggle.setAttribute('aria-pressed', String(s.unwatchedOnly));

    this.currentSort = s.sortBy;
    this.elements.sortSelect.value = s.sortBy;
    this.sortOrder = s.sortOrder;
    this.elements.sortOrderBtn.textContent = s.sortOrder === 'desc' ? '降序' : '升序';

    this.renderTagsFilter();
    this.handleSearch(s.searchTerm);

    if (missing.length > 0) {
      alert(`這些標籤已不存在，已略過：${missing.join('、')}`);
    }
  }
}

export default SavedSearchMethods;
