// VideoManager 的方法群組：側邊標籤篩選列：群組分頁、多面向計數、評分篩選、標籤說明 tooltip
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
const { ipcRenderer } = require('electron');
const { escapeHtml } = require('../shared/util');

class TagFilterBarMethods {
  // 自訂標籤 hover 提示框：顯示標籤說明文字與說明圖片
  setupTagTooltip() {
    if (this._tagTooltipBound) return;

    const tip = document.createElement('div');
    tip.className = 'tag-tooltip hidden';
    document.body.appendChild(tip);

    let currentName = null;

    const hide = () => {
      tip.classList.add('hidden');
      currentName = null;
    };

    const position = (anchorEl) => {
      const rect = anchorEl.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      let left = rect.left;
      let top = rect.bottom + 8;
      if (left + tipRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tipRect.width - 8;
      }
      if (left < 8) left = 8;
      // 下方放不下就改放上方
      if (top + tipRect.height > window.innerHeight - 8) {
        top = rect.top - tipRect.height - 8;
      }
      if (top < 8) top = 8;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };

    const show = (name, anchorEl) => {
      const desc = this.tagDescriptions?.get(name);
      const img = this.tagImages?.get(name);
      if (!desc && !img) { hide(); return; }
      let html = '';
      if (img) html += `<img class="tag-tooltip-img" src="${escapeHtml(img)}" alt="">`;
      if (desc) html += `<div class="tag-tooltip-text">${escapeHtml(desc)}</div>`;
      tip.innerHTML = html;
      tip.classList.remove('hidden');
      currentName = name;
      position(anchorEl);
    };

    // 同時涵蓋：篩選列 / 影片卡片 / 詳情已套用標籤（.tag[data-tag]）
    // 與詳情的標籤選擇器項目（.tag-item-selector[data-tag-name]）
    const TAG_HOVER_SELECTOR = '.tag[data-tag], .tag-item-selector[data-tag-name]';
    const resolveTagName = (el) => el.dataset.tag || el.dataset.tagName;

    document.addEventListener('mouseover', (e) => {
      const tagEl = e.target.closest(TAG_HOVER_SELECTOR);
      if (!tagEl) return;
      const name = resolveTagName(tagEl);
      if (name === currentName) return;
      show(name, tagEl);
    });

    document.addEventListener('mouseout', (e) => {
      if (e.target.closest(TAG_HOVER_SELECTOR)) hide();
    });

    // 捲動時提示位置會跑掉，直接隱藏
    document.addEventListener('scroll', () => { if (currentName) hide(); }, true);

    this._tagTooltipBound = true;
  }

