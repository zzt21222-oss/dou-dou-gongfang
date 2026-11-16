// verification/build_brand_compare.js
// 生成「同一张图 · 不同品牌色号」对比页（verification/brand_compare.html）。
//
// 想说明的一件事：切换色号系统**不会改变图案**，只会把每个格子重新标注成
// 你手上那个品牌能买到的最接近色号，用豆量清单也跟着变。
//
// 数据全部走真实链路：data/brands.js 的真实色卡 → paletteLoader → mapToPalette 映射
// → brandConvert 换品牌。页面里内联 utils/render.js 的真实源码来画，不是另画一份。
//
// 运行： node verification/build_brand_compare.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const renderSrc = fs.readFileSync(path.join(ROOT, 'utils/render.js'), 'utf8');
const paletteLoader = require(path.join(ROOT, 'utils/paletteLoader.js'));
const bead = require(path.join(ROOT, 'utils/bead.js'));
const brandConvert = require(path.join(ROOT, 'utils/brandConvert.js'));
const m2p = require(path.join(ROOT, 'utils/mapToPalette.js'));

/* ---------- 1. 造一张示例图（模拟「照片转图纸」的结果） ---------- */
const W = 20, H = 20;

function colorAt(x, y) {
  const dx = x - 15, dy = y - 4, d2 = dx * dx + dy * dy;
  if (y < 11) {
    if (d2 <= 6) return [255, 214, 64];                         // 太阳
    if (y >= 2 && y <= 4 && x >= 3 && x <= 8) return [246, 247, 250]; // 云
    if (y < 3) return [38, 88, 200];                            // 高空
    if (y < 7) return [110, 170, 235];                          // 中空
    return [176, 206, 236];                                     // 近地天空
  }
  if (y >= 16 && y <= 17 && x >= 4 && x <= 7) return [120, 78, 46];   // 树干
  if (y >= 14 && y <= 17 && x >= 8 && x <= 11) return [58, 130, 72];  // 树冠
  if (y >= 12 && y <= 15 && x >= 13 && x <= 17) return [222, 96, 80]; // 屋顶
  if (y >= 15) return [92, 154, 82];                            // 草地
  return [130, 190, 110];
}

/* ---------- 2. 映射到 MARD（走与 app 完全相同的 finalize 链路） ---------- */
// 这里必须走 bead.finalize()，不能手工拼 { code: c.id }。
// 2026-09-19 审查点名指出：旧版这一行手工把 code 补齐了，于是对比页看着是对的，
// 而产品真实路径（finalize 读 rawColors[i].code）其实是坏的 —— 这叫假验证。
const mard = paletteLoader.getPaletteColors('mard');
const mapMard = m2p.createMapper(mard);
const rawGrid = new Int32Array(W * H);
for (let i = 0; i < W * H; i++) {
  const c = colorAt(i % W, Math.floor(i / W));
  rawGrid[i] = mapMard(c[0], c[1], c[2]);
}
const finMard = bead.finalize(rawGrid, mard);
const baseGrid = finMard.labels;
const baseMeta = {};
finMard.colors.forEach(function (c) {
  baseMeta[c.id] = {
    rgb: c.rgb, code: c.code, brandKey: c.brandKey,
    name: c.name, hex: c.hex, short: c.short
  };
});

/* ---------- 3. 换成其它品牌（图案不变，只换色号） ---------- */
const VARIANTS = [
  { key: 'mard', label: 'MARD', desc: '默认色号系统 · 国内最常用', grid: baseGrid, colorMeta: baseMeta },
  { key: 'hama', label: 'Hama', desc: '丹麦品牌 · 5mm 大豆', r: brandConvert.convert({ grid: baseGrid, colorMeta: baseMeta, toBrand: 'hama' }) },
  { key: 'perler', label: 'Perler', desc: '美国品牌 · 色号是长 SKU，格内自动用短码', r: brandConvert.convert({ grid: baseGrid, colorMeta: baseMeta, toBrand: 'perler' }) },
];

const payload = VARIANTS.map(function (v) {
  const grid = v.grid || v.r.grid;
  const meta = v.colorMeta || v.r.colorMeta;
  // 用豆量统计（与 app 内一致：按粒数降序）
  const counts = {};
  for (let i = 0; i < grid.length; i++) { if (grid[i] >= 0) counts[grid[i]] = (counts[grid[i]] || 0) + 1; }
  const panel = Object.keys(counts).map(function (k) {
    const m = meta[k];
    return { id: +k, rgb: m.rgb, hex: m.hex, code: m.code, short: m.short, name: m.name, count: counts[k] };
  }).sort(function (a, b) { return b.count - a.count; });
  return {
    label: v.label,
    desc: v.desc,
    grid: Array.from(grid),
    meta: meta,
    panel: panel,
    total: grid.length
  };
});

