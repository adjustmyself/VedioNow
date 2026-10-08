// VideoManager 的方法群組：分頁列
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例

class PaginationMethods {
  // 分頁相關方法
  async goToPage(page) {
    if (page < 1 || page > this.totalPages || page === this.currentPage) {
      return;
    }

    this.currentPage = page;
    await this.fetchPage();
  }

  // 依頁碼容器可用寬度，計算目前頁左右各顯示幾個頁碼（越寬顯示越多）
  _computePaginationSiblings(container) {
    const available = container.clientWidth;
    // 容器寬度尚未就緒時，退回預設值
    if (!available) return 2;

    // 預留給：上一頁/下一頁、首尾頁、兩個省略號、右側資訊文字、內距與間距
    const RESERVED = 100 + 100 + 50 + 70 + 56 + 250 + 64;
    const PER_BUTTON = 68; // 單顆頁碼按鈕約略寬度（含間距，取較大值避免換行）

    const slots = Math.floor((available - RESERVED) / PER_BUTTON); // 中間可放的頁碼數（含目前頁）
    const sibling = Math.floor((Math.max(slots, 1) - 1) / 2);
    return Math.min(Math.max(sibling, 2), 20); // 至少 2、最多 20
  }

  renderPagination() {
    const paginationContainer = document.getElementById('pagination-container');
    if (!paginationContainer) {
      console.error('找不到分頁容器元素');
      return;
    }

    if (this.totalPages <= 1) {
      paginationContainer.innerHTML = '';
      return;
    }

    let paginationHTML = '';

    if (this.currentPage > 1) {
      paginationHTML += `<button class="pagination-btn" data-page="${this.currentPage - 1}">◀ 上一頁</button>`;
    }

    // 依容器寬度動態決定目前頁左右各顯示幾個頁碼
    const siblingCount = this._computePaginationSiblings(paginationContainer);
    const startPage = Math.max(1, this.currentPage - siblingCount);
    const endPage = Math.min(this.totalPages, this.currentPage + siblingCount);

    if (startPage > 1) {
      paginationHTML += `<button class="pagination-btn" data-page="1">1</button>`;
      if (startPage > 2) {
        paginationHTML += `<span class="pagination-ellipsis">...</span>`;
      }
    }

    for (let i = startPage; i <= endPage; i++) {
      const isActive = i === this.currentPage ? 'active' : '';
      paginationHTML += `<button class="pagination-btn ${isActive}" data-page="${i}">${i}</button>`;
    }

    if (endPage < this.totalPages) {
      if (endPage < this.totalPages - 1) {
        paginationHTML += `<span class="pagination-ellipsis">...</span>`;
      }
      paginationHTML += `<button class="pagination-btn" data-page="${this.totalPages}">${this.totalPages}</button>`;
    }

    if (this.currentPage < this.totalPages) {
      paginationHTML += `<button class="pagination-btn" data-page="${this.currentPage + 1}">下一頁 ▶</button>`;
    }

    // 自訂頁碼跳轉
    paginationHTML += `<span class="pagination-jump">前往 <input type="number" class="pagination-jump-input" min="1" max="${this.totalPages}" value="${this.currentPage}" aria-label="前往頁碼"> / ${this.totalPages} 頁 <button class="pagination-jump-btn">跳轉</button></span>`;

    const pageSize = this.pageSizeForView();
    const startItem = (this.currentPage - 1) * pageSize + 1;
    const endItem = Math.min(this.currentPage * pageSize, this.totalVideos);
    paginationHTML += `<div class="pagination-info">顯示第 ${startItem}-${endItem} 筆，共 ${this.totalVideos} 筆影片</div>`;

    paginationContainer.innerHTML = paginationHTML;

    // 一次性事件委派
    if (!this.paginationEventBound) {
      paginationContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.pagination-btn');
        if (btn && btn.dataset.page) {
          this.goToPage(parseInt(btn.dataset.page, 10));
          return;
        }
        if (e.target.closest('.pagination-jump-btn')) {
          this._jumpToInputPage(paginationContainer);
        }
      });
      // 在輸入框按 Enter 直接跳轉
      paginationContainer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('pagination-jump-input')) {
          e.preventDefault();
          this._jumpToInputPage(paginationContainer);
        }
      });
      this.paginationEventBound = true;
    }
  }

  // 讀取跳轉輸入框的頁碼並前往該頁（含範圍檢查）
  _jumpToInputPage(container) {
    const input = container.querySelector('.pagination-jump-input');
    if (!input) return;

    let page = parseInt(input.value, 10);
    if (isNaN(page)) {
      input.value = this.currentPage;
      return;
    }
    // 夾在有效範圍內
    page = Math.min(Math.max(page, 1), this.totalPages);
    input.value = page;
    this.goToPage(page);
  }
}

export default PaginationMethods;
