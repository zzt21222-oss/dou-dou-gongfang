// verification/build_render_compare.js
// 生成「旧版导出 vs 新版导出」对比页（verification/render_compare.html）。
//
// 设计要点：页面里的绘制代码**直接内联 utils/render.js 的真实源码**，
// 而不是复制一份画法。这样对比图永远跟着真实代码走，不会出现
// 「图看着好、代码其实没改」的假验证。
//
// 运行： node verification/build_render_compare.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const renderSrc = fs.readFileSync(path.join(ROOT, 'utils/render.js'), 'utf8');

/* ---------- 1. 造一张示例图纸：24×24 的小风景（照片转图纸的典型场景） ---------- */
const W = 24, H = 24;
const META = {
  1: { rgb: [255, 255, 255], hex: '#FFFFFF', code: 'C01', name: 'White' },
  2: { rgb: [26, 26, 26], hex: '#1A1A1A', code: 'C02', name: 'Black' },
  3: { rgb: [135, 206, 235], hex: '#87CEEB', code: 'C16', name: 'Light Blue' },
  4: { rgb: [0, 0, 255], hex: '#0000FF', code: 'C17', name: 'Blue' },
  5: { rgb: [174, 198, 207], hex: '#AEC6CF', code: 'C15', name: 'Pastel Blue' },
  6: { rgb: [255, 230, 0], hex: '#FFE600', code: 'C05', name: 'Yellow' },
  7: { rgb: [0, 128, 0], hex: '#008000', code: 'C22', name: 'Green' },
  8: { rgb: [144, 238, 144], hex: '#90EE90', code: 'C21', name: 'Light Green' },
};

const grid = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let id;
    const dx = x - 17.5, dy = y - 4.5, d2 = dx * dx + dy * dy;
    const inSun = d2 <= 9, inSunEdge = d2 <= 16 && !inSun;
    const inCloud = (y >= 2 && y <= 4 && x >= 4 && x <= 9) && !(y === 2 && (x === 4 || x === 9));
    if (y < 12) {
      if (inSun) id = 6;
      else if (inSunEdge) id = 2;
      else if (inCloud) id = 1;
      else if (y < 4) id = 4;
      else if (y < 8) id = 3;
      else id = 5;
    } else {
      id = y < 17 ? 7 : 8;
    }
    grid.push(id);
  }
}

// 用豆量统计（按粒数降序，和 app 内一致）
const counts = {};
grid.forEach(id => { counts[id] = (counts[id] || 0) + 1; });
const panel = Object.keys(counts)
  .map(id => ({ id: +id, rgb: META[id].rgb, hex: META[id].hex, code: META[id].code, name: META[id].name, count: counts[id] }))
  .sort((a, b) => b.count - a.count);
const total = grid.length;

