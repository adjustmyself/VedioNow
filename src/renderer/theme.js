// 共用主題套用邏輯：在 <html> 上設定 data-theme，三個視窗（主視窗／設定／標籤管理）共用。
// 以設定檔 (app.theme) 為準，並把結果鏡像到 localStorage，重開視窗時可同步套用避免淺色閃爍。
(function () {
  const { ipcRenderer } = require('electron');

  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    try {
      localStorage.setItem('videonow.theme', t);
    } catch (e) {
      // 忽略 localStorage 失敗
    }
  }

  // 1) 立即套用快取值（同步），避免開窗時先閃一下淺色
  try {
    const cached = localStorage.getItem('videonow.theme');
    if (cached) document.documentElement.setAttribute('data-theme', cached);
  } catch (e) {
    // 忽略
  }

  // 2) 以設定檔為最終依據
  ipcRenderer.invoke('get-config')
    .then((cfg) => applyTheme(cfg && cfg.app && cfg.app.theme))
    .catch(() => {});

  // 3) 其他視窗變更主題時即時同步
  ipcRenderer.on('theme-changed', (event, theme) => applyTheme(theme));

  // 供設定頁做即時預覽
  window.applyTheme = applyTheme;
})();
