// 程式自動維護的標籤：建立合集時為主影片加上「合集」。
// 放在專屬的「系統」群組，不和使用者自己建立的標籤混在「未分類」裡。
module.exports = {
  COLLECTION_TAG: '合集',
  COLLECTION_TAG_COLOR: '#6366f1',
  SYSTEM_GROUP: {
    name: '系統',
    color: '#64748b',
    description: '程式自動加上的標籤',
    // 群組依 sort_order 排序，給大數字讓它排在使用者群組之後
    sort_order: 9999
  }
};