/* ---------- 4. 页面 ---------- */
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>拼豆图纸 · 多品牌色号对比</title>
<style>
  body { margin:0; padding:24px; background:#f5f6f8; color:#222;
         font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:19px; font-weight:600; margin:0 0 6px; }
  .sub { font-size:13px; color:#666; margin:0 0 20px; line-height:1.75; max-width:1100px; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:18px; max-width:1500px; }
  .panel { background:#fff; border-radius:12px; padding:14px 16px 18px;
           border:0.5px solid rgba(0,0,0,.12); }
  .tag { display:inline-block; font-size:12px; padding:2px 9px; border-radius:99px;
         background:#E1F5EE; color:#0F6E56; margin-bottom:8px; }
  .panel h2 { font-size:14px; font-weight:600; margin:0 0 2px; }
  .panel p { font-size:12.5px; color:#777; margin:0 0 6px; line-height:1.6; }
  .stat { font-size:12px; color:#0F6E56; margin:0 0 10px; }
  canvas { width:100%; height:auto; display:block; image-rendering:pixelated; }
  .note { max-width:1500px; margin-top:20px; font-size:12.5px; color:#666; line-height:1.85;
          background:#fff; border-radius:12px; padding:14px 18px;
          border:0.5px solid rgba(0,0,0,.12); }
  code { background:#f1efe8; padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<h1>拼豆图纸 · 同一张图在不同品牌下的色号</h1>
<p class="sub">
  三张图画的是<b>同一份图案</b>（20×20），区别只在「色号系统」。<br>
  换品牌只做一件事：把每种颜色重新对应到目标品牌里最接近的那颗豆子，图案本身不动。<br>
  数据来自 <code>data/brands.js</code> 真实色卡，页面里的绘制逻辑直接引用 <code>utils/render.js</code> 源码。
</p>

<div class="grid" id="grid"></div>

<div class="note">
  <b>看什么：</b>底色与色块位置三张完全一致；变的是每格里的标注和用豆量清单。<br>
  <b>Perler 那栏注意：</b>它的官方色号是 <code>80-15179</code> 这种长 SKU，直接印进格子会溢出，
  所以格内用了短码，完整色号仍保留在图纸数据与采购清单里。<br>
  <b>一个已知的取舍：</b>色值来自社区按实物拍照整理，与实物存在色差，关键颜色建议拿手上的豆子核对一次。
</div>

<script>
const module = { exports: {} };
${renderSrc}
const render = module.exports;

const W = ${W}, H = ${H}, CELL = 26;
const VARIANTS = ${JSON.stringify(payload)};

const holder = document.getElementById('grid');

VARIANTS.forEach(function (v, vi) {
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.innerHTML =
    '<span class="tag">' + v.label + '</span>' +
    '<h2>' + v.label + ' · ' + v.panel.length + ' 色 · ' + v.total + ' 粒</h2>' +
    '<p>' + v.desc + '</p>' +
    '<div class="stat">' + v.panel.slice(0, 6).map(function (c) { return c.code + '×' + c.count; }).join('　') + '</div>' +
    '<canvas id="cv' + vi + '"></canvas>';

  holder.appendChild(panel);
});

VARIANTS.forEach(function (v, vi) {
  const node = document.getElementById('cv' + vi);
  const margin = 30, titleH = 62, coord = 30;
  const gridW = CELL * W, gridH = CELL * H;
  const cols = v.panel.length > 6 ? 3 : (v.panel.length > 3 ? 2 : 1);
  const colW = 210, rowH = 30;
  const rows = Math.max(1, Math.ceil(v.panel.length / cols));
  const cw = Math.max(gridW + coord + margin * 2, cols * colW + margin * 2);
  const ch = margin + titleH + coord + gridH + 40 + (24 + rows * rowH) + margin;
  node.width = cw; node.height = ch;

  const ctx = node.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = '#e6e6e6'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, cw - 2, ch - 2);

  ctx.fillStyle = '#222'; ctx.font = '600 24px sans-serif';
  ctx.fillText('拼豆图纸 ' + W + '×' + H, margin, margin + 26);
  ctx.fillStyle = '#777'; ctx.font = '15px sans-serif';
  ctx.fillText(v.total + ' 粒 · ' + v.panel.length + ' 色 · ' + v.label + ' 色号', margin, margin + 50);

  const gx = Math.round((cw - gridW) / 2), gy = margin + titleH + coord;

  ctx.fillStyle = '#444'; ctx.font = '13px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let x = 0; x < W; x++) if ((x + 1) % 5 === 0) ctx.fillText(String(x + 1), gx + x * CELL + CELL / 2, gy - 14);
  for (let y = 0; y < H; y++) if ((y + 1) % 5 === 0) ctx.fillText(String(y + 1), gx - 14, gy + y * CELL + CELL / 2);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

  render.drawGrid(ctx, {
    grid: v.grid, w: W, h: H, cell: CELL, offX: gx, offY: gy,
    colorMeta: v.meta, mode: 'pixel', showCode: true, labelMinCell: 10
  });
  render.drawCoordLines(ctx, { w: W, h: H, cell: CELL, offX: gx, offY: gy, emphasis: true });

  render.drawLegend(ctx, {
    panel: v.panel, startX: margin, startY: gy + gridH + 40, rowH: rowH,
    title: '色卡 / 用量', cols: cols, colWidth: colW, countX: 168
  });
});
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'brand_compare.html'), html, 'utf8');
console.log('已生成 verification/brand_compare.html');
payload.forEach(function (v) {
  console.log('  ' + v.label.padEnd(8) + v.panel.length + ' 色   ' +
    v.panel.slice(0, 4).map(function (c) { return c.code + '×' + c.count; }).join('  '));
});
