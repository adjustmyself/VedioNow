const { execFileSync } = require('child_process');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

// 畫面端的 shared/util.js 是 ES module，Jest（CommonJS）不能直接 require，
// 改在子行程（同一個 Electron 內建的 Node）import 後回傳結果
function runUtil(fnName, args) {
  const utilUrl = pathToFileURL(path.join(__dirname, '../src/renderer/shared/util.js')).href;
  const code = `import(${JSON.stringify(utilUrl)}).then(m => {
    const results = ${JSON.stringify(args)}.map(a => m[${JSON.stringify(fnName)}](...a));
    process.stdout.write(JSON.stringify(results));
  });`;
  const out = execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

describe('renderer shared/util', () => {
  const samples = [
    'C:\\Videos\\a b#1%?.mp4',
    'D:\\影片\\第 1 集 (完整版).mkv',
    '\\\\nas\\drive1\\folder\\movie name.mp4',
    '\\\\192.168.1.147\\share\\合集\\ep#2.avi',
    'C:\\a\\b&c=d+e@f,g;h!.mp4'
  ];

  test('toFileUrl 與 Node 的 pathToFileURL 指向同一個檔案', () => {
    const urls = runUtil('toFileUrl', samples.map(p => [p]));
    urls.forEach((url, i) => {
      expect(fileURLToPath(url)).toBe(samples[i]);
      expect(fileURLToPath(url)).toBe(fileURLToPath(pathToFileURL(samples[i]).href));
    });
  });

  test('toFileUrl 帶版本號時加上 ?t=', () => {
    const [url] = runUtil('toFileUrl', [['C:\\a.jpg', 123]]);
    expect(url).toBe('file:///C:/a.jpg?t=123');
  });

  test('toTagImageUrl：檔名組到標籤圖片資料夾，絕對路徑直接用', () => {
    const [relative, absolute, empty] = runUtil('toTagImageUrl', [
      ['a b.png', 'C:\\Users\\me\\AppData\\Roaming\\video-now\\tag-images'],
      ['D:\\old\\x.png', 'C:\\ignored'],
      ['', 'C:\\dir']
    ]);
    expect(fileURLToPath(relative)).toBe('C:\\Users\\me\\AppData\\Roaming\\video-now\\tag-images\\a b.png');
    expect(fileURLToPath(absolute)).toBe('D:\\old\\x.png');
    expect(empty).toBe('');
  });

  test('escapeHtml', () => {
    const [escaped] = runUtil('escapeHtml', [[`<a href="x">'&'</a>`]]);
    expect(escaped).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
