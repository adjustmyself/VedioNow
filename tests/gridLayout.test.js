const { execFileSync } = require('child_process');
const path = require('path');
const { pathToFileURL } = require('url');

// modules/gridLayout.js 是 ES module，比照 rendererUtil.test.js 在子行程 import
function runGrid(fnName, args) {
  const moduleUrl = pathToFileURL(path.join(__dirname, '../src/renderer/modules/gridLayout.js')).href;
  const code = `import(${JSON.stringify(moduleUrl)}).then(m => {
    const results = ${JSON.stringify(args)}.map(a => m[${JSON.stringify(fnName)}](...a));
    process.stdout.write(JSON.stringify(results));
  });`;
  const out = execFileSync(process.execPath, ['-e', code], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

describe('renderer modules/gridLayout', () => {
  test('gridColumnsForWidth：內容區寬度（視窗寬扣掉 280px 側欄）對應欄數', () => {
    // 未就緒、窄視窗、1080p@125%、1080p、2K、4K@125%、4K、超寬
    const widths = [0, 300, 820, 1256, 1640, 2280, 2792, 3560, 20000];
    expect(runGrid('gridColumnsForWidth', widths.map(w => [w])))
      .toEqual([3, 1, 2, 3, 4, 4, 5, 5, 10]);
  });

  // 內距 2rem 左右、1.25rem 上下；欄距 / 列距 24px；卡片文字區 108px
  const area = (areaWidth, innerHeight) => ({
    areaWidth, innerWidth: areaWidth - 64, innerHeight,
    columnGap: 24, rowGap: 24, contentHeight: 108
  });

  test('planGrid：欄數只看寬度，列數填滿可用高度', () => {
    const [fourK, twoK] = runGrid('planGrid', [[area(3560, 1800)], [area(2280, 1000)]]);
    // 4K：5 欄、卡片 680 寬 → 高 490.5，1800 放得下 3 列
    expect(fourK).toEqual({ columns: 5, rows: 3 });
    // 2K：4 欄、卡片 536 寬 → 高 409.5，1000 放得下 2 列
    expect(twoK).toEqual({ columns: 4, rows: 2 });
  });

  test('planGrid：高度變矮（例如標籤篩選列展開）只減列數，欄數不變', () => {
    // 1080p：4 欄、卡片高 319.5；高 700 放得下 2 列，高 400 只剩 1 列
    expect(runGrid('planGrid', [[area(1640, 700)], [area(1640, 400)]]))
      .toEqual([{ columns: 4, rows: 2 }, { columns: 4, rows: 1 }]);
  });

  test('planGrid：一列都放不下時至少 1 列', () => {
    const [plan] = runGrid('planGrid', [[area(1640, 100)]]);
    expect(plan).toEqual({ columns: 4, rows: 1 });
  });

  test('planGrid：還量不到大小時列數為 0（每頁筆數退回設定值）', () => {
    const [plan] = runGrid('planGrid', [[area(0, 0)]]);
    expect(plan).toEqual({ columns: 3, rows: 0 });
  });
});
