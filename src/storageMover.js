const path = require('path');
const fs = require('fs-extra');

// 變更存放位置時要搬的子資料夾
const IMAGE_SUBDIRS = ['thumbnails', 'previews', 'tag-images'];
const BACKUP_SUBDIRS = ['auto', 'pre-restore'];

// Windows / macOS 路徑不分大小寫
function normalize(p) {
  const resolved = path.resolve(p);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

function samePath(a, b) {
  return normalize(a) === normalize(b);
}

function isInside(child, parent) {
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 檢查能否把 subdirs 從 fromDir 搬到 toDir；不合格時丟出錯誤。
// 來源與目的子資料夾不能互相包含（例如新位置選在舊的 thumbnails 裡面），否則複製會遞迴或搬完被刪掉
async function validateTarget(fromDir, toDir, subdirs) {
  if (!toDir || !path.isAbsolute(toDir)) throw new Error('請選擇一個完整路徑的資料夾');
  if (samePath(fromDir, toDir)) throw new Error('新位置與目前位置相同');
  for (const sub of subdirs) {
    const src = path.join(fromDir, sub);
    const dest = path.join(toDir, sub);
    if (isInside(dest, src) || isInside(src, dest)) {
      throw new Error(`新位置不能在 ${src} 裡面，也不能包含它`);
    }
  }

  // 先確認可寫入，避免搬到一半才失敗
  await fs.ensureDir(toDir);
  const probe = path.join(toDir, `.videonow-write-test-${process.pid}`);
  try {
    await fs.writeFile(probe, '');
  } catch (error) {
    throw new Error(`無法寫入新位置：${error.message}`);
  } finally {
    await fs.remove(probe).catch(() => {});
  }
}

// 搬移：先把每個子資料夾都複製完，再呼叫 commit()（寫入新位置的設定），最後才刪除來源。
// 複製或 commit 失敗時舊位置的檔案與設定都還完整；只有刪除舊檔失敗時會留下殘檔（不影響使用）。
// 目的地已有同名檔案時保留目的地的（縮圖以內容指紋命名，同名即同一張）
async function moveSubdirs(fromDir, toDir, subdirs, commit = async () => {}) {
  const copied = [];
  for (const sub of subdirs) {
    const src = path.join(fromDir, sub);
    if (!await fs.pathExists(src)) continue;
    await fs.copy(src, path.join(toDir, sub), { overwrite: false, errorOnExist: false });
    copied.push(src);
  }
  await commit();
  for (const src of copied) {
    await fs.remove(src).catch(error => console.warn(`刪除舊位置失敗: ${src}`, error.message));
  }
  return copied.length;
}

module.exports = { IMAGE_SUBDIRS, BACKUP_SUBDIRS, validateTarget, moveSubdirs, samePath };
