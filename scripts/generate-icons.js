// 從 assets/icon.svg 生成各平台所需的應用程式圖示
//   - icon.png  (512x512，Linux / 視窗 fallback)
//   - icon.ico  (多尺寸 16~256，Windows 視窗與安裝檔)
// 使用 sharp 將 SVG 點陣化、png-to-ico 打包多尺寸 ICO。
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

const assetsDir = path.join(__dirname, '..', 'assets');
const svgPath = path.join(assetsDir, 'icon.svg');

async function main() {
  if (!fs.existsSync(svgPath)) {
    throw new Error(`找不到來源圖：${svgPath}`);
  }
  const svg = fs.readFileSync(svgPath);

  // 先點陣化成 1024 的主圖，再縮放出各尺寸
  const master = await sharp(svg).resize(1024, 1024).png().toBuffer();

  // Linux / 視窗 fallback 用 512 PNG
  await sharp(master).resize(512, 512).png().toFile(path.join(assetsDir, 'icon.png'));

  // Windows ICO 需多尺寸
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(
    icoSizes.map((s) => sharp(master).resize(s, s).png().toBuffer())
  );
  const ico = await pngToIco(icoBuffers);
  fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);

  console.log('已生成 assets/icon.png 與 assets/icon.ico');
}

main().catch((err) => {
  console.error('生成圖示失敗：', err);
  process.exit(1);
});