/* ---------- 2. 页面 ---------- */
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>拼豆图纸 · 旧版/新版导出对比</title>
<style>
  body { margin:0; padding:24px; background:#f5f6f8; color:#222;
         font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:19px; font-weight:600; margin:0 0 6px; }
  .sub { font-size:13px; color:#666; margin:0 0 20px; line-height:1.7; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; max-width:1500px; }
  .panel { background:#fff; border-radius:12px; padding:14px 16px 18px;
           border:0.5px solid rgba(0,0,0,.12); }
  .tag { display:inline-block; font-size:12px; padding:2px 9px; border-radius:99px; margin-bottom:10px; }
  .old .tag { background:#FCEBEB; color:#A32D2D; }
  .new .tag { background:#E1F5EE; color:#0F6E56; }
  .panel h2 { font-size:14px; font-weight:600; margin:0 0 4px; }
  .panel p { font-size:12.5px; color:#777; margin:0 0 12px; line-height:1.6; }
  canvas { width:100%; height:auto; display:block; border-radius:6px; image-rendering:pixelated; }
  .note { max-width:1500px; margin-top:20px; font-size:12.5px; color:#666; line-height:1.8;
          background:#fff; border-radius:12px; padding:14px 18px;
          border:0.5px solid rgba(0,0,0,.12); }
  code { background:#f1efe8; padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<h1>拼豆图纸 · 旧版 / 新版导出对比</h1>
<p class="sub">
  同一份 24×24 示例图纸、同一格子大小，只对比<b>渲染方式和版式</b>。<br>
  页面里的绘制逻辑直接引用项目里的 <code>utils/render.js</code> 源码，不是另画一份——所见即代码实际输出。
</p>

<div class="grid">
  <div class="panel old">
    <span class="tag">旧版</span>
    <h2>bead 立体模式 · 无格内色号 · 图例单列</h2>
    <p>外圈 ×0.8 压暗 + 中心 28% 白高光，饱和度被压低；格子里没有色号，拼的时候要来回查图例。</p>
    <canvas id="oldCv"></canvas>
  </div>
  <div class="panel new">
    <span class="tag">新版</span>
    <h2>pixel 平面模式 · 格内印色号 · 图例多列</h2>
    <p>色板原色直出、不压灰；每格直接标色号，深浅底自动切换黑白字；图例多列排布，省掉大片留白。</p>
    <canvas id="newCv"></canvas>
  </div>
</div>

<div class="note">
  <b>怎么看差别最明显：</b>找左上角的深蓝天（C17）和右边的黄色太阳（C05）——
  旧版被高光和压暗蒙了一层灰，新版是干净的纯色；再把手机拿远一点看，
  新版每格能读出 C17/C05，旧版只剩一片模糊色块。<br>
  <b>尺寸差异另说：</b>新版导出的分辨率也不再写死 16px，而是让图纸长边落在约 1500px（小图格子更大更清楚）。
  本页为了让两边格子一样大好对比，统一用了相同 cell。</div>

<script>
const module = { exports: {} };
${renderSrc}
const render = module.exports;

const W = ${W}, H = ${H}, CELL = 30;
const GRID = ${JSON.stringify(grid)};
const META = ${JSON.stringify(META)};
const PANEL = ${JSON.stringify(panel)};
const TOTAL = ${total};

// 画布尺寸与版式参数：两侧完全一致，唯一差别是渲染模式/色号/图例列数
function layout(node) {
  const margin = 34, titleH = 62, coord = 30;
  const gridW = CELL * W, gridH = CELL * H;
  const legendRowH = 34;
  const cols = PANEL.length > 6 ? 3 : (PANEL.length > 3 ? 2 : 1);
  const legendRows = Math.max(1, Math.ceil(PANEL.length / cols));
  const legendColW = 300;
  const cw = Math.max(gridW + coord + margin * 2, cols * legendColW + margin * 2);
  const ch = margin + titleH + coord + gridH + 46 + (26 + legendRows * legendRowH) + margin;
  node.width = cw; node.height = ch;
  const ctx = node.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
  return { ctx, cw, ch, margin, titleH, coord, gridW, gridH, legendRowH, cols, legendColW };
}

function drawAxis(ctx, gx, gy) {
  const step = CELL >= 14 ? 1 : (CELL >= 8 ? 2 : 5);
  ctx.fillStyle = '#444'; ctx.font = '15px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let x = 0; x < W; x++) if (x === 0 || (x + 1) % step === 0) ctx.fillText(String(x + 1), gx + x * CELL + CELL / 2, gy - 16);
  for (let y = 0; y < H; y++) if (y === 0 || (y + 1) % step === 0) ctx.fillText(String(y + 1), gx - 16, gy + y * CELL + CELL / 2);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

/* ---- 旧版：bead + 无码 + 单列图例 + 每10格坐标线 ---- */
(function () {
  const L = layout(document.getElementById('oldCv'));
  const { ctx, cw, ch, margin, titleH, coord, gridW, gridH } = L;
  ctx.fillStyle = '#222'; ctx.font = '600 26px sans-serif';
  ctx.fillText('拼豆图纸 ' + W + '×' + H + '（' + TOTAL + '粒）', margin, margin + 26);

  const gx = Math.round((cw - gridW) / 2), gy = margin + titleH + coord;
  drawAxis(ctx, gx, gy);
  render.drawGrid(ctx, { grid: GRID, w: W, h: H, cell: CELL, offX: gx, offY: gy, colorMeta: META, mode: 'bead' });
  render.drawCoordLines(ctx, { w: W, h: H, cell: CELL, offX: gx, offY: gy });
  render.drawLegend(ctx, { panel: PANEL, startX: margin, startY: gy + gridH + 46, rowH: 40, title: '色卡 / 用量' });
})();

/* ---- 新版：pixel + 格内色号 + 多列图例 + 分级坐标线 + 边框/副信息 ---- */
(function () {
  const L = layout(document.getElementById('newCv'));
  const { ctx, cw, ch, margin, titleH, coord, gridW, gridH, legendRowH, cols, legendColW } = L;
  ctx.strokeStyle = '#e6e6e6'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, cw - 2, ch - 2);
  ctx.fillStyle = '#222'; ctx.font = '600 30px sans-serif';
  ctx.fillText('拼豆图纸 ' + W + '×' + H, margin, margin + 30);
  ctx.fillStyle = '#777'; ctx.font = '17px sans-serif';
  ctx.fillText('共 ' + TOTAL + ' 粒 · ' + PANEL.length + ' 色 · 每格标注色号 · 2026-09-11', margin, margin + 58);

  const gx = Math.round((cw - gridW) / 2), gy = margin + titleH + coord;
  drawAxis(ctx, gx, gy);
  render.drawGrid(ctx, { grid: GRID, w: W, h: H, cell: CELL, offX: gx, offY: gy, colorMeta: META, mode: 'pixel', showCode: true, labelMinCell: 10 });
  render.drawCoordLines(ctx, { w: W, h: H, cell: CELL, offX: gx, offY: gy, emphasis: true });
  render.drawLegend(ctx, {
    panel: PANEL, startX: margin, startY: gy + gridH + 46, rowH: legendRowH,
    title: '色卡 / 用量（购买量已含 5% 备用）',
    cols: cols, colWidth: legendColW, countX: 240
  });
})();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'render_compare.html'), html, 'utf8');
console.log('已生成 verification/render_compare.html');
console.log('图纸: ' + W + '×' + H + '，' + panel.length + ' 色，共 ' + total + ' 粒');
console.log('颜色占比: ' + panel.map(c => c.code + '×' + c.count).join('  '));
