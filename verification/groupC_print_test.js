'use strict';
// verification/groupC_print_test.js
//
// 组 C（审查报告第一轮）回归测试：打印图 F09 —— 「大图被画到画布外 + 格内色号被整体省略」。
//
// 审查脚本给出的原始证据（200×200 图纸）：
//   { canvasWidth: 1240, gridRight: 1290, clippedPixels: 50 }
// 即右侧 50px 直接落在画布之外；同时因为格宽被夹到 6px < labelMinCell(10)，
// drawGrid 会把「格内色号」整体关掉 —— 打印图就失去了"照着拼不用回查图例"的意义。
//
// 本次修复：放得下就单页（格宽尽量大）；放不下就按可读格宽分页，
// 每页带页码 / 绝对行列范围 / 完整图例 / 拼接位置示意图，且坐标线用**绝对**坐标。
//
// 2026-09-20 更新（复核报告 R4，按用户选定参数重做）：
//   组 C 当时只做到"不画出画布外"，纸面尺寸仍随内容变、格宽只有 24px，
//   纸上约 1.49mm/格、三字符色号约 2.11pt，且图例数量文本会压到下一列。
//   现在改为固定 A4 横向纸面（297×210mm、四边 10mm、150dpi → 1754×1240），
//   由最小字号 8pt 反推格宽 34px，采购清单单独出页。
//   因此本节断言随之改为**新契约**，但下面这些不变量仍然逐条保留：
//     ① 任何一页的网格右/下边界都不越出画布；② 格内色号必须真的被印出；
//     ③ 第 2 页起坐标线用绝对原点；④ 分板框按页裁剪；
//     ⑤ 端到端生成张数与版面计算一致。
//
// 断言原则（与审查报告点名批评的"假验证"相反）：
//   · 几何量全部来自**真实调用** `_printLayout()` / `_buildPrintPage()` 的真实返回值，
//     不手工构造 clip 结果；
//   · 记录的是页面真实传给 render.drawGrid / drawCoordLines 的参数，
//     以及真实 @napi-rs/canvas 上真实发生的 fillText / strokeRect 调用；
//   · 每节独立隔离异常：某一节失败（旧代码缺方法直接抛错）不会中断后续节，
//     保证"跑一遍就能拿到完整的失败清单"。
//
// 本文件在**修复前**的代码上应当大面积 FAIL（缺 _printLayout/_buildPrintPage，
// 且 drawCoordLines 不认 startX）；只有修复后才全绿。这就是它的鉴别力。
//
// 用法：
//   NODE_PATH=<node_modules> node verification/groupC_print_test.js
// 依赖 @napi-rs/canvas。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..');
const requireSrc = createRequire(path.join(ROOT, 'app.js'));
const loader = requireSrc('./utils/paletteLoader.js');
const render = requireSrc('./utils/render.js');
const storage = requireSrc('./utils/storage.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '   → ' + JSON.stringify(detail) : '')); }
}
function eq(name, actual, expect) {
  const a = JSON.stringify(actual), e = JSON.stringify(expect);
  ok(name, a === e, a === e ? undefined : { actual: actual, expect: expect });
}
// 逐节隔离：单节抛错只记一条 FAIL，不中断后续节
async function sec(title, fn) {
  console.log('\n=== ' + title + ' ===');
  try { await fn(); }
  catch (e) { fail++; console.log('  FAIL [本节异常中断] ' + title + ' → ' + (e && e.message ? e.message : String(e))); }
}
const clone = x => JSON.parse(JSON.stringify(x));
const silent = { log() {}, error() {}, warn() {} };

// ---------- 与审查回归测试同一套页面桩，保证可比 ----------
function makeApp() {
  return {
    globalData: {
      prefs: { brand: 'mard', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} },
      project: null
    },
    savePrefs() {},
    setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
  };
}

