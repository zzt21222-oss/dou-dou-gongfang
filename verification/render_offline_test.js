// verification/render_offline_test.js
// utils/render.js 的离线行为断言（不需要 canvas，用假 ctx 记录调用）。
//
// 为什么要有它：格内色号 / 图例多列 / 分级坐标线这三处改动，
// 光靠「语法通过」和「肉眼看图」都验不出错——比如色号在深色底上用了黑字（看不见）、
// 图例第二列串到第一列上、格子太小时文字糊成一团，肉眼很难一眼发现。
// 这里把「该画什么、画在哪、画多大」变成可断言的数字。
//
// 运行： node verification/render_offline_test.js

const render = require('../utils/render.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, actual, expect) {
  ok(name + '  (实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expect) + ')',
    JSON.stringify(actual) === JSON.stringify(expect));
}

// ---- 假 ctx：只记录，不做像素运算 ----
function fakeCtx() {
  const c = {
    ops: [],
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textAlign: 'left', textBaseline: 'alphabetic',
    texts: [],       // { text, x, y, font, fill, align, baseline }
    rects: [],       // { x, y, w, h, fill }
    strokes: [],     // { style, width, path }
    _path: [],
  };
  c.fillRect = (x, y, w, h) => c.rects.push({ x, y, w, h, fill: c.fillStyle });
  c.strokeRect = (x, y, w, h) => c.rects.push({ x, y, w, h, stroke: c.strokeStyle });
  c.fillText = (t, x, y) => c.texts.push({ text: t, x, y, font: c.font, fill: c.fillStyle, align: c.textAlign, baseline: c.textBaseline });
  c.beginPath = () => { c._path = []; };
  c.moveTo = (x, y) => c._path.push([x, y]);
  c.lineTo = (x, y) => c._path.push([x, y]);
  c.stroke = () => { c.strokes.push({ style: c.strokeStyle, width: c.lineWidth, path: c._path.slice() }); };
  c.arc = () => {};
  c.fill = () => {};
  c.clearRect = () => {};
  return c;
}

function metaOf(codes) {
  // codes: ['C01','C02',...] → { 1:{rgb,hex,code,name}, 2:{...} }
  const rgb = { C01: [255, 255, 255], C02: [0, 0, 0], C03: [255, 250, 160], C04: [255, 0, 0] };
  const m = {};
  codes.forEach((code, i) => {
    m[i + 1] = { rgb: rgb[code] || [128, 128, 128], hex: '#000', code, name: 'Color' + (i + 1) };
  });
  return m;
}

console.log('\n=== utils/render.js 离线行为断言 ===\n');

/* ============ 1. 格内色号（showCode）============ */
console.log('[1] drawGrid · 格内印色号');
{
  const meta = metaOf(['C01', 'C02', 'C03']);
  const grid = [1, 2, 3];
  const cell = 30, offX = 10, offY = 20;
  const ctx = fakeCtx();
  render.drawGrid(ctx, { grid, w: 3, h: 1, cell, offX, offY, colorMeta: meta, mode: 'pixel', showCode: true });

  eq('印出 3 个色号', ctx.texts.map(t => t.text), ['C01', 'C02', 'C03']);
  // y 带 +0.5px：文字基线的视觉居中微调，属预期行为
  eq('第 1 格色号居中', [ctx.texts[0].x, ctx.texts[0].y], [offX + 15, offY + 15.5]);
  eq('第 3 格色号居中', [ctx.texts[2].x, ctx.texts[2].y], [offX + 2 * cell + 15, offY + 15.5]);
  ok('字号不超过格子一半', parseInt(ctx.texts[0].font) <= cell * 0.5, ctx.texts[0].font);
  ok('字号能让 3 字色号塞进格子', parseInt(ctx.texts[0].font) * 3 * 0.6 <= cell, ctx.texts[0].font);
  ok('居中绘制', ctx.texts[0].align === 'center' && ctx.texts[0].baseline === 'middle', [ctx.texts[0].align, ctx.texts[0].baseline]);
}

/* ============ 2. 明暗自适应（浅底黑字 / 深底白字）============ */
console.log('\n[2] drawGrid · 色号在深浅底上的可读性');
{
  const meta = metaOf(['C01', 'C02']); // C01 白、C02 黑
  const ctx = fakeCtx();
  render.drawGrid(ctx, { grid: [1, 2], w: 2, h: 1, cell: 30, offX: 0, offY: 0, colorMeta: meta, mode: 'pixel', showCode: true });
  const whiteBg = ctx.texts.find(t => t.text === 'C01');
  const blackBg = ctx.texts.find(t => t.text === 'C02');
  ok('白底用深色字', /rgba\(0,\s*0,\s*0/.test(whiteBg.fill), whiteBg.fill);
  ok('黑底用浅色字', /rgba\(255,\s*255,\s*255/.test(blackBg.fill), blackBg.fill);
}

/* ============ 3. 兼容性：默认不印任何东西 ============ */
console.log('\n[3] drawGrid · 默认行为不变（编辑器/缩略图不受影响）');
{
  const meta = metaOf(['C01', 'C02', 'C03']);
  const ctx = fakeCtx();
  render.drawGrid(ctx, { grid: [1, 2, 3], w: 3, h: 1, cell: 30, offX: 0, offY: 0, colorMeta: meta, mode: 'pixel' });
  eq('不传 showCode/showSymbol 时没有任何文字', ctx.texts.length, 0);
  eq('色块照常绘制 3 格', ctx.rects.filter(r => r.fill).length >= 3, true);
}

/* ============ 4. 格子太小自动省略 ============ */
console.log('\n[4] drawGrid · 格子过小时不印色号（避免糊成一团）');
{
  const meta = metaOf(['C01', 'C02']);
  const small = fakeCtx();
  render.drawGrid(small, { grid: [1, 2], w: 2, h: 1, cell: 8, offX: 0, offY: 0, colorMeta: meta, mode: 'pixel', showCode: true });
  eq('cell=8 时不印（阈值 10）', small.texts.length, 0);

  const big = fakeCtx();
  render.drawGrid(big, { grid: [1, 2], w: 2, h: 1, cell: 10, offX: 0, offY: 0, colorMeta: meta, mode: 'pixel', showCode: true });
  eq('cell=10 时印出', big.texts.length, 2);

  const forced = fakeCtx();
  render.drawGrid(forced, { grid: [1, 2], w: 2, h: 1, cell: 6, offX: 0, offY: 0, colorMeta: meta, mode: 'pixel', showCode: true, labelMinCell: 4 });
  eq('labelMinCell 可被调用方下调', forced.texts.length, 2);
}

/* ============ 5. 旧 showSymbol 路径仍可用，且 showCode 优先 ============ */
console.log('\n[5] drawGrid · 旧字母符号路径兼容 + 优先级');
{
  const meta = metaOf(['C01', 'C02']);
  const sym = { 1: 'A', 2: 'B' };

  const a = fakeCtx();
  render.drawGrid(a, { grid: [1, 2], w: 2, h: 1, cell: 16, offX: 0, offY: 0, colorMeta: meta, mode: 'pixel', showSymbol: true, symbolMap: sym });
  eq('showSymbol 仍印字母', a.texts.map(t => t.text), ['A', 'B']);

  const b = fakeCtx();
  render.drawGrid(b, { grid: [1, 2], w: 2, h: 1, cell: 16, offX: 0, offY: 0, colorMeta: meta, mode: 'pixel', showSymbol: true, showCode: true, symbolMap: sym });
  eq('两者同时开启时色号优先', b.texts.map(t => t.text), ['C01', 'C02']);
}

/* ============ 6. 分级坐标线 ============ */
console.log('\n[6] drawCoordLines · 分级线（emphasis）');
{
  const base = fakeCtx();
  render.drawCoordLines(base, { w: 12, h: 12, cell: 20, offX: 0, offY: 0 });
  ok('非 emphasis 不出现 5 格中档线', !base.strokes.some(s => s.style === 'rgba(0,0,0,0.22)'));
  ok('非 emphasis 主线为 1px', base.strokes.filter(s => s.style === 'rgba(0,0,0,0.35)').every(s => s.width === 1));

  const emp = fakeCtx();
  render.drawCoordLines(emp, { w: 12, h: 12, cell: 20, offX: 0, offY: 0, emphasis: true });
  ok('emphasis 出现 5 格中档线', emp.strokes.some(s => s.style === 'rgba(0,0,0,0.22)'));
  ok('emphasis 主线加深到 1.5px', emp.strokes.filter(s => s.style === 'rgba(0,0,0,0.5)').every(s => s.width === 1.5));
  ok('emphasis 线条总数与非 emphasis 一致', emp.strokes.length === base.strokes.length, [emp.strokes.length, base.strokes.length]);
}

/* ============ 7. 图例多列 ============ */
console.log('\n[7] drawLegend · 多列排布');
{
  const panel = Array.from({ length: 7 }, (_, i) => ({ hex: '#000', code: 'C0' + (i + 1), name: 'N' + (i + 1), count: 10 + i }));

  const body = (ctx) => ctx.texts.filter(t => t.text !== 'T'); // 排除标题

  const one = fakeCtx();
  render.drawLegend(one, { panel, startX: 40, startY: 100, rowH: 34, title: 'T' });
  const oneBody = body(one);
  eq('单列：7 条 × (色号+数量) = 14 段文本', oneBody.length, 14);
  eq('单列：7 条各占一行', [...new Set(oneBody.map(t => t.y))].length, 7);
  const oneCodeX = [...new Set(oneBody.filter(t => /^C0/.test(t.text)).map(t => t.x))];
  eq('单列：色号列 x 只有一个', oneCodeX.length, 1);

  const three = fakeCtx();
  render.drawLegend(three, { panel, startX: 40, startY: 100, rowH: 34, title: 'T', cols: 3, colWidth: 300, countX: 240 });
  const t3 = body(three);
  eq('三列：7 条只占 3 行', [...new Set(t3.map(t => t.y))].length, 3);
  const codeX3 = [...new Set(t3.filter(t => /^C0/.test(t.text)).map(t => t.x))].sort((a, b) => a - b);
  eq('三列：色号列有 3 个列起点', codeX3.length, 3);
  eq('三列：列间距 = colWidth(300)', codeX3[1] - codeX3[0], 300);
  // 数量列改用「以数字开头的文本」定位。
  // 旧版断言 /^×/（当时印的是 `×10`），2026-09-19 审查 F11 改成直接印
  // 「用量/建议购买」后不再有 ×，断言口径随之更新。
  const cntX3 = [...new Set(t3.filter(t => /^\d/.test(t.text)).map(t => t.x))].sort((a, b) => a - b);
  eq('三列：数量列也有 3 个', cntX3.length, 3);
  ok('三列：数量列不越过下一列起点', cntX3[0] < codeX3[1], [cntX3[0], codeX3[1]]);
}

/* ============ 7b. 图例给出「用量 / 建议购买」（审查 F11） ============ */
console.log('\n[7b] drawLegend · 用量与建议购买');
{
  const panel = [
    { hex: '#ffffff', code: 'H1', name: 'White', count: 100, suggest: 105 },
    { hex: '#000000', code: 'H2', name: 'Black', count: 50, suggest: 50 }
  ];
  const ctx = fakeCtx();
  render.drawLegend(ctx, { panel, startX: 0, startY: 0, rowH: 30, cols: 1, countX: 320 });
  const texts = ctx.texts.map(t => t.text);
  ok('用量与建议购买一起印（100/105）', texts.indexOf('100/105') >= 0, texts);
  ok('建议量等于用量时不重复印（只印 50）', texts.indexOf('50') >= 0, texts);
  ok('不再只印实际用量（旧版没有 105）', texts.indexOf('105') < 0, texts);
}

/* ============ 8. 图例返回值可用于计算画布高度 ============ */
console.log('\n[8] drawLegend · 返回底部 y');
{
  const panel = Array.from({ length: 5 }, (_, i) => ({ hex: '#000', code: 'C0' + i, name: 'N', count: 1 }));
  // 无标题时不加 26px 偏移
  const ctx = fakeCtx();
  const bottom = render.drawLegend(ctx, { panel, startX: 0, startY: 100, rowH: 34, cols: 3, colWidth: 300 });
  eq('5 条 3 列 → 2 行', bottom, 100 + 2 * 34);

  const ctx2 = fakeCtx();
  const bottom2 = render.drawLegend(ctx2, { panel, startX: 0, startY: 100, rowH: 34 });
  eq('单列 → 5 行', bottom2, 100 + 5 * 34);

  const ctx3 = fakeCtx();
  const bottom3 = render.drawLegend(ctx3, { panel, startX: 0, startY: 100, rowH: 34, title: 'T' });
  eq('带标题时再加 26px', bottom3, 100 + 26 + 5 * 34);
}

console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail === 0 ? 0 : 1);
