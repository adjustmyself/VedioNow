// 命令列加標籤：讓外部程式（例如批次翻譯腳本）把影片標上標籤
//   VedioNow.exe --add-tag=中文 --tag-group=字幕 "影片1.mp4" "影片2.mkv"
// 程式已在執行時，新開的實例只把指令交給既有實例（second-instance 的 additionalData）就結束；
// 沒在執行則正常啟動，初始化完成後處理。
// 已有該標籤的影片不會重複加；資料庫還沒有的影片會先加入再標記。

// 從 argv 取出加標籤指令；沒有 --add-tag 回傳 null。
// argv 需已去掉執行檔（打包版）或 electron 與 app 路徑（開發版），只剩使用者參數
function parseTagCommand(argv) {
  let tagName = '';
  let groupName = '';
  const files = [];
  for (const arg of argv || []) {
    if (typeof arg !== 'string' || !arg) continue;
    const match = arg.match(/^--(add-tag|tag-group)=(.*)$/s);
    if (match) {
      if (match[1] === 'add-tag') tagName = match[2].trim();
      else groupName = match[2].trim();
    } else if (!arg.startsWith('--')) {
      files.push(arg);
    }
  }
  if (!tagName) return null;
  return { tagName, groupName, files: [...new Set(files)] };
}

// 確認標籤存在：任何群組已有同名標籤就沿用（關聯以名稱存放）；
// 沒有則建在指定群組（群組不存在就建立），沒指定群組就交給啟動時的孤兒標籤補建放進未分類
async function ensureTag(db, tagName, groupName) {
  if (!groupName) return;
  const groups = await db.getTagsByGroup();
  if (groups.some(group => (group.tags || []).some(tag => tag.name === tagName))) return;
  const group = groups.find(g => g.id != null && g.name === groupName);
  const groupId = group ? group.id : await db.createTagGroup({ name: groupName });
  await db.createTag({ name: tagName, group_id: groupId });
}

// 執行加標籤指令。importFiles(filepaths) 負責把資料庫還沒有的影片加入
async function runTagCommand(db, command, importFiles) {
  const { tagName, groupName, files } = command;
  await ensureTag(db, tagName, groupName);

  const missing = [];
  for (const filepath of files) {
    if (!await db.getVideoByPath(filepath)) missing.push(filepath);
  }
  if (missing.length > 0) await importFiles(missing);

  const fingerprints = [];
  const notFound = [];
  for (const filepath of files) {
    const video = await db.getVideoByPath(filepath);
    if (video && video.fingerprint) fingerprints.push(video.fingerprint);
    else notFound.push(filepath);
  }
  const added = fingerprints.length > 0 ? await db.addTagToVideos(fingerprints, tagName) : 0;
  return { added, alreadyTagged: fingerprints.length - added, imported: missing.length - notFound.length, notFound };
}

module.exports = { parseTagCommand, ensureTag, runTagCommand };