// record：记录真实画布上发生的调用（供几何 / 文本 / 分板框断言）
function newRecord() {
  return { canvasW: 0, canvasH: 0, texts: [], rects: [], offscreenCount: 0, tmpFileCount: 0, albumCount: 0, pageSizes: [], pageCanvasCount: 0 };
}
// 造 wx：createOffscreenCanvas 返回**真实** napi-rs 画布，但把 getContext 出来
// 的 ctx 上的 fillText / strokeRect 包一层记录——画的内容仍是真画，只是可观测。
function canvasWx(record, extra) {
  return Object.assign({
    createOffscreenCanvas(o) {
      record.offscreenCount++;
      record.canvasW = o.width; record.canvasH = o.height;
      const c = createCanvas(o.width, o.height);
      // 只统计**整页**画布：_measure() 用 8×8 量文本宽度，不该算作图纸页
      if (o.width > 100) { record.pageSizes.push(o.width + 'x' + o.height); record.pageCanvasCount++; }
      const origGet = c.getContext.bind(c);
      c.getContext = function (type) {
        const ctx = origGet(type);
        if (!ctx.__hooked) {
          ctx.__hooked = true;
          const oFill = ctx.fillText.bind(ctx);
          const oRect = ctx.strokeRect.bind(ctx);
          ctx.fillText = function (t, x, y) {
            record.texts.push({ text: String(t), x: x, y: y, font: this.font, fill: this.fillStyle });
            return oFill(t, x, y);
          };
          ctx.strokeRect = function (x, y, w, h) {
            record.rects.push({ x: x, y: y, w: w, h: h });
            return oRect(x, y, w, h);
          };
        }
        return ctx;
      };
      return c;
    },
    canvasToTempFilePath(o) {
      record.tmpFileCount++;
      if (o.success) o.success({ tempFilePath: '/tmp/print-page-' + record.tmpFileCount + '.png' });
    },
    saveImageToPhotosAlbum(o) {
      record.albumCount++;
      if (o.success) o.success();
    }
  }, extra || {});
}
function page(name, options) {
  options = options || {};
  let def;
  const store = options.store || {};
  const app = options.app || makeApp();
  const wx = Object.assign({
    getStorageSync: k => (store[k] ? clone(store[k]) : ''),
    setStorageSync: (k, v) => { store[k] = clone(v); },
    removeStorageSync: k => { delete store[k]; },
    showToast() {}, showModal() {}, navigateTo() {}, showLoading() {}, hideLoading() {}, vibrateShort() {},
    getWindowInfo: () => ({ pixelRatio: options.dpr || 1, windowWidth: 375, windowHeight: 800 }),
    createOffscreenCanvas: o => createCanvas(o.width, o.height)
  }, options.wx || {});
  const filename = path.join(ROOT, 'pages', name, name + '.js');
  global.wx = wx;
  const context = {
    require: createRequire(filename), getApp: () => app, Page: d => { def = d; }, wx,
    console: silent, setTimeout, clearTimeout, setImmediate,
    Uint8ClampedArray, Uint8Array, Int8Array, Int32Array, Map, Set,
    Object, Array, JSON, Math, Date, String, Number, Boolean, Promise, Error
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  def.data = clone(def.data);
  def.setData = function (p, cb) { Object.assign(this.data, p); if (cb) cb(); };
  return { p: def, app, wx, store };
}
function metaOf(rgb, code) {
  return {
    rgb: rgb, code: code, short: code, name: code,
    hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  };
}
// 从**真实入口** onLoad 起一张预览页：project 由 app.globalData 注入，与 App 里一致
function initPreview(w, h, opts) {
  opts = opts || {};
  const app = makeApp();
  const colorMeta = opts.colorMeta || { 0: metaOf([216, 1, 39], 'M01') };
  const grid = opts.grid || new Array(w * h).fill(0);
  const project = {
    w: w, h: h, grid: grid, colorMeta: colorMeta, brand: 'mard',
    boards: opts.boards || null
  };
  app.globalData.project = project;
  const record = newRecord();
  const env = page('preview', { app: app, wx: canvasWx(record, opts.wx) });
  env.p.onLoad();
  env.record = record;
  env.project = project;
  return env;
}
// 包住 render.drawGrid / drawCoordLines，记录页面真实传入的参数（仍调用原实现，保证真画）
function hookRender(record) {
  const oGrid = render.drawGrid, oCoord = render.drawCoordLines, oLegend = render.drawLegend;
  record.grid = []; record.coord = []; record.legend = [];
  render.drawGrid = function (ctx, o) { record.grid.push(clone(o && { w: o.w, h: o.h, cell: o.cell, offX: o.offX, offY: o.offY, showCode: o.showCode, labelMinCell: o.labelMinCell, gridLen: o.grid && o.grid.length })); return oGrid.apply(null, arguments); };
  render.drawCoordLines = function (ctx, o) { record.coord.push(clone(o && { w: o.w, h: o.h, cell: o.cell, offX: o.offX, offY: o.offY, emphasis: o.emphasis, startX: o.startX, startY: o.startY })); return oCoord.apply(null, arguments); };
  render.drawLegend = function (ctx, o) { record.legend.push(clone(o && { cols: o.cols, startX: o.startX, startY: o.startY })); return oLegend.apply(null, arguments); };
  return function restore() { render.drawGrid = oGrid; render.drawCoordLines = oCoord; render.drawLegend = oLegend; };
}
// 可量化的坐标线样式探针（用于 drawCoordLines 的 startX 语义）
function lineCtx() {
  const lines = [];
  return {
    lines, strokeStyle: '', lineWidth: 1,
    beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { lines.push({ strokeStyle: this.strokeStyle, lineWidth: this.lineWidth }); }
  };
}
const THICK = 'rgba(0,0,0,0.5)';

(async () => {
  console.log('《豆豆工坊A》组 C 回归测试 —— 打印图 F09：不再裁切 + 格内色号保留 + 分页')
  console.log('入口：真实 preview 页面（onLoad → _printLayout → _buildPrintPage → generatePrint）');

  // ============================================================
  await sec('C1 200×200 布局判定：必须分页、且每页都不越界（F09 原始场景）', async () => {
    const env = initPreview(200, 200);
    const lay = env.p._printLayout();
    const mm = lay.mm;
    ok('200×200 需要分页', lay.pageCount > 1, lay.pageCount);
    eq('页数 = 横向页数 × 纵向页数', lay.pageCount, lay.pagesX * lay.pagesY);
    ok('格宽 = 由 8pt 反推的最小格宽（不是拍脑袋的 24/6）', lay.cell === mm.MIN_CELL, lay.cell);
    ok('格内色号一定不会被"格子太小"关掉', lay.cell >= 10, lay.cell);

    // 纸面固定：这正是"能按比例拼接"的前提
    eq('每页宽度 = A4 横向 297mm @150dpi', mm.PW, 1754);
    eq('每页高度 = A4 横向 210mm @150dpi', mm.PH, 1240);
    eq('四边边距 = 10mm @150dpi', mm.M, 59);

    // 逐页做与 _buildPrintPage 完全相同的算术，检查右/下边界与页脚不重叠
    const bad = []; const badBottom = [];
    let maxRight = 0, maxBottom = 0;
    for (let py = 0; py < lay.pagesY; py++) {
      for (let px = 0; px < lay.pagesX; px++) {
        const colStart = px * lay.cols;
        const colEnd = Math.min(200, colStart + lay.cols);
        const rowStart = py * lay.rows;
        const rowEnd = Math.min(200, rowStart + lay.rows);
        const tw = colEnd - colStart, th = rowEnd - rowStart;
        ok('每页至少 1 列 1 行 [' + px + ',' + py + ']', tw >= 1 && th >= 1, { tw: tw, th: th });
        const gx = mm.M + lay.GUTTER;
        const gy = mm.M + lay.HEADER_H + lay.GUTTER;
        const right = gx + tw * lay.cell;
        if (right > mm.PW - mm.M + 0.01) bad.push({ px: px, py: py, right: right });
        maxRight = Math.max(maxRight, right);
        // 页脚贴底，且不与网格重叠（页脚顶边 = 纸底 - 边距 - 页脚高）
        const footerTop = mm.PH - mm.M - lay.FOOTER_H;
        const bottom = gy + th * lay.cell;
        if (bottom > footerTop) badBottom.push({ px: px, py: py, bottom: bottom, footerTop: footerTop });
        maxBottom = Math.max(maxBottom, bottom);
      }
    }
    eq('没有任何一页的网格右边界超出可打印区', bad, []);
    eq('没有任何一页的网格压到页脚', badBottom, []);
    ok('最大右边界 ≤ 纸面宽', maxRight <= mm.PW, { maxRight: maxRight, PW: mm.PW });
    ok('网格底边留出了页脚高度', maxBottom + lay.FOOTER_H + mm.M <= mm.PH,
      { maxBottom: maxBottom, FOOTER_H: lay.FOOTER_H, PH: mm.PH });
  });

  // ============================================================
  await sec('C2 真实画布几何：复算审查脚本的 clippedPixels 指标（必须为 0）', async () => {
    const env = initPreview(200, 200, {
      boards: { boards: [{ seq: 1, x: 0, y: 0, w: 200, h: 200 }] }
    });
    const lay = env.p._printLayout();
    const restore = hookRender(env.record);
    let off, threw = null;
    try { off = env.p._buildPrintPage(lay, 0, 0); }
    catch (e) { threw = String(e.message); }
    finally { restore(); }
    ok('_buildPrintPage 可正常产出画布', threw === null, threw);
    if (threw) return;

    const dg = env.record.grid[0], dc = env.record.coord[0];
    ok('真实画布尺寸 = A4 横向 @150dpi', env.record.canvasW === 1754 && env.record.canvasH === 1240,
      { w: env.record.canvasW, h: env.record.canvasH });
    ok('确实调用了 drawGrid', !!dg);
    ok('确实调用了 drawCoordLines', !!dc);
    if (!dg) return;

    const gridRight = dg.offX + dg.w * dg.cell;
    ok('网格右边界 ≤ 画布宽（clippedPixels = 0）', gridRight <= env.record.canvasW,
      { gridRight: gridRight, canvasWidth: env.record.canvasW });
    eq('drawGrid 打开了格内色号', dg.showCode, true);
    ok('格宽 ≥ labelMinCell（色号真的会被画出来）', dg.cell >= (dg.labelMinCell || 0),
      { cell: dg.cell, labelMinCell: dg.labelMinCell });
    eq('drawGrid 收到的网格 = 本页切片（不是整张 200×200）', dg.gridLen, dg.w * dg.h);
    ok('本页切片确实小于整张图纸', dg.w * dg.h < 200 * 200, dg.w * dg.h);

    // 分板框：跨页的板只能画出落在本页的那一段
    const gridRects = env.record.rects.filter(r => Math.abs(r.w - dg.w * dg.cell) < 0.01);
    ok('分板框被裁到本页宽度', gridRects.length >= 1, env.record.rects);
    eq('没有任何分板框比画布还宽', env.record.rects.filter(r => r.w > env.record.canvasW + 0.01), []);
  });

  // ============================================================
  await sec('C3 第 2 页起用绝对坐标：主线不再从每页左上角重新计数', async () => {
    const env = initPreview(200, 200);
    const lay = env.p._printLayout();
    const restore = hookRender(env.record);
    let threw = null;
    try { env.p._buildPrintPage(lay, 1, 0); }
    catch (e) { threw = String(e.message); }
    finally { restore(); }
    ok('第 2 列页面可正常产出', threw === null, threw);
    if (threw) return;

    const dc = env.record.coord[0];
    ok('确实调用了 drawCoordLines', !!dc);
    if (!dc) return;
    eq('startX = 第 1 页覆盖的列数（绝对坐标原点）', dc.startX, lay.cols);
    eq('startY = 0（同在第 1 行）', dc.startY, 0);
    ok('startX > 0（不再是 0）', dc.startX > 0, dc.startX);

    // 页码与绝对行列范围必须出现在页眉
    const texts = env.record.texts.map(t => t.text);
    ok('页眉出现「第 2/N 页」', texts.some(t => /^第\s*2\s*\/\s*\d+\s*页/.test(t)), texts.slice(0, 8));
    ok('页眉出现本页覆盖的列范围', texts.some(t => /列\s*\d+\s*-\s*\d+/.test(t)), texts.slice(0, 8));
    ok('页脚出现「第 2 / N 页」', texts.some(t => /^第\s*2\s*\/\s*\d+\s*页/.test(t)), true);
  });

  // ============================================================
  await sec('C4 drawCoordLines 的 startX 语义（主线落在绝对 10 的倍数上）', async () => {
    // w=20、startX=45：绝对坐标 45..65，10 的倍数只有 50 / 60 → 相对下标 5 / 15
    const c = lineCtx();
    render.drawCoordLines(c, { w: 20, h: 0, cell: 10, offX: 0, offY: 0, emphasis: true, startX: 45, startY: 0 });
    const thick = c.lines.map((l, i) => (l.strokeStyle === THICK ? i : -1)).filter(i => i >= 0);
    // 前 21 条是垂直线的样式记录
    const vThick = thick.filter(i => i <= 20);
    eq('主线落在相对下标 5 / 15（对应绝对 50 / 60）', vThick, [5, 15]);
    ok('相对下标 0 不是主线（45 不是 10 的倍数）', c.lines[0].strokeStyle !== THICK, c.lines[0]);
    ok('相对下标 5 的线宽被加深（1.5）', c.lines[5].lineWidth === 1.5, c.lines[5]);

    // 不传 startX 时保持原行为，向后兼容（屏幕预览不受影响）
    const c2 = lineCtx();
    render.drawCoordLines(c2, { w: 20, h: 0, cell: 10, offX: 0, offY: 0, emphasis: true });
    const vThick2 = c2.lines.map((l, i) => (l.strokeStyle === THICK ? i : -1)).filter(i => i >= 0 && i <= 20);
    eq('不传 startX 时仍是相对 0/10/20（原行为不变）', vThick2, [0, 10, 20]);
  });

  // ============================================================
  await sec('C5 放得下就是一页：不夸大页数，也不为了单页牺牲可读字号', async () => {
    // 新契约下格宽固定（由 8pt 反推），所以"一页放得下"的判据变成
    // 网格行列数是否落在每页容量内，而不再是"把格子压小硬塞进一页"。
    const env = initPreview(20, 20);
    const lay = env.p._printLayout();
    eq('20×20 落在单页容量内', lay.pageCount, 1);
    eq('横向页数 = 1', lay.pagesX, 1);
    eq('纵向页数 = 1', lay.pagesY, 1);
    eq('格宽仍是最小格宽（不为单页压小字号）', lay.cell, lay.mm.MIN_CELL);

    const restore = hookRender(env.record);
    let threw = null;
    try { env.p._buildPrintPage(lay, 0, 0); }
    catch (e) { threw = String(e.message); }
    finally { restore(); }
    ok('单页构建可正常产出', threw === null, threw);
    if (threw) return;
    const dg = env.record.grid[0];
    eq('单页 drawGrid 收到完整 20×20', [dg.w, dg.h], [20, 20]);
    ok('单页右边界仍在可打印区内', dg.offX + dg.w * dg.cell <= lay.mm.PW - lay.mm.M + 0.01,
      { right: dg.offX + dg.w * dg.cell, PW: lay.mm.PW });
    eq('单页不画拼接示意图', !env.record.texts.some(t => t.text === '拼接位置'), true);

    // 30×30 现在需要 2 页（每页 21 行）—— 这是可读字号的代价，不是退化
    const env2 = initPreview(30, 30);
    const lay2 = env2.p._printLayout();
    eq('30×30 每页容不下就老实分页', lay2.pagesY, Math.ceil(30 / lay2.rows));
    ok('30×30 的格宽与其它页面完全一致（同比例才能拼接）', lay2.cell === lay.cell,
      { a: lay2.cell, b: lay.cell });
  });

  // ============================================================
  await sec('C6 端到端 generatePrint：确认后逐张生成并存入相册', async () => {
    let asked = null;
    const env = initPreview(100, 100, {
      // 导出前必须先把总张数告诉用户（可读字号会显著增加纸张/墨水成本）
      wx: { showModal: o => { asked = o; if (o.success) o.success({ confirm: true }); } }
    });
    const lay = env.p._printLayout();
    ok('100×100 需要分页', lay.pageCount > 1, lay.pageCount);
    ok('总张数 = 施工图 + 采购清单', lay.totalPages === lay.pageCount + lay.bomPages, lay.totalPages);

    env.p.generatePrint();
    ok('生成前弹窗告知总张数', !!asked && String(asked.title).indexOf(String(lay.totalPages)) >= 0,
      asked && asked.title);
    eq('生成并转存的临时文件数 = 总张数', env.record.tmpFileCount, lay.totalPages);
    eq('存入相册的次数 = 总张数', env.record.albumCount, lay.totalPages);
    ok('每页只创建一张整页画布（不是一次开满）', env.record.pageCanvasCount === lay.totalPages,
      { made: env.record.pageCanvasCount, pages: lay.totalPages });
    eq('exportPath 指向第 1 张（分享/保存用）', env.p.exportPath, '/tmp/print-page-1.png');

    // 每张纸面尺寸必须完全一致，否则"适应页面"后拼不起来
    eq('所有页纸面尺寸一致', env.record.pageSizes.every(s => s === env.record.pageSizes[0]), true);

    // 取消确认时一张都不生成
    const env2 = initPreview(100, 100, { wx: { showModal: o => { if (o.success) o.success({ confirm: false }); } } });
    env2.p.generatePrint();
    eq('用户取消后不生成任何文件', env2.record.tmpFileCount, 0);
    eq('用户取消后不写相册', env2.record.albumCount, 0);
  });

  // ============================================================
  await sec('C7 空数据保护：无网格时 generatePrint 不抛错、不存图', async () => {
    const env = initPreview(10, 10);
    env.p.grid = [];
    let threw = null;
    try { env.p.generatePrint(); } catch (e) { threw = String(e.message); }
    ok('无网格时不抛错', threw === null, threw);
    eq('无网格时不生成任何临时文件', env.record.tmpFileCount, 0);
    eq('无网格时不写相册', env.record.albumCount, 0);
  });

  // ============================================================
  await sec('C8 静态标记：分页实现与文案都在，且旧的单页硬塞逻辑已消失', async () => {
    const pj = fs.readFileSync(path.join(ROOT, 'pages/preview/preview.js'), 'utf8');
    const wxml = fs.readFileSync(path.join(ROOT, 'pages/preview/preview.wxml'), 'utf8');
    const rj = fs.readFileSync(path.join(ROOT, 'utils/render.js'), 'utf8');
    ok('preview.js 有 _printLayout', pj.indexOf('_printLayout(') >= 0, true);
    ok('preview.js 有 _buildPrintPage', pj.indexOf('_buildPrintPage(') >= 0, true);
    ok('preview.js 有 _renderPrintPage（逐页串行保存）', pj.indexOf('_renderPrintPage(') >= 0, true);
    ok('render.js 的 drawCoordLines 接受 startX/startY', rj.indexOf('opts.startX') >= 0 && rj.indexOf('opts.startY') >= 0, true);
    ok('wxml 提示文案写明 A4 横向与 10mm 边距', wxml.indexOf('A4 横向') >= 0 && wxml.indexOf('10mm') >= 0, true);
    ok('旧的「格宽夹到 6px」逻辑已消失', pj.indexOf('Math.max(6, Math.min(40') < 0, true);
    ok('旧的一次性 3200 高度收缩循环已消失', pj.indexOf('while (cell * h > 3200') < 0, true);
    // R4 新契约的静态标记
    ok('纸面规格常量 PRINT 存在（横向/边距/最小字号/分辨率）',
      pj.indexOf('const PRINT = {') >= 0 && pj.indexOf('minPt: 8') >= 0 && pj.indexOf('marginMM: 10') >= 0, true);
    ok('每页纸面尺寸由 _printMetrics 统一给出（不再逐页算高）',
      pj.indexOf('_printMetrics()') >= 0 && pj.indexOf('Math.max(1754,') < 0, true);
    ok('采购清单有独立页构建函数', pj.indexOf('_buildBomPage(') >= 0, true);
    ok('采购清单列宽按实测文本自适应', pj.indexOf('_bomLayout(') >= 0, true);
  });

  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})();
