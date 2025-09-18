const { ipcRenderer } = require('electron');

class TagManager {
  constructor() {
    this.groups = [];
    this.tagsByGroup = [];
    this.selectedGroup = null;
    this.editingGroup = null;
    this.editingTag = null;
    this.deleteCallback = null;

    this.initializeElements();
    this.bindEvents();
    this.loadData();
  }

  initializeElements() {
    this.elements = {
      // 主要容器
      groupsList: document.getElementById('groups-list'),
      tagsByGroup: document.getElementById('tags-by-group'),

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

    // 確認刪除模態框
    this.elements.confirmDelete.addEventListener('click', () => this.executeDelete());
    this.elements.cancelDelete.addEventListener('click', () => this.hideConfirmModal());
    this.elements.confirmModalClose.addEventListener('click', () => this.hideConfirmModal());

    // 顏色預設選擇
    this.bindColorPresets();

    // 事件委託處理動態按鈕
    document.addEventListener('click', (e) => {
      // 模態框背景點擊
      if (e.target === this.elements.groupModal) this.hideGroupModal();
      if (e.target === this.elements.tagModal) this.hideTagModal();
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
      <div class="group-item ${this.selectedGroup?.id === group.id ? 'active' : ''}" data-group-id="${group.id}">
        <div class="group-header">
          <div class="group-name">${group.name}</div>
          <div class="group-color" style="background-color: ${group.color};"></div>
        </div>
        <div class="group-stats">${group.tag_count} 個標籤</div>
        ${group.description ? `<div class="group-description">${group.description}</div>` : ''}
        <div class="group-actions">
          <button class="btn-icon" data-action="edit-group" data-group-id="${group.id}" title="編輯">✏️</button>
          <button class="btn-icon" data-action="delete-group" data-group-id="${group.id}" title="刪除">🗑️</button>
        </div>
      </div>
    `).join('');

    // 綁定群組選擇事件
    this.elements.groupsList.querySelectorAll('.group-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.group-actions')) return;
        const groupId = parseInt(item.dataset.groupId);
        this.selectGroup(groupId);
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

    this.elements.tagsByGroup.innerHTML = this.tagsByGroup.map(group => `
      <div class="tag-group-section">
        <div class="tag-group-header">
          <div class="tag-group-color" style="background-color: ${group.color};"></div>
          <div class="tag-group-title">${group.name}</div>
          <div class="tag-group-count">${group.tags.length} 個標籤</div>
        </div>
        <div class="tags-grid">
          ${group.tags.length === 0
            ? '<div class="empty-state"><p>此群組尚無標籤</p></div>'
            : group.tags.map(tag => `
                <div class="tag-item" data-tag-id="${tag.id}">
                  <div class="tag-header">
                    <div class="tag-name">
                      <div class="tag-color" style="background-color: ${tag.color};"></div>
                      ${tag.name}
                    </div>
                    <div class="tag-actions">
                      <button class="btn-icon" data-action="edit-tag" data-tag-id="${tag.id}" title="編輯">✏️</button>
                      <button class="btn-icon" data-action="delete-tag" data-tag-id="${tag.id}" title="刪除">🗑️</button>
                    </div>
                  </div>
                  <div class="tag-stats">${tag.video_count} 個影片</div>
                </div>
              `).join('')
          }
        </div>
      </div>
    `).join('');
  }

  updateTagGroupSelect() {
    const options = [
      '<option value="">未分類</option>',
      ...this.groups.map(group =>
        `<option value="${group.id}">${group.name}</option>`
      )
    ].join('');
    this.elements.tagGroup.innerHTML = options;
  }

  selectGroup(groupId) {
    this.selectedGroup = this.groups.find(g => g.id === groupId);
    this.renderGroups();
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
    } else {
      this.elements.tagModalTitle.textContent = '新增標籤';
      this.elements.tagForm.reset();
      this.elements.tagColor.value = '#3b82f6';
    }

    this.elements.tagModal.classList.remove('hidden');
  }

  hideTagModal() {
    this.elements.tagModal.classList.add('hidden');
    this.editingTag = null;
  }

  async saveTag() {
    const tagData = {
      name: this.elements.tagName.value.trim(),
      color: this.elements.tagColor.value,
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