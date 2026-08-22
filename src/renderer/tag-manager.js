const { ipcRenderer } = require('electron');

// HTML escape，避免群組/標籤名稱中的 <、>、" 等字元破壞畫面或造成 XSS
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class TagManager {
  constructor() {
    this.groups = [];
    this.tagsByGroup = [];
    this.selectedGroup = null;
    this.editingGroup = null;
    this.editingTag = null;
    this.deleteCallback = null;
    this.searchQuery = '';
    this.draggingItem = null;
    this.draggingGrid = null;
    this.dragStartOrder = null;

    this.initializeElements();
    this.bindEvents();
    this.loadData();
  }

  initializeElements() {
    this.elements = {
      // 主要容器
      groupsList: document.getElementById('groups-list'),
      tagsByGroup: document.getElementById('tags-by-group'),

      // 標籤搜尋
      tagSearchInput: document.getElementById('tag-search-input'),
      tagSearchClear: document.getElementById('tag-search-clear'),

      // 按鈕
      addGroupBtn: document.getElementById('add-group-btn'),
      addTagBtn: document.getElementById('add-tag-btn'),

      // 群組模態框
      groupModal: document.getElementById('group-modal'),
      groupModalTitle: document.getElementById('group-modal-title'),
      groupForm: document.getElementById('group-form'),
      groupName: document.getElementById('group-name'),
      groupColor: document.getElementById('group-color'),
      groupDescription: document.getElementById('group-description'),
      saveGroup: document.getElementById('save-group'),
      cancelGroup: document.getElementById('cancel-group'),
      groupModalClose: document.getElementById('group-modal-close'),

      // 標籤模態框
      tagModal: document.getElementById('tag-modal'),
      tagModalTitle: document.getElementById('tag-modal-title'),
      tagForm: document.getElementById('tag-form'),
      tagName: document.getElementById('tag-name'),
      tagGroup: document.getElementById('tag-group'),
      tagColor: document.getElementById('tag-color'),
      tagDescription: document.getElementById('tag-description'),
      tagImagePreview: document.getElementById('tag-image-preview'),
      tagImagePick: document.getElementById('tag-image-pick'),
      tagImageRemove: document.getElementById('tag-image-remove'),
      saveTag: document.getElementById('save-tag'),
      cancelTag: document.getElementById('cancel-tag'),
      tagModalClose: document.getElementById('tag-modal-close'),

      // 確認刪除模態框
      confirmModal: document.getElementById('confirm-modal'),
      confirmMessage: document.getElementById('confirm-message'),
      confirmDelete: document.getElementById('confirm-delete'),
      cancelDelete: document.getElementById('cancel-delete'),
      confirmModalClose: document.getElementById('confirm-modal-close')
    };
  }

  bindEvents() {
    // 主要按鈕
    this.elements.addGroupBtn.addEventListener('click', () => this.showGroupModal());
    this.elements.addTagBtn.addEventListener('click', () => this.showTagModal());

    // 群組模態框
    this.elements.saveGroup.addEventListener('click', () => this.saveGroup());
    this.elements.cancelGroup.addEventListener('click', () => this.hideGroupModal());
    this.elements.groupModalClose.addEventListener('click', () => this.hideGroupModal());

    // 標籤模態框
    this.elements.saveTag.addEventListener('click', () => this.saveTag());
    this.elements.cancelTag.addEventListener('click', () => this.hideTagModal());
    this.elements.tagModalClose.addEventListener('click', () => this.hideTagModal());
    this.elements.tagImagePick.addEventListener('click', () => this.pickTagImage());
    this.elements.tagImageRemove.addEventListener('click', () => this.setTagImage(''));

    // 確認刪除模態框
    this.elements.confirmDelete.addEventListener('click', () => this.executeDelete());
    this.elements.cancelDelete.addEventListener('click', () => this.hideConfirmModal());
    this.elements.confirmModalClose.addEventListener('click', () => this.hideConfirmModal());

    // 標籤搜尋
    this.elements.tagSearchInput.addEventListener('input', () => {
      this.searchQuery = this.elements.tagSearchInput.value.trim().toLowerCase();
      this.elements.tagSearchClear.classList.toggle('hidden', this.searchQuery === '');
      this.renderTagsByGroup();
    });
    this.elements.tagSearchClear.addEventListener('click', () => {
      this.elements.tagSearchInput.value = '';
      this.searchQuery = '';
      this.elements.tagSearchClear.classList.add('hidden');
      this.renderTagsByGroup();
      this.elements.tagSearchInput.focus();
    });

    // 標籤拖曳排序
    this.bindTagDragEvents();

    // 顏色預設選擇
    this.bindColorPresets();

    // 事件委託處理動態按鈕
    document.addEventListener('click', (e) => {
      // 模態框背景點擊（標籤編輯框不再點擊外面就關閉，只能用 X 關閉）
      if (e.target === this.elements.groupModal) this.hideGroupModal();
      if (e.target === this.elements.confirmModal) this.hideConfirmModal();

      // 處理群組編輯按鈕
      if (e.target.dataset.action === 'edit-group') {
        const groupId = e.target.dataset.groupId;
        this.editGroup(groupId);
        return;
      }

      // 處理群組刪除按鈕
      if (e.target.dataset.action === 'delete-group') {
        const groupId = e.target.dataset.groupId;
        this.deleteGroup(groupId);
        return;
      }

      // 處理標籤編輯按鈕
      if (e.target.dataset.action === 'edit-tag') {
        const tagId = e.target.dataset.tagId;
        this.editTag(tagId);
        return;
      }

      // 處理標籤刪除按鈕
      if (e.target.dataset.action === 'delete-tag') {
        const tagId = e.target.dataset.tagId;
        this.deleteTag(tagId);
        return;
      }
    });

    // 按鍵事件
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideGroupModal();
        this.hideTagModal();
        this.hideConfirmModal();
      }
    });
  }

  bindColorPresets() {
    const presets = document.querySelectorAll('.color-preset');
    presets.forEach(preset => {
      preset.addEventListener('click', () => {
        const color = preset.dataset.color;
        const colorInput = preset.closest('.color-picker').querySelector('input[type="color"]');
        colorInput.value = color;
      });
    });
  }

  async loadData() {
    try {
      await Promise.all([
        this.loadGroups(),
        this.loadTagsByGroup()
      ]);
      this.renderGroups();
      this.renderTagsByGroup();
      this.updateTagGroupSelect();
    } catch (error) {
      console.error('載入資料錯誤:', error);
    }
  }

  async loadGroups() {
    this.groups = await ipcRenderer.invoke('get-all-tag-groups');
  }

  async loadTagsByGroup() {
    this.tagsByGroup = await ipcRenderer.invoke('get-tags-by-group');
  }

  renderGroups() {
    if (this.groups.length === 0) {
      this.elements.groupsList.innerHTML = `
        <div class="empty-state">
          <h3>尚無群組</h3>
          <p>點選「新增群組」開始建立標籤分類</p>
        </div>
      `;
      return;
    }

    this.elements.groupsList.innerHTML = this.groups.map(group => `
      <div class="group-item ${this.selectedGroup?.id === group.id ? 'active' : ''}" data-group-id="${escapeHtml(group.id)}">
        <div class="group-header">
          <div class="group-name">${escapeHtml(group.name)}</div>
          <div class="group-color" style="background-color: ${escapeHtml(group.color)};"></div>
        </div>
        <div class="group-stats">${group.tag_count} 個標籤</div>
        ${group.description ? `<div class="group-description">${escapeHtml(group.description)}</div>` : ''}
        <div class="group-actions">
          <button class="btn-icon" data-action="edit-group" data-group-id="${escapeHtml(group.id)}" title="編輯">✏️</button>
          <button class="btn-icon" data-action="delete-group" data-group-id="${escapeHtml(group.id)}" title="刪除">🗑️</button>
        </div>
      </div>
    `).join('');

    // 綁定群組選擇事件
    this.elements.groupsList.querySelectorAll('.group-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.group-actions')) return;
        // id 是字串（Mongo ObjectId 或 SQLite 數字字串），不可 parseInt
        this.selectGroup(item.dataset.groupId);
      });
    });
  }

  renderTagsByGroup() {
    if (this.tagsByGroup.length === 0) {
      this.elements.tagsByGroup.innerHTML = `
        <div class="empty-state">
          <h3>尚無標籤</h3>
          <p>點選「新增標籤」開始建立標籤</p>
        </div>
      `;
      return;
    }

    // 有選取群組時只顯示該群組，否則顯示全部
    let groupsToShow = this.selectedGroup
      ? this.tagsByGroup.filter(g => g.id === this.selectedGroup.id)
      : this.tagsByGroup;

    // 搜尋時依標籤名稱／說明過濾，並移除沒有符合標籤的群組
    if (this.searchQuery) {
      const q = this.searchQuery;
      groupsToShow = groupsToShow
        .map(group => ({
          ...group,
          tags: group.tags.filter(tag =>
            tag.name.toLowerCase().includes(q) ||
            (tag.description || '').toLowerCase().includes(q)
          )
        }))
        .filter(group => group.tags.length > 0);

      if (groupsToShow.length === 0) {
        this.elements.tagsByGroup.innerHTML = `
          <div class="empty-state">
            <h3>找不到符合的標籤</h3>
            <p>試試其他關鍵字</p>
          </div>
        `;
        return;
      }
    }

    // 搜尋時顯示的是過濾後的子集，拖曳寫回會弄壞沒顯示到的標籤順序，因此停用拖曳
    const canReorder = !this.searchQuery;

    this.elements.tagsByGroup.innerHTML = groupsToShow.map(group => `
      <div class="tag-group-section">
        <div class="tag-group-header">
          <div class="tag-group-color" style="background-color: ${escapeHtml(group.color)};"></div>
          <div class="tag-group-title">${escapeHtml(group.name)}</div>
          ${canReorder && group.tags.length > 1 ? '<div class="tag-group-hint">拖曳可調整順序</div>' : ''}
          <div class="tag-group-count">${group.tags.length} 個標籤</div>
        </div>
        <div class="tags-grid${canReorder ? ' reorderable' : ''}" data-group-id="${escapeHtml(group.id)}">
          ${group.tags.length === 0
            ? '<div class="empty-state"><p>此群組尚無標籤</p></div>'
            : group.tags.map(tag => `
                <div class="tag-item" data-tag-id="${escapeHtml(tag.id)}" draggable="${canReorder}"${tag.description ? ` title="${escapeHtml(tag.description)}"` : ''}>
                  <div class="tag-header">
                    <div class="tag-name">
                      <div class="tag-color" style="background-color: ${escapeHtml(tag.color)};"></div>
                      ${escapeHtml(tag.name)}
                    </div>
                    <div class="tag-actions">
                      <button class="btn-icon" data-action="edit-tag" data-tag-id="${escapeHtml(tag.id)}" title="編輯">✏️</button>
                      <button class="btn-icon" data-action="delete-tag" data-tag-id="${escapeHtml(tag.id)}" title="刪除">🗑️</button>
                    </div>
                  </div>
                  ${tag.description ? `<div class="tag-description">${escapeHtml(tag.description)}</div>` : ''}
                  <div class="tag-stats">${tag.video_count} 個影片</div>
                </div>
              `).join('')
          }
        </div>
      </div>
    `).join('');
  }

  // 群組內拖曳排序：用原生 HTML5 DnD，事件委派在容器上綁一次（卡片每次重繪都會重建）
  bindTagDragEvents() {
    const container = this.elements.tagsByGroup;

    container.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.tag-item');
      if (!item || item.getAttribute('draggable') !== 'true') return;

      this.draggingItem = item;
      this.draggingGrid = item.closest('.tags-grid');
      this.dragStartOrder = this.readGridOrder(this.draggingGrid);
      e.dataTransfer.effectAllowed = 'move';
      // 不設 data 有些平台不會觸發 drop
      e.dataTransfer.setData('text/plain', item.dataset.tagId || '');
      // 延後加樣式，否則拖曳縮圖會跟著變半透明
      setTimeout(() => item.classList.add('dragging'), 0);
    });

    container.addEventListener('dragover', (e) => {
      if (!this.draggingItem) return;
      // 只允許同群組內移動；要換群組請用編輯視窗改「所屬群組」
      const grid = e.target.closest('.tags-grid');
      if (grid !== this.draggingGrid) return;

      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const target = e.target.closest('.tag-item');
      if (!target || target === this.draggingItem) return;

      // grid 是多欄排列，用目標卡片的水平中線判斷插在它前面還是後面
      const rect = target.getBoundingClientRect();
      const insertAfter = e.clientX > rect.left + rect.width / 2;
      grid.insertBefore(this.draggingItem, insertAfter ? target.nextSibling : target);
    });

    container.addEventListener('drop', (e) => {
      if (this.draggingItem) e.preventDefault();
    });

    // 用 dragend 收尾：拖到容器外放開時不會有 drop，但一定會有 dragend
    container.addEventListener('dragend', () => {
      if (!this.draggingItem) return;

      const grid = this.draggingGrid;
      const previousOrder = this.dragStartOrder || [];
      this.draggingItem.classList.remove('dragging');
      this.draggingItem = null;
      this.draggingGrid = null;
      this.dragStartOrder = null;
      if (!grid) return;

      const newOrder = this.readGridOrder(grid);
      if (newOrder.join('|') === previousOrder.join('|')) return;
      this.saveTagOrder(grid.dataset.groupId || null, newOrder);
    });
  }

  readGridOrder(grid) {
    if (!grid) return [];
    return Array.from(grid.querySelectorAll('.tag-item')).map(el => el.dataset.tagId);
  }

  // 先更新本地資料再寫入資料庫；失敗就整份重載，避免畫面與資料庫不一致
  async saveTagOrder(groupId, orderedIds) {
    this.applyLocalTagOrder(groupId, orderedIds);

    try {
      const result = await ipcRenderer.invoke('reorder-tags', groupId, orderedIds);
      if (result && result.success === false) {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('儲存標籤順序失敗:', error);
      alert('儲存排序失敗，已還原原本的順序');
      await this.loadData();
    }
  }

  // 同步 this.tagsByGroup 的順序，之後任何重繪才不會跳回舊順序
  applyLocalTagOrder(groupId, orderedIds) {
    const group = this.tagsByGroup.find(g => (g.id || null) === groupId);
    if (!group) return;

    const byId = new Map(group.tags.map(tag => [tag.id, tag]));
    const reordered = orderedIds.map(id => byId.get(id)).filter(Boolean);
    // 保險：沒出現在清單裡的標籤補在最後，不讓資料憑空消失
    for (const tag of group.tags) {
      if (!orderedIds.includes(tag.id)) reordered.push(tag);
    }
    group.tags = reordered;
  }

  updateTagGroupSelect() {
    const options = [
      '<option value="">未分類</option>',
      ...this.groups.map(group =>
        `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`
      )
    ].join('');
    this.elements.tagGroup.innerHTML = options;
  }

  selectGroup(groupId) {
    // 再次點選同一群組 → 取消篩選，恢復顯示全部群組
    if (this.selectedGroup?.id === groupId) {
      this.selectedGroup = null;
    } else {
      this.selectedGroup = this.groups.find(g => g.id === groupId);
    }
    this.renderGroups();
    this.renderTagsByGroup();
  }

  // 群組管理方法
  showGroupModal(group = null) {
    this.editingGroup = group;

    if (group) {
      this.elements.groupModalTitle.textContent = '編輯群組';
      this.elements.groupName.value = group.name;
      this.elements.groupColor.value = group.color;
      this.elements.groupDescription.value = group.description || '';
    } else {
      this.elements.groupModalTitle.textContent = '新增群組';
      this.elements.groupForm.reset();
      this.elements.groupColor.value = '#6366f1';
    }

    this.elements.groupModal.classList.remove('hidden');
  }

  hideGroupModal() {
    this.elements.groupModal.classList.add('hidden');
    this.editingGroup = null;
  }

  async saveGroup() {
    const formData = new FormData(this.elements.groupForm);
    const groupData = {
      name: formData.get('group-name') || this.elements.groupName.value,
      color: this.elements.groupColor.value,
      description: this.elements.groupDescription.value
    };

    try {
      if (this.editingGroup) {
        await ipcRenderer.invoke('update-tag-group', this.editingGroup.id, groupData);
      } else {
        await ipcRenderer.invoke('create-tag-group', groupData);
      }

      this.hideGroupModal();
      await this.loadData();
    } catch (error) {
      console.error('儲存群組錯誤:', error);
      alert('儲存失敗，請重試');
    }
  }

  editGroup(groupId) {
    const group = this.groups.find(g => g.id === groupId);
    if (group) {
      this.showGroupModal(group);
    }
  }

  deleteGroup(groupId) {
    const group = this.groups.find(g => g.id === groupId);
    if (group) {
      this.elements.confirmMessage.textContent =
        `確定要刪除群組「${group.name}」嗎？群組內的標籤將移至未分類。`;
      this.deleteCallback = async () => {
        await ipcRenderer.invoke('delete-tag-group', groupId);
        await this.loadData();
      };
      this.elements.confirmModal.classList.remove('hidden');
    }
  }

  // 標籤管理方法
  showTagModal(tag = null) {
    this.editingTag = tag;

    if (tag) {
      this.elements.tagModalTitle.textContent = '編輯標籤';
      this.elements.tagName.value = tag.name;
      this.elements.tagColor.value = tag.color;
      this.elements.tagGroup.value = tag.group_id || '';
      this.elements.tagDescription.value = tag.description || '';
      this.setTagImage(tag.description_image || '');
    } else {
      this.elements.tagModalTitle.textContent = '新增標籤';
      this.elements.tagForm.reset();
      this.elements.tagColor.value = '#3b82f6';
      this.setTagImage('');
    }

    this.elements.tagModal.classList.remove('hidden');
  }

  hideTagModal() {
    this.elements.tagModal.classList.add('hidden');
    this.editingTag = null;
  }

  // 透過主行程開啟檔案對話框選圖並複製到 userData/tag-images，回傳的檔名存進標籤
  async pickTagImage() {
    try {
      const result = await ipcRenderer.invoke('pick-tag-image');
      if (result && result.success) {
        this.setTagImage(result.filename);
      } else if (result && result.error) {
        alert('選取圖片失敗: ' + result.error);
      }
    } catch (error) {
      console.error('選取標籤圖片錯誤:', error);
      alert('選取圖片失敗，請重試');
    }
  }

  // 取得標籤圖片資料夾絕對路徑（快取）
  async getTagImagesDir() {
    if (this._tagImagesDir === undefined) {
      this._tagImagesDir = await ipcRenderer.invoke('get-tag-images-dir');
    }
    return this._tagImagesDir;
  }

  // 將資料庫值（檔名；或相容舊版的絕對路徑）轉成正規的 file:// URL
  async resolveTagImageUrl(value) {
    if (!value) return '';
    const path = require('path');
    const { pathToFileURL } = require('url');
    const isAbsolute = /[\\/]/.test(value) || /^[a-zA-Z]:/.test(value);
    const abs = isAbsolute ? value : path.join(await this.getTagImagesDir(), value);
    return pathToFileURL(abs).href;
  }

  // 設定目前標籤圖片檔名並更新預覽（空字串=清除）
  async setTagImage(imageFilename) {
    this.tagImagePath = imageFilename || '';
    const preview = this.elements.tagImagePreview;
    if (this.tagImagePath) {
      const url = await this.resolveTagImageUrl(this.tagImagePath);
      // 加上時間戳避免換圖後仍顯示舊快取
      const src = `${url}?t=${Date.now()}`;
      preview.classList.remove('empty');
      preview.innerHTML = `<img src="${escapeHtml(src)}" alt="標籤說明圖片">`;
      this.elements.tagImageRemove.classList.remove('hidden');
    } else {
      preview.classList.add('empty');
      preview.innerHTML = '<span class="tag-image-placeholder">尚未選擇圖片</span>';
      this.elements.tagImageRemove.classList.add('hidden');
    }
  }

  async saveTag() {
    const tagData = {
      name: this.elements.tagName.value.trim(),
      color: this.elements.tagColor.value,
      description: this.elements.tagDescription.value.trim(),
      description_image: this.tagImagePath || '',
      group_id: this.elements.tagGroup.value || null
    };

    if (!tagData.name) {
      alert('請輸入標籤名稱');
      return;
    }

    try {
      let result;
      if (this.editingTag) {
        console.log('更新標籤:', this.editingTag.id, tagData);
        result = await ipcRenderer.invoke('update-tag', this.editingTag.id, tagData);
      } else {
        console.log('創建標籤:', tagData);
        result = await ipcRenderer.invoke('create-tag', tagData);
      }

      console.log('標籤操作結果:', result);

      if (result && result.success === false) {
        alert(`操作失敗: ${result.error}`);
        return;
      }

      this.hideTagModal();
      await this.loadData();
    } catch (error) {
      console.error('儲存標籤錯誤:', error);
      alert('儲存失敗，請重試');
    }
  }

  editTag(tagId) {
    console.log('編輯標籤:', tagId);
    console.log('可用的標籤群組:', this.tagsByGroup);

    let tag = null;
    for (const group of this.tagsByGroup) {
      tag = group.tags.find(t => t.id === tagId);
      if (tag) {
        tag.group_id = group.id;
        break;
      }
    }

    console.log('找到的標籤:', tag);

    if (tag) {
      this.showTagModal(tag);
    } else {
      alert('找不到要編輯的標籤');
    }
  }

  deleteTag(tagId) {
    let tag = null;
    for (const group of this.tagsByGroup) {
      tag = group.tags.find(t => t.id === tagId);
      if (tag) break;
    }

    if (tag) {
      this.elements.confirmMessage.textContent =
        `確定要刪除標籤「${tag.name}」嗎？這會從所有影片中移除此標籤。`;
      this.deleteCallback = async () => {
        console.log('刪除標籤:', tagId);
        const result = await ipcRenderer.invoke('delete-tag', tagId);
        console.log('刪除結果:', result);

        if (result && result.success === false) {
          alert(`刪除失敗: ${result.error}`);
          return;
        }

        await this.loadData();
      };
      this.elements.confirmModal.classList.remove('hidden');
    }
  }

  // 確認刪除模態框
  hideConfirmModal() {
    this.elements.confirmModal.classList.add('hidden');
    this.deleteCallback = null;
  }

  async executeDelete() {
    if (this.deleteCallback) {
      try {
        await this.deleteCallback();
        this.hideConfirmModal();
      } catch (error) {
        console.error('刪除錯誤:', error);
        alert('刪除失敗，請重試');
      }
    }
  }
}

// 初始化標籤管理器
const tagManager = new TagManager();

// 全域函數供HTML調用
window.tagManager = tagManager;