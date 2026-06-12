// 用 Electron 的 Node 執行 Jest。
// better-sqlite3 等原生模組是針對 Electron 的 ABI 編譯的（electron-builder install-app-deps），
// 直接用系統 Node 跑 jest 會因 ABI 不符而無法載入。
const { spawnSync } = require('child_process');
const path = require('path');

const electronPath = require('electron'); // 回傳 electron 執行檔路徑
const jestBin = path.join(__dirname, '../node_modules/jest/bin/jest.js');

const result = spawnSync(electronPath, [jestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  }
});

process.exit(result.status === null ? 1 : result.status);
