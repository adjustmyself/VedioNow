// VideoManager 的方法群組：格狀檢視依可用寬高決定欄數與每頁筆數（1080p / 2K / 4K 適配）
// 由 renderer.js 以 mixin 方式併入 VideoManager.prototype，方法內的 this 即 VideoManager 實例
//
// 目標是格狀檢視不出現捲軸：卡片高度固定（縮圖 16:9 + 固定高度的文字區，標籤只排一行），
// 每頁筆數 = 欄數 × 畫面放得下的列數

const GRID_MAX_COLUMNS = 10;
// 四捨五入誤差的保留量，避免差 1px 就冒出捲軸
const FIT_SLACK = 2;

// 欄數取寬度的平方根，螢幕越大欄數越多、卡片也越大：
// 內容區（視窗寬扣掉 280px 側欄）1080p 約 1640px → 4 欄、2K 約 2280px → 4 欄、
// 4K 100% 縮放約 3560px → 5 欄（卡片約 680px 寬）。
// 用的是 CSS px，Windows 顯示縮放 150% 的 4K 會與 2K 同欄數（同樣大小、只是更清晰）
export function gridColumnsForWidth(width) {
  if (!(width > 0)) return 3;
  return Math.max(1, Math.min(GRID_MAX_COLUMNS, Math.floor(Math.sqrt(width / 100))));
}

// 依格子內部可用寬高（已扣內距）決定欄數與列數。
// 欄數只看寬度：上方標籤篩選列展開 / 收合讓高度變動時，卡片大小與欄數維持不變，只增減列數。
// 列數至少 1（視窗矮到一列都放不下時只能捲動）
export function planGrid({ areaWidth, innerWidth, innerHeight, columnGap, rowGap, contentHeight }) {
  const columns = gridColumnsForWidth(areaWidth);
  // 量不到（視窗尚未排版）：列數 0，由 pageSizeForView 退回設定值
  if (!(innerWidth > 0) || !(innerHeight > 0)) return { columns, rows: 0 };
  const cardWidth = (innerWidth - columnGap * (columns - 1)) / columns;
  const cardHeight = cardWidth * 9 / 16 + contentHeight;
  const rows = Math.floor((innerHeight - FIT_SLACK + rowGap) / (cardHeight + rowGap));
  return { columns, rows: Math.max(1, rows) };
}

class GridLayoutMethods {
  // 觀察內容區與分頁列大小（影片容器沒資料時會 display:none，量不到），欄數或列數變了才重查
  initGridLayout() {
    const area = this.elements.videosContainer.parentElement;
    this._applyGridLayout(this._measureGridLayout(area));
    const onResize = () => {
      // 卡片寬度變了，一行放得下的標籤數也會變
      clearTimeout(this._cardTagsFitTimer);
      this._cardTagsFitTimer = setTimeout(() => this.fitAllCardTags(), 150);

      const layout = this._measureGridLayout(area);
      if (layout.columns === this.gridColumns && layout.rows === this.gridRows) return;
      // 拖曳視窗邊框時會連續跨過好幾個欄數，等停下來再重查；
      // 比較基準是目前畫面那一頁的筆數，不是中途某個欄數的
      if (this._gridSizeBeforeResize === undefined) {
        this._gridSizeBeforeResize = this.pageSizeForView();
      }
      this._applyGridLayout(layout);
      clearTimeout(this._gridRepaginateTimer);
      this._gridRepaginateTimer = setTimeout(() => {
        const before = this._gridSizeBeforeResize;
        this._gridSizeBeforeResize = undefined;
        this.repaginate(before);
      }, 200);
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(area);
    // 分頁列在窄視窗可能折成兩行，高度變了也要重算列數
    const pagination = document.getElementById('pagination-container');
    if (pagination) observer.observe(pagination);
  }

  // 依內容區寬高推算欄數與列數。高度扣掉工具列與分頁列；
  // 批次操作列疊在工具列上（見 styles.css .batch-bar），不佔高度，進入多選不會換頁
  _measureGridLayout(area) {
    const grid = this.elements.videosContainer;
    const style = getComputedStyle(grid);
    const px = (value) => parseFloat(value) || 0;

    const toolbar = area.querySelector('.toolbar');
    const toolbarHeight = toolbar ? toolbar.offsetHeight : 0;
    area.style.setProperty('--toolbar-height', `${toolbarHeight}px`);

    // 第一次量的時候分頁列還沒有按鈕，以一排按鈕的高度為下限
    const pagination = document.getElementById('pagination-container');
    const paginationHeight = pagination
      ? Math.max(pagination.offsetHeight, px(style.getPropertyValue('--pagination-min-height')))
      : 0;

    return planGrid({
      areaWidth: area.clientWidth,
      innerWidth: area.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
      innerHeight: area.clientHeight - toolbarHeight - paginationHeight -
        px(style.paddingTop) - px(style.paddingBottom),
      columnGap: px(style.columnGap),
      rowGap: px(style.rowGap),
      contentHeight: px(style.getPropertyValue('--card-content-height'))
    });
  }

  _applyGridLayout({ columns, rows }) {
    this.gridColumns = columns;
    this.gridRows = rows;
    this.elements.videosContainer.style.setProperty('--grid-cols', String(columns));
  }

  // 目前檢視實際每頁筆數：格狀為欄數 × 放得下的列數（量不到時退回設定值補滿整列），列表直接用設定值
  pageSizeForView() {
    if (this.viewMode !== 'grid') return this.pageSize;
    if (this.gridRows > 0) return this.gridColumns * this.gridRows;
    return Math.ceil(this.pageSize / this.gridColumns) * this.gridColumns;
  }

  // 每頁筆數變了：換到包含原本第一筆的那一頁並重查；回傳是否已重查
  repaginate(previousSize) {
    const size = this.pageSizeForView();
    if (size === previousSize) return false;
    const firstIndex = (this.currentPage - 1) * previousSize;
    this.currentPage = Math.floor(firstIndex / size) + 1;
    if (this.totalVideos === 0) return false;
    this.fetchPage();
    return true;
  }

  // 卡片標籤只排一行（卡片高度才固定）：放不下的標籤收進「+N」，hover 看完整名單
  fitCardTags(card, video) {
    const box = card.querySelector('.video-tags');
    if (!box || !video.tags || video.tags.length === 0) return;
    box.innerHTML = this._videoTagsHtml(video);
    let limit = video.tags.length;
    while (box.scrollWidth > box.clientWidth && limit > 0) {
      limit--;
      box.innerHTML = this._videoTagsHtml(video, limit);
    }
  }

  fitAllCardTags() {
    if (this.viewMode !== 'grid') return;
    const byId = new Map(this.currentVideos.map(video => [String(video.id), video]));
    this.elements.videosContainer.querySelectorAll('.video-card').forEach(card => {
      const video = byId.get(card.dataset.videoId);
      if (video) this.fitCardTags(card, video);
    });
  }
}

export default GridLayoutMethods;
