// Electron 在 Windows 上的已知問題：原生 alert()/confirm() 關閉後，鍵盤焦點常常沒有回到頁面，
// 輸入框點得到（會出現外框）卻打不了字，要切到別的視窗再切回來才恢復。
// 匯入這個模組就會包住 window.alert / window.confirm：對話框關閉後請主行程讓視窗重新取得焦點。
// 直接改全域函式，既有與之後新增的 alert()/confirm() 呼叫都不必改寫。
// 每個視窗的入口模組（renderer.js、settings.js、tag-manager.js）都要匯入一次。

function refocus() {
  try {
    window.api.send('refocus-window');
  } catch (error) {
    console.warn('重新取得視窗焦點失敗:', error);
  }
}

if (!window.__dialogFocusFixInstalled) {
  window.__dialogFocusFixInstalled = true;

  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);

  window.alert = (message) => {
    try {
      nativeAlert(message);
    } finally {
      refocus();
    }
  };

  window.confirm = (message) => {
    try {
      return nativeConfirm(message);
    } finally {
      refocus();
    }
  };
}
