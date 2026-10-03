// 啟動畫面：顯示主行程送來的初始化進度，載入完成後淡出
const splashEl = document.getElementById('splash');
const barEl = document.getElementById('progress-bar');
const statusEl = document.getElementById('status');
let currentPercent = 6;

window.api.on('splash-status', (state) => {
  if (!state) return;
  if (typeof state.text === 'string') {
    statusEl.textContent = state.text;
  }
  const percent = Number(state.percent);
  // 進度只進不退，避免訊息順序造成倒退感
  if (!isNaN(percent) && percent > currentPercent) {
    currentPercent = Math.min(percent, 100);
    barEl.style.width = currentPercent + '%';
  }
});

window.api.on('splash-finish', () => {
  barEl.style.width = '100%';
  splashEl.classList.add('is-leaving');
});