  renderTagsFilter() {
    if (!this.elements.tagsFilter) {
      console.error('tagsFilter 元素不存在');
      return;
    }

    if (this.tagsByGroup.length === 0) {
      this.elements.tagsFilter.innerHTML = `
        <div class="no-tags-container">
          <span class="no-tags">尚無標籤</span>
          <p class="no-tags-hint">點選上方「標籤管理」開始建立標籤</p>
        </div>
      `;
      return;
    }

    const query = this.tagSearchQuery;
    // 沒有任何篩選條件時，強制使用原始計數，避免顯示舊資料
    if (!this.isAnyFilterActive()) {
      this.filteredTagCounts = null;
    }
    const useFiltered = this.filteredTagCounts !== null;

    // 取得標籤顯示計數 + class（多面向篩選用）
    const tagDisplay = (tag) => {
      if (!useFiltered) {
        return { countText: `${tag.video_count}`, empty: false };
      }
      const filteredCount = this.filteredTagCounts[tag.name] || 0;
      const empty = filteredCount === 0 && !this.activeTags.has(tag.name);
      const countText = filteredCount === tag.video_count
        ? `${tag.video_count}`
        : `${filteredCount}/${tag.video_count}`;
      return { countText, empty };
    };

    // 單一標籤 chip
    const renderTag = (tag) => {
      const d = tagDisplay(tag);
      const classes = ['tag'];
      if (this.activeTags.has(tag.name)) classes.push('active');
      if (d.empty) classes.push('empty-result');
      return `<span class="${classes.join(' ')}"
             data-tag="${escapeHtml(tag.name)}"
             style="--tag-color: ${escapeHtml(tag.color)};">
        ${escapeHtml(tag.name)} (${d.countText})
      </span>`;
    };

    // 已選標籤置頂區（彙整所有 group 裡被選中的）
    let pinnedHtml = '';
    if (this.activeTags.size > 0) {
      const allTagsFlat = this.tagsByGroup.flatMap(g => g.tags || []);
      const selected = allTagsFlat.filter(t => this.activeTags.has(t.name));
      if (selected.length > 0) {
        pinnedHtml = `
          <div class="tag-pinned-section">
            <div class="tag-pinned-header">已選 (${selected.length})</div>
            <div class="tag-group-tags">
              ${selected.map(renderTag).join('')}
            </div>
          </div>
        `;
      }
    }

    // 群組分頁列（tab）：固定在最上面一排，不隨選取移動
    const tabsHtml = this.tagsByGroup.map(group => {
      const allTags = group.tags || [];
      const matchCount = query
        ? allTags.filter(t => t.name.toLowerCase().includes(query)).length
        : allTags.length;
      // 搜尋中且整組無命中 → 不顯示該分頁
      if (query && matchCount === 0) return '';
      const isActive = !query && this.activeGroup === group.name;
      const groupKey = escapeHtml(group.name);
      const countText = query && matchCount !== allTags.length
        ? `${matchCount}/${allTags.length}`
        : `${allTags.length}`;
      return `
        <div class="tag-tab ${isActive ? 'active' : ''}" data-group="${groupKey}" role="button">
          <span class="tag-group-color" style="background-color: ${escapeHtml(group.color)};"></span>
          <span class="tag-group-name">${escapeHtml(group.name)}</span>
          <span class="tag-group-count">(${countText})</span>
        </div>
      `;
    }).join('');

    // 內容區：搜尋時顯示跨群組命中；否則顯示目前選取群組的標籤
    let contentHtml = '';
    if (query) {
      const matched = this.tagsByGroup.flatMap(g =>
        (g.tags || []).filter(t => t.name.toLowerCase().includes(query)));
      contentHtml = matched.length
        ? `<div class="tag-group-tags">${matched.map(renderTag).join('')}</div>`
        : `<div class="no-tags-container"><span class="no-tags">找不到符合「${escapeHtml(this.elements.tagFilterSearch?.value || '')}」的標籤</span></div>`;
    } else if (this.activeGroup) {
      const group = this.tagsByGroup.find(g => g.name === this.activeGroup);
      if (group) {
        const tags = [...(group.tags || [])];
        // 進階篩選時，把 0 命中的標籤（且未選中）排到末端
        if (useFiltered) {
          tags.sort((a, b) => {
            const aEmpty = (this.filteredTagCounts[a.name] || 0) === 0 && !this.activeTags.has(a.name) ? 1 : 0;
            const bEmpty = (this.filteredTagCounts[b.name] || 0) === 0 && !this.activeTags.has(b.name) ? 1 : 0;
            return aEmpty - bEmpty;
          });
        }
        contentHtml = `<div class="tag-group-tags">${tags.map(renderTag).join('')}</div>`;
      }
    }

    this.elements.tagsFilter.innerHTML =
      pinnedHtml +
      `<div class="tag-tabs">${tabsHtml}</div>` +
      `<div class="tag-tab-content">${contentHtml}</div>`;

    if (!this.tagFilterEventBound) {
      this.elements.tagsFilter.addEventListener('click', (e) => {
        const tab = e.target.closest('.tag-tab');
        if (tab && tab.dataset.group) {
          this.setActiveGroup(tab.dataset.group);
          return;
        }
        const tag = e.target.closest('.tag');
        if (tag && tag.dataset.tag) {
          this.toggleTagFilter(tag.dataset.tag);
        }
      });
      this.tagFilterEventBound = true;
    }
  }

  // 切換目前選取的群組分頁；再次點選同一個則收起
  setActiveGroup(groupName) {
    this.activeGroup = this.activeGroup === groupName ? null : groupName;
    this.saveActiveGroup();
    this.renderTagsFilter();
  }

  loadActiveGroup() {
    try {
      return localStorage.getItem('videonow.activeTagGroup') || null;
    } catch {
      return null;
    }
  }

  saveActiveGroup() {
    try {
      if (this.activeGroup) {
        localStorage.setItem('videonow.activeTagGroup', this.activeGroup);
      } else {
        localStorage.removeItem('videonow.activeTagGroup');
      }
    } catch (e) {
      console.warn('儲存選取群組失敗:', e);
    }
  }

  isAnyFilterActive() {
    return !!(
      (this.elements.searchInput?.value || '').trim() ||
      this.activeTags.size > 0 ||
      this.selectedRating > 0 ||
      this.selectedDrivePath
    );
  }

  // 取得目前條件下每個標籤的影片計數
  // 用 requestId 避免快速點擊時舊回應覆蓋新狀態
  async fetchFilteredTagCounts() {
    if (!this.isAnyFilterActive()) {
      this.filteredTagCounts = null;
      return;
    }
    const reqId = ++this._tagCountsReqId;
    try {
      const counts = await ipcRenderer.invoke(
        'get-filtered-tag-counts',
        this.elements.searchInput.value,
        Array.from(this.activeTags),
        { rating: this.selectedRating, drivePath: this.selectedDrivePath }
      );
      if (reqId === this._tagCountsReqId) {
        this.filteredTagCounts = counts || {};
      }
    } catch (e) {
      console.error('取得標籤篩選計數失敗:', e);
      if (reqId === this._tagCountsReqId) {
        this.filteredTagCounts = null;
      }
    }
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

    // 重置標籤搜尋關鍵字
    this.tagSearchQuery = '';
    if (this.elements.tagFilterSearch) {
      this.elements.tagFilterSearch.value = '';
    }
    this.elements.tagFilterSearchClear?.classList.add('hidden');

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
}

module.exports = TagFilterBarMethods;
