'use strict';
// verification/groupE_recheck2_test.js
//
// 组 E（第三方**修复复核报告**第二轮 R3~R7）回归测试。
//
// 覆盖范围与复核报告的对应关系：
//   R3 无法识别品牌的旧作品仍被默认为 MARD
//      → 迁移层的 brandUnknown 一路带到编辑/预览/保存，未确认品牌前**拦住一切导出**，
//        并提供手选品牌入口（用户选定的 A 方案）。
//   R4 打印分页完成但不是可靠的 A4 施工图
//      → 按用户参数重做：A4 横向 / 四边 10mm / 最小字号 8pt / 采购清单单独出页；
//        所有页纸面尺寸完全一致，格宽由最小字号反推，图例列宽按实测文本自适应。
//   R5 抠图导出仍有异步覆盖
//      → 渲染/遮罩/导出串行化：必须等重绘结束再烧遮罩，且导出期间不允许别的重绘插队。
//   R6 回滚恢复二次失败后，重试可能毁掉原备份
//      → 回滚前先收尾未完成事务；未确认安全前绝不覆盖唯一救援快照。
//   R7 模板换了色号，绘图颜色仍保留旧 RGB
//      → 颜色元数据五个字段（code/short/hex/rgb/name）同源，原色进 sourceColor 留档。
//
// 断言原则（与审查报告点名批评的"假验证"相反）：
//   · 全部走**真实页面入口**（onLoad / generatePrint / goEditor / applyTemplate /
//     loadFromData → goPreview / onPickBrand），不手工修补字段、不手工构造结果；
//   · 画布用真实 @napi-rs/canvas，字号/列宽这类几何量用真实 measureText 复算；
//   · 每节独立隔离异常，一节失败不中断后续节；
//   · 本文件在**修复前**的代码上必须大面积 FAIL —— 这就是它的鉴别力。
//
// 用法：
//   NODE_PATH=<node_modules> node verification/groupE_recheck2_test.js
// 依赖 @napi-rs/canvas。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..');
const requireSrc = createRequire(path.join(ROOT, 'app.js'));
const loader = requireSrc('./utils/paletteLoader.js');
const render = requireSrc('./utils/render.js');
const migrate = requireSrc('./utils/migrate.js');
const storage = requireSrc('./utils/storage.js');

// 中文字形：与真机一致的近似。拿不到也不影响几何断言（measureText 用兜底字体）。
try { GlobalFonts.registerFromPath('/System/Library/Fonts/STHeiti Light.ttc', 'sans-serif'); } catch (e) { /* 忽略 */ }

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '   → ' + JSON.stringify(detail) : '')); }
}
function eq(name, actual, expect) {
  const a = JSON.stringify(actual), e = JSON.stringify(expect);
  ok(name, a === e, a === e ? undefined : { actual: actual, expect: expect });
}
async function sec(title, fn) {
  console.log('\n=== ' + title + ' ===');
  try { await fn(); }
  catch (e) { fail++; console.log('  FAIL [本节异常中断] ' + title + ' → ' + (e && e.message ? e.message : String(e))); }
}
const clone = x => JSON.parse(JSON.stringify(x));
const silent = { log() {}, error() {}, warn() {} };
const readFile = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
// 去掉注释后再做"旧写法是否已消失"的静态断言，避免注释里的旧代码误报
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function makeApp() {
  return {
    globalData: { prefs: { brand: 'mard', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} }, project: null },
    savePrefs() {},
    setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
  };
}

// 页面加载器：真画布 + 可注入的 wx 桩 + 可注入的全局（用于替换 setTimeout）
function page(name, options) {
  options = options || {};
  let def;
  const store = options.store || {};
  const app = options.app || makeApp();
  const calls = options.calls || {};
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
  const sandbox = Object.assign({
    require: createRequire(filename), getApp: () => app, Page: d => { def = d; }, wx,
    console: silent, setTimeout, clearTimeout, setImmediate,
    Uint8ClampedArray, Uint8Array, Int8Array, Int32Array, Map, Set,
    Object, Array, JSON, Math, Date, String, Number, Boolean, Promise, Error
  }, options.globals || {});
  const context = vm.createContext(sandbox);
  vm.runInContext(readFile('pages/' + name + '/' + name + '.js'), context, { filename });
  def.data = clone(def.data);
  def.setData = function (p, cb) { Object.assign(this.data, p); if (cb) cb(); };
  return { p: def, app, wx, store, calls, context };
}

function metaOf(rgb, code, name) {
  return {
    rgb: rgb, code: code, short: code, name: name || code,
    hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  };
}

// 预览页：真入口 onLoad + 真画布；记录每张整页画布尺寸与 drawGrid/文字调用
function newRecord() {
  return { pageSizes: [], texts: [], gridCalls: [], tmpCount: 0, albumCount: 0, covers: [] };
}
function initPreview(w, h, opts) {
  opts = opts || {};
  const app = makeApp();
  const colorMeta = opts.colorMeta || { 0: metaOf([216, 1, 39], 'M01') };
  const grid = opts.grid || new Array(w * h).fill(0);
  const project = {
    w: w, h: h, grid: grid, colorMeta: colorMeta, brand: 'mard',
    boards: opts.boards || null, brandUnknown: opts.brandUnknown || false
  };
  app.globalData.project = project;
  const record = newRecord();
  const wx = Object.assign({
    createOffscreenCanvas(o) {
      const c = createCanvas(o.width, o.height);
      if (o.width > 100) record.pageSizes.push(o.width + 'x' + o.height);
      const origGet = c.getContext.bind(c);
      c.getContext = function (type) {
        const ctx = origGet(type);
        if (!ctx.__hooked) {
          ctx.__hooked = true;
          const oFill = ctx.fillText.bind(ctx);
          ctx.fillText = function (t, x, y) { record.texts.push({ text: String(t), x: x, y: y }); return oFill(t, x, y); };
        }
        return ctx;
      };
      return c;
    },
    canvasToTempFilePath(o) {
      record.tmpCount++;
      if (o.success) o.success({ tempFilePath: '/tmp/e-page-' + record.tmpCount + '.png' });
    },
    saveImageToPhotosAlbum(o) { record.albumCount++; if (o.success) o.success(); }
  }, opts.wx || {});
  const env = page('preview', { app: app, wx: wx });
  env.p.onLoad();
  env.record = record;
  env.project = project;
  return env;
}
const origDrawGrid = render.drawGrid;
function hookGrid(record) {
  record.gridCalls = [];
  render.drawGrid = function (ctx, o) {
    record.gridCalls.push(clone(o && {
      w: o.w, h: o.h, cell: o.cell, offX: o.offX, offY: o.offY,
      showCode: o.showCode, labelMinCell: o.labelMinCell, gridLen: o.grid && o.grid.length
    }));
    return origDrawGrid.apply(null, arguments);
  };
  return function () { render.drawGrid = origDrawGrid; };
}
// 真画布上的文本测宽（与 render.textWidth 同口径）
const probeCtx = createCanvas(16, 16).getContext('2d');
function tw(text, fontPx) {
  probeCtx.font = (fontPx || 15) + 'px sans-serif';
  return probeCtx.measureText(String(text)).width;
}

(async () => {
  console.log('《豆豆工坊A》组 E 回归测试 —— 第三方复核报告第二轮 R3~R7');
  console.log('入口：真实 preview / editor / adjust / storage 页面与模块');

  // ============================================================
  await sec('E1 R5 抠图导出：重绘结束才烧遮罩，导出期间不让重绘插队', async () => {
    const src = readFile('pages/adjust/adjust.js');
    const body = strip(src);
    ok('goEditor 里 await 了 render()（旧版直接调用不等）', /await this\.render\(\);/.test(body), true);
    ok('烧遮罩在 await 之后（顺序不可颠倒）',
      body.indexOf('await this.render();') < body.indexOf('if (this.data.cutMode && this.mask) this.applyMask();'), true);
    ok('导出也在同一个串行事务内（不是裸调 canvasToTempFilePath）',
      /await this\._exportToEditor\(\);/.test(body), true);
    // 裸 this.render() 只允许剩两处：_queueRender 助手内部，以及 goEditor 事务内部。
    // 其余任何地方直连 render() 都会绕开串行链，正是 R5 的成因。
    const bareRender = body.match(/this\.render\(\)/g) || [];
    ok('裸 this.render() 只剩两处：串行助手 _queueRender + goEditor 事务',
      bareRender.length === 2
      && /_queueRender\(\)\s*\{\s*return this\._serial\(\(\)\s*=>\s*this\.render\(\)\);?\s*\}/.test(body)
      && /this\._serial\(async \(\) => \{\s*await this\.render\(\);/.test(body),
      bareRender.length);
    // 逐个方法取函数体，确认 10 个 UI 重绘入口都排队、无一直连 render()
    const methodBody = (name) => {
      const m = new RegExp('\\n  ' + name + '\\([^)]*\\)\\s*\\{').exec(body);
      if (!m) return null;
      const rest = body.slice(m.index + m[0].length);
      const nxt = /\n  [A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.exec(rest);
      return nxt ? rest.slice(0, nxt.index) : rest;
    };
    const uiRedraw = ['onLoad', 'setImage', 'onBrightness', 'onContrast', 'onSaturate',
      'rotate90', 'toggleMirror', 'cutWhite', 'reset', 'setRatio'];
    const offenders = uiRedraw.filter((n) => {
      const seg = methodBody(n);
      if (seg == null) return true;   // 方法都找不到，同样算违规
      return /this\.render\(\)/.test(seg) || !/this\._queueRender\(\)/.test(seg);
    });
    ok('10 个 UI 重绘入口全部走 _queueRender（无一直连 render）', offenders.length === 0, offenders);
    ok('导出回调不返回时有看门狗，不会永久卡住渲染链',
      body.indexOf('导出回调超时，恢复渲染队列') >= 0 && body.indexOf('15000') >= 0, true);

    // 真入口：真画布 + 真 render/applyMask/goEditor
    const setup = (stub) => {
      const env = page('adjust', { wx: { canvasToTempFilePath: stub } });
      const p = env.p;
      p.canvas = createCanvas(2, 2); p.ctx = p.canvas.getContext('2d');
      p.cssW = 2; p.cssH = 2;
      p.img = createCanvas(2, 2);
      const ic = p.img.getContext('2d'); ic.fillStyle = '#f00'; ic.fillRect(0, 0, 2, 2);
      p.imgSrc = 'existing'; p.data.src = 'existing'; p.data.cutMode = true;
      p.crop = { sx: 0, sy: 0, sw: 2, sh: 2 };
      p.ensureCanvas = () => Promise.resolve();
      p.ctx.drawImage(p.img, 0, 0);
      p.mask = new Uint8Array([0, 1, 1, 1]); p.maskW = 2; p.maskH = 2;
      return p;
    };

    let cap = null;
    const p = setup(o => {
      cap = new Promise(r => setTimeout(() => r(o.canvas.getContext('2d').getImageData(0, 0, 2, 2).data[3]), 0));
      if (o.success) o.success({ tempFilePath: '/tmp/x.png' });
    });
    p.goEditor();
    await p._chain;
    const atExport = cap ? await cap : null;
    eq('编码器真正取像素时，擦除处 alpha = 0（透明是真的）', atExport, 0);

    // 导出前立刻拖滑杆：旧版正是被这次重绘覆盖掉的
    let cap2 = null;
    const p2 = setup(o => {
      cap2 = new Promise(r => setTimeout(() => r(o.canvas.getContext('2d').getImageData(0, 0, 2, 2).data[3]), 0));
      if (o.success) o.success({ tempFilePath: '/tmp/x.png' });
    });
    p2.data.brightness = 60;
    p2._queueRender();     // 先入队一次重绘，模拟"点完成前改亮度"
    p2.goEditor();
    await p2._chain;
    const b = cap2 ? await cap2 : null;
    eq('导出前改过亮度，擦除结果仍然保留', b, 0);

    // 旧顺序对照：证明这个探针确实抓得住原来的缺陷
    let cap3 = null;
    const p3 = setup(o => {
      cap3 = new Promise(r => setTimeout(() => r(o.canvas.getContext('2d').getImageData(0, 0, 2, 2).data[3]), 0));
      if (o.success) o.success({ tempFilePath: '/tmp/x.png' });
    });
    p3.render(); p3.applyMask(); p3._exportToEditor();   // 旧写法：不等渲染 → 烧遮罩 → 立刻导出
    await p3._chain;
    const c3 = cap3 ? await cap3 : null;
    eq('旧写法会复现缺陷（alpha 又变回 255）—— 说明断言有鉴别力', c3, 255);

    // 看门狗：导出回调永不返回时，渲染链必须能恢复
    let wd = null;
    const p4 = setup(() => { /* 故意不回调，模拟平台两侧都不回 */ });
    const env4 = page('adjust', { wx: { canvasToTempFilePath: () => {} }, globals: { setTimeout: (fn) => { wd = fn; return 1; }, clearTimeout: () => {} } });
    const q = env4.p;
    q.canvas = createCanvas(2, 2); q.ctx = q.canvas.getContext('2d'); q.cssW = 2; q.cssH = 2;
    q.img = createCanvas(2, 2); q.imgSrc = 'e'; q.data.src = 'e'; q.data.cutMode = true;
    q.crop = { sx: 0, sy: 0, sw: 2, sh: 2 }; q.ensureCanvas = () => Promise.resolve();
    q.mask = new Uint8Array([1, 1, 1, 1]); q.maskW = 2; q.maskH = 2;
    q.goEditor();
    // 注意：这里**不能** await q._chain。回调不回时这条链永远不会 settle，
    // 直接 await 会让整个测试进程静默退出（事件循环空了，退出码还是 0）。
    // 所以只等微任务清空，再用一个分支探针观察链是否仍挂着。
    await new Promise(r => setImmediate(r));
    ok('回调未返回时事务停在导出上（等看门狗）', typeof wd === 'function', typeof wd);
    let hung = true;
    const watch = q._chain.then(() => { hung = false; }, () => { hung = false; });
    await new Promise(r => setImmediate(r));
    ok('导出回调不返回时渲染链确实挂住（不会自己醒）', hung === true, hung);
    if (typeof wd === 'function') {
      wd();
      let settled = false;
      await watch.then(() => { settled = true; }, () => { settled = true; });
      ok('看门狗触发后渲染链恢复（页面不会永久卡死）', settled, true);
      ok('导出状态被复位，可以重新导出', q._exporting === false, q._exporting);
    }
    void p4;
  });

  // ============================================================
  await sec('E2 R7 模板与迁移：颜色字段必须互相自洽', async () => {
    // ① 真实入口：编辑器套模板
    const env = page('editor', { wx: { getWindowInfo: () => ({ pixelRatio: 1, windowWidth: 375, windowHeight: 800 }) } });
    const p = env.p;
    Object.assign(p.data, { w: 10, h: 10, shape: 'rect' });
    p.fullGrid = new Array(100).fill(0); p.grid = new Array(100).fill(0);
    p.colorMeta = {}; p.locked = {}; p._undoStack = []; p._redoStack = []; p._stroke = null;
    p.cell = 10; p.offX = 0; p.offY = 0;
    p.renderGrid = () => {}; p.renderCell = () => {};
    p.computeCell = () => {};
    loader.setCurrentBrand('mard');
    p.onLoad ? null : null;
    p.applyTemplate({ currentTarget: { dataset: { key: 'heart', name: '爱心' } } });
    const m0 = p.colorMeta[0];
    ok('套模板后仍拿得到品牌色号', !!m0 && !!m0.code, m0 && m0.code);
    const rgbHex = '#' + Array.from(m0.rgb).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    eq('绘图 rgb 与标注 hex 是同一个颜色（复核 R7 的核心）', rgbHex, String(m0.hex).toUpperCase());
    const mardCodes = new Set(loader.getPaletteColors('mard').map(c => String(c.code)));
    ok('色号确实来自 MARD 色卡', mardCodes.has(String(m0.code)), m0.code);
    const mardByCode = loader.getPaletteColors('mard').find(c => String(c.code) === String(m0.code));
    eq('rgb 就是该色号在色卡里的 rgb', Array.from(m0.rgb), Array.from(mardByCode.rgb));
    ok('模板原色进了 sourceColor 留档（不参与绘制）',
      !!m0.sourceColor && Array.isArray(m0.sourceColor.rgb), m0.sourceColor);

    // ② 迁移：rgb 与 hex 不一致的旧记录要被拉齐
    const bad = { code: 'F13', short: 'F13', name: 'F13', hex: '#DD422F', rgb: [224, 48, 30] };
    const rec = { w: 1, h: 1, grid: [0], brand: 'mard', colors: [Object.assign({ id: 0 }, bad)] };
    const out = migrate.migrateRecord(rec).rec;
    const f = out.colors[0];
    const fHex = '#' + Array.from(f.rgb).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    eq('迁移后 hex 与 rgb 一致', fHex, String(f.hex).toUpperCase());
    eq('迁移后 rgb 取自目标色卡', Array.from(f.rgb), [221, 66, 47]);
    ok('旧 rgb 被留档到 sourceColor', !!f.sourceColor && f.sourceColor.rgb[0] === 224, f.sourceColor);

    // ③ 迁移：色卡里没有该色值但色号仍有效时，rgb/hex 也要自洽
    const odd = { id: 0, code: 'F13', short: 'F13', name: 'F13', hex: '#123456', rgb: [200, 100, 50] };
    const out2 = migrate.migrateRecord({ w: 1, h: 1, grid: [0], brand: 'mard', colors: [odd] }).rec;
    const g = out2.colors[0];
    const gHex = '#' + Array.from(g.rgb).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    eq('色卡无此色值时也自洽（rgb 由 hex 推出）', gHex, String(g.hex).toUpperCase());
    eq('色号保持不变（没有乱映射）', String(g.code), 'F13');

    // ④ 静态：不再"只在缺失时才补 rgb"
    const msrc = strip(readFile('utils/migrate.js'));
    ok('旧的条件式补 rgb 已消失', msrc.indexOf('if (!out.rgb) out.rgb = exact.rgb;') < 0, true);
    ok('新增 alignTo/alignSelf 统一同源', msrc.indexOf('function alignTo(') >= 0 && msrc.indexOf('function alignSelf(') >= 0, true);
    const esrc = strip(readFile('pages/editor/editor.js'));
    ok('applyTemplate 不再直接用模板 rgb 当绘制色', /rgb:\s*pc\.rgb\s*\|\|\s*srcRgb/.test(esrc), true);
  });

  // ============================================================
  await sec('E3 R3 未知品牌的旧作品：不带品牌进下游，导出被拦，可当场手选', async () => {
    loader.setCurrentBrand('mard');
    const mardCodes = loader.getPaletteColors('mard').map(c => String(c.code));
    // ① 迁移层：单色缺品牌 → brandUnknown，且**不猜**
    // 样本色号特意选任何品牌色卡里都不存在的 'ZZ9'：只用 'C1' 这类恰好
    // 也是 MARD 真色号的字符串，压根分不清"原样保留"和"被悄悄改写成合法色号"（复核 R3）。
    const raw = migrate.migrateRecord({ w: 1, h: 1, grid: [0], colors: [{ id: 0, rgb: [12, 34, 56], hex: '#0C2238', code: 'ZZ9' }] }).rec;
    ok('迁移层标出 brandUnknown', raw.brandUnknown === true, raw.brandUnknown);
    eq('迁移层没有硬塞品牌', raw.brand || '', '');
    eq('迁移层原样保留旧色号', String(raw.colors[0].code), 'ZZ9');

    // ② 真实入口：编辑器载入 → 预览
    const env = page('editor', { wx: { getWindowInfo: () => ({ pixelRatio: 1, windowWidth: 375, windowHeight: 800 }) } });
    const p = env.p;
    p.onLoad({});
    p.loadFromData(raw);
    ok('编辑器记住"品牌未知"', p.brandUnknown === true, p.brandUnknown);
    eq('编辑器把标记同步到界面（提示条才有得显示）', p.data.brandUnknown, true);
    ok('色号系统选择器仍在（用户有地方能改）', Array.isArray(p.data.brandNames) && p.data.brandNames.length > 0, p.data.brandNames);

    p.goPreview();
    const proj = env.app.globalData.project;
    eq('预览项目的品牌留空（不再冒充当前默认品牌）', proj.brand, '');
    eq('品牌名也留空（标题不会写 MARD）', proj.brandName, '');
    eq('未知标记带到了预览页', proj.brandUnknown, true);
    eq('旧色号原样保留（没有被改写成目标品牌的合法色号）', String(proj.colorMeta[0].code), 'ZZ9');
    ok('它确实不是 MARD 的合法色号 —— 说明"偷偷换成 MARD"没有发生',
      mardCodes.indexOf('ZZ9') < 0, proj.colorMeta[0].code);

    // ③ 预览页：六个导出入口全部被拦住
    const e2 = initPreview(1, 1, {
      brandUnknown: true,
      colorMeta: { 0: { rgb: [12, 34, 56], hex: '#0C2238', code: 'C1', short: 'C1', name: 'C1' } }
    });
    let modal = 0;
    e2.wx.showModal = () => { modal++; };
    e2.wx.setClipboardData = () => { e2.calls.clip = (e2.calls.clip || 0) + 1; };
    const before = e2.record.tmpCount;
    e2.p.exportImage();
    e2.p.exportPlain();
    e2.p.generatePrint();
    e2.p.copyBOM();
    e2.p.openBuy();
    e2.p.copyBuy({ currentTarget: { dataset: { item: { name: 'x', code: 'C1' } } } });
    eq('六个导出入口一张图都不生成', e2.record.tmpCount, before);
    eq('六个导出入口一次相册都不写', e2.record.albumCount, 0);
    eq('六个入口都弹了提示（不是静默失败）', modal, 6);
    ok('采购助手没被打开', e2.p.data.showBuy === false, e2.p.data.showBuy);
    eq('复制购买词也没执行', e2.calls.clip || 0, 0);

    // ④ 手选品牌后解除拦截，并且色号真的变成目标品牌的
    const e3 = initPreview(1, 1, {
      brandUnknown: true,
      colorMeta: { 0: { rgb: [216, 1, 39], hex: '#D80127', code: 'C1', short: 'C1', name: 'C1' } }
    });
    const idx = loader.getBrandList().findIndex(b => b.key === 'mard');
    e3.p.onPickBrand({ detail: { value: String(idx) } });
    eq('手选后不再标记为未知', e3.p.data.brandUnknown, false);
    // 转换后色号会重新编号（旧 id 0 → 新色卡下标），所以要用新网格里的值去取色元数据
    const newId = e3.p.grid[0];
    const nm = e3.p.colorMeta[newId];
    ok('转换后新色号的元数据存在', !!nm, { newId: newId, keys: Object.keys(e3.p.colorMeta) });
    ok('手选后色号来自目标色卡', !!nm && mardCodes.indexOf(String(nm.code)) >= 0, nm && nm.code);
    eq('手选后品牌名出现在标题上', e3.p.data.brandName, loader.getPaletteInfo('mard').brandName);
    e3.record.tmpCount = 0;
    e3.p.exportImage();
    ok('手选后导出放行（真的开始生成图纸）', e3.record.tmpCount > 0, e3.record.tmpCount);

    // ⑤ 静态：草稿与保存都不许把"未知"洗成默认品牌
    const esrc = strip(readFile('pages/editor/editor.js'));
    ok('草稿不再无脑回退当前默认品牌',
      /brand:\s*this\.brandUnknown\s*\?\s*''\s*:/.test(esrc), true);
    ok('草稿带上 brandUnknown 标记', /brandUnknown:\s*!!this\.brandUnknown,/.test(esrc), true);
    const psrc = strip(readFile('pages/preview/preview.js'));
    ok('存历史时也带上 brandUnknown', /brandUnknown:\s*!!this\.brandUnknown,/.test(psrc), true);
    ok('编辑器界面有未知品牌的提示闭环', readFile('pages/editor/editor.wxml').indexOf('wx:if="{{brandUnknown}}"') >= 0, true);
    ok('预览界面有未知品牌的提示与手选入口',
      readFile('pages/preview/preview.wxml').indexOf('onPickBrand') >= 0, true);
  });

  // ============================================================
  await sec('E4 R4 打印：固定 A4 横向纸面 / 8pt 可读 / 采购清单单独出页', async () => {
    const W = 200, H = 200;
    const pal = loader.getPaletteColors('mard');
    const colorMeta = {};
    for (let i = 0; i < 20; i++) {
      const c = pal[i];
      colorMeta[i] = { rgb: c.rgb, hex: c.hex, code: c.code, short: c.short, name: c.name };
    }
    const grid = Array.from({ length: W * H }, (_, i) => Math.floor((i % W) / 10) % 20);
    const env = initPreview(W, H, { colorMeta: colorMeta, grid: grid });
    const lay = env.p._printLayout();
    const mm = lay.mm;
    const pxPerMM = 150 / 25.4;

    // ① 纸面：A4 横向、10mm 边距
    eq('纸面宽 297mm', Math.round(mm.PW / pxPerMM), 297);
    eq('纸面高 210mm', Math.round(mm.PH / pxPerMM), 210);
    eq('边距 10mm', Math.round(mm.M / pxPerMM), 10);

    // ② 格宽由 8pt 反推；换算到纸面后字号必须 ≥ 8pt
    const minCellExpected = Math.ceil(2 * 8 * 150 / 72);
    eq('最小格宽 = 2×8pt×150dpi/72', mm.MIN_CELL, minCellExpected);
    eq('实际格宽就是最小格宽（不无谓放大、不偷偷压小）', lay.cell, minCellExpected);
    const fontPx = Math.floor(Math.min(lay.cell * 0.5, lay.cell * 1.53 / 3));
    const cellMM = lay.cell / pxPerMM;
    const fontPt = fontPx / pxPerMM * 72 / 25.4;
    ok('纸上格宽 ≥ 5mm（不是旧版的 1.49mm）', cellMM >= 5, cellMM);
    ok('纸上三字符字号 ≥ 8pt（旧版约 2.11pt）', fontPt >= 8, fontPt);
    ok('每页列数 × 格宽不超过可打印宽度', lay.cols * lay.cell <= mm.PW - mm.M * 2, {
      cols: lay.cols, right: mm.M + lay.GUTTER + lay.cols * lay.cell, limit: mm.PW - mm.M
    });
    ok('每页行数 × 格高不超过可打印高度（含页脚）',
      mm.M + lay.HEADER_H + lay.GUTTER + lay.rows * lay.cell <= mm.PH - mm.M - lay.FOOTER_H, {
      rows: lay.rows, FOOTER_H: lay.FOOTER_H
    });

    // ③ 真实构建第 1 页与"下一排第 1 页"
    const restore = hookGrid(env.record);
    let off1, off2, threw = null;
    try { off1 = env.p._buildPrintPage(lay, 0, 0); off2 = env.p._buildPrintPage(lay, 0, 1); }
    catch (e) { threw = String(e.message); }
    finally { restore(); }
    ok('施工图页可正常产出', threw === null, threw);
    if (threw) return;
    eq('所有施工图页纸面尺寸相同（这是能按比例拼接的前提）',
      [off1.width, off1.height, off2.width, off2.height], [mm.PW, mm.PH, mm.PW, mm.PH]);

    const dg = env.record.gridCalls[0];
    ok('drawGrid 被调用', !!dg);
    const gridRight = dg.offX + dg.w * dg.cell;
    eq('网格右边界不越出可打印区（clippedPixels = 0）', gridRight <= mm.PW - mm.M + 0.01, true);
    eq('drawGrid 打开了格内色号', dg.showCode, true);
    ok('labelMinCell = 格宽 ⇒ 色号必定被印出（不会再被"格子太小"关掉）',
      dg.cell >= dg.labelMinCell, { cell: dg.cell, labelMinCell: dg.labelMinCell });
    eq('drawGrid 收到的是本页切片而非整张网格', dg.gridLen, dg.w * dg.h);
    ok('本页切片确实小于整张图纸', dg.w * dg.h < W * H, dg.w * dg.h);

    // ④ 页眉页码 / 绝对坐标
    const texts = env.record.texts.map(t => t.text);
    ok('页眉有页码与总页数', texts.some(t => /第\s*1\s*\/\s*\d+\s*页/.test(t)), texts.slice(0, 6));
    ok('页眉有本页绝对行列范围', texts.some(t => /列\s*1\s*-\s*\d+/.test(t) && /行\s*1\s*-\s*\d+/.test(t)), texts.slice(0, 6));
    ok('页脚说明指向最后一页的完整色卡', texts.some(t => /完整色卡与采购清单见最后一页/.test(t)), true);
    ok('页脚标出拼接顺序', texts.some(t => /按页码顺序拼接/.test(t)), true);

    // ⑤ 采购清单单独出页，且与施工图同纸面
    ok('有独立的采购清单页', lay.bomPages >= 1, lay.bomPages);
    eq('总张数 = 施工图 + 采购清单', lay.totalPages, lay.pageCount + lay.bomPages);
    const rec2 = newRecord();
    const restore2 = hookGrid(rec2);
    // 文字录器挂在 wx.createOffscreenCanvas 上、写的是 env.record，所以按"调用前的位置"
    // 切片取本页文字；rec2 只负责拦 drawGrid（用来证明清单页不画网格）。
    const textBase = env.record.texts.length;
    let bomCanvas;
    try { bomCanvas = env.p._buildBomPage(lay, 0); }
    catch (e) { threw = String(e.message); }
    finally { restore2(); }
    ok('采购清单页可正常产出', !threw, threw);
    if (threw) return;
    eq('采购清单页纸面与施工图完全一致', [bomCanvas.width, bomCanvas.height], [mm.PW, mm.PH]);
    eq('采购清单页不画网格（图纸与清单分家）', rec2.gridCalls.length, 0);
    const bomTexts = env.record.texts.slice(textBase).map(t => t.text);
    ok('清单页确实印了字', bomTexts.length > 0, bomTexts.length);
    ok('清单含全部 20 个色号', colorMeta[0] && Object.keys(colorMeta).every(k =>
      bomTexts.indexOf(String(colorMeta[k].code)) >= 0), bomTexts.slice(0, 10).concat(['...']));
    ok('清单印出建议购买量（+5% 备用）', bomTexts.some(t => /建议购买/.test(t)), bomTexts.slice(0, 12));
    ok('清单印出合计', bomTexts.some(t => /^合计\s/.test(t)), bomTexts.filter(t => /合计/.test(t)));

    // ⑥ 图例列宽按实测文本自适应：长数量不再压到下一列
    const longPanel = [
      { hex: '#D80127', code: 'F13', name: '大红色', count: 2000, suggest: 2100 },
      { hex: '#FFFFFF', code: 'H1', name: 'White White', count: 1500, suggest: 1575 },
      { hex: '#000000', code: 'A14', name: '黑色', count: 800, suggest: 800 }
    ];
    const lctx = createCanvas(16, 16).getContext('2d');
    // colWidth 是"建议值"，最终取 max(建议值, 实测需要值)。这里故意不给建议值
    // （colWidth: 0），才能看出列宽完全由真实文本量出来 —— 给 300 的话两次都
    // 被 300 兜住，看不出自适应。
    const l3 = render.legendLayout(lctx, { panel: longPanel, cols: 3, colWidth: 0, maxWidth: 1636, fontPx: 15 });
    const buyW = tw('2000/2100', l3.fontPx);
    ok('用量文本完整落在本列内（不越过下一列起点）',
      l3.countX + buyW <= l3.colWidth, { end: l3.countX + buyW, nextCol: l3.colWidth });
    ok('旧版写死的 240 起点会越过下一列 —— 说明这个几何断言抓得住原缺陷', 240 + buyW > 300, 240 + buyW);
    ok('三列总宽仍在纸面内', 3 * l3.colWidth <= 1636, 3 * l3.colWidth);
    const lLong = render.legendLayout(lctx, {
      panel: longPanel.map((c, i) => Object.assign({}, c, { name: '很长的颜色名称' + i })),
      cols: 3, colWidth: 0, maxWidth: 1636, fontPx: 15
    });
    ok('名称变长时列宽自动变宽（不是硬挤出界）', lLong.colWidth > l3.colWidth, [l3.colWidth, lLong.colWidth]);
    ok('名称变长后三列仍在纸面内', 3 * lLong.colWidth <= 1636, 3 * lLong.colWidth);
    // 建议值大于实测值时取建议值（调用方可以要求更宽的列）
    const lGiven = render.legendLayout(lctx, { panel: longPanel, cols: 3, colWidth: 999, maxWidth: 5000, fontPx: 15 });
    eq('建议值更大时听建议值', lGiven.colWidth, 999);
    // legendLayout 必须按传进来的字号量文本。textWidth 量的是"当前画布字体"，
    // 所以量之前得先把字体设成 fontPx；否则按字号收缩的重试每次量到同一个宽度，
    // 列宽与字号无关（复核 R4 复检）。这条断言就是钉住这一点。
    const fontBefore = lctx.font;
    const lBig = render.legendLayout(lctx, { panel: longPanel, cols: 1, colWidth: 0, maxWidth: 0, fontPx: 30 });
    const lSmall = render.legendLayout(lctx, { panel: longPanel, cols: 1, colWidth: 0, maxWidth: 0, fontPx: 10 });
    ok('列宽随字号真实变化（说明量的是该字号，而不是画布上的残留字体）',
      lBig.colWidth > lSmall.colWidth, { at30: lBig.colWidth, at10: lSmall.colWidth });
    ok('量完不留下副作用（画布字体被还原）',
      lctx.font === fontBefore, { after: lctx.font, before: fontBefore });

    // ⑦ BOM 表各列互不遮挡（用真实列宽 + 真实文本宽度核对）
    const colW = lay.bom.colW;
    let cx = mm.M; const xs = [];
    for (let i = 0; i < colW.length; i++) { xs.push(cx); cx += colW[i]; }
    ok('BOM 表总宽不超过纸面可打印宽度', cx <= mm.PW - mm.M + 1, cx);
    const heads = ['实际用量', '建议购买(+5%)'];
    ok('实际用量列宽 ≥ 表头文字宽度', colW[2] >= tw(heads[0], 16), [colW[2], tw(heads[0], 16)]);
    ok('建议购买列宽 ≥ 表头文字宽度（长数量文本的容器够宽）', colW[3] >= tw(heads[1], 16), [colW[3], tw(heads[1], 16)]);

    // ⑧ 端到端：确认后逐张生成，张数与版面一致
    let asked = null;
    const env2 = initPreview(100, 100, {
      colorMeta: colorMeta,
      grid: Array.from({ length: 100 * 100 }, (_, i) => Math.floor((i % 100) / 10) % 20),
      wx: { showModal: o => { asked = o; if (o.success) o.success({ confirm: true }); } }
    });
    const lay2 = env2.p._printLayout();
    env2.p.generatePrint();
    ok('生成前如实报出总张数', !!asked && String(asked.title).indexOf(String(lay2.totalPages)) >= 0, asked && asked.title);
    eq('生成的张数 = 版面算出的总张数', env2.record.tmpCount, lay2.totalPages);
    eq('存相册次数 = 总张数', env2.record.albumCount, lay2.totalPages);
    eq('每一张的纸面尺寸都相同', env2.record.pageSizes.every(s => s === env2.record.pageSizes[0]), true);
    const size = env2.record.pageSizes[0].split('x');
    eq('每张都是 A4 横向尺寸', [+size[0], +size[1]], [mm.PW, mm.PH]);
    // 100×100 = 10000 格，格宽固定 34px ⇒ 页数应与算术一致，而不是被"适应页面"糊成任意值
    eq('页数 = ceil(列/每页列) × ceil(行/每页行)',
      lay2.pageCount, Math.ceil(100 / lay2.cols) * Math.ceil(100 / lay2.rows));

    // ⑨ 静态：旧的"整张塞进一张画布"的实现彻底消失
    const psrc = strip(readFile('pages/preview/preview.js'));
    ok('旧的固定 1240 宽画布已消失', psrc.indexOf('const PW = 1240') < 0, true);
    ok('旧的可读格宽 24 已消失', psrc.indexOf('READABLE = 24') < 0, true);
    ok('新的纸面规格常量在', psrc.indexOf('minPt: 8') >= 0 && psrc.indexOf('marginMM: 10') >= 0, true);
  });

  // ============================================================
  await sec('E5 R6 回滚事务：不许覆盖唯一救援快照，未完成事务先收尾', async () => {
    ok('storage 导出了 recoverRestore', typeof storage.recoverRestore === 'function', typeof storage.recoverRestore);

    // ① 复现复核报告 R6 的原始故障注入顺序
    const store = {
      history: [{ id: 'CURRENT' }],
      history_bak: { at: 1, projects: [{ id: 'ORIGINAL_BACKUP' }] }
    };
    let bakWrites = 0, fail = true;
    const mk = () => {
      store.history = [{ id: 'CURRENT' }];
      store.history_bak = { at: 1, projects: [{ id: 'ORIGINAL_BACKUP' }] };
      delete store.history_tmp;
      bakWrites = 0; fail = true;
    };
    global.wx = {
      getStorageSync: k => (store[k] ? clone(store[k]) : ''),
      setStorageSync(k, v) {
        if (fail && (k === 'history' || (k === 'history_bak' && ++bakWrites === 2))) throw Error('injected failure');
        store[k] = clone(v);
      },
      removeStorageSync: k => { delete store[k]; }
    };
    const st = requireSrc('./utils/storage.js');
    const first = st.restoreBackup();
    eq('首次回滚失败（预期）', first.ok, false);
    ok('失败后临时键里仍留着救援快照', JSON.stringify(store.history_tmp || {}).indexOf('ORIGINAL_BACKUP') >= 0, store.history_tmp);
    ok('失败时如实告知原备份还在救援区', /救援区/.test(String(first.reason)), first.reason);
    fail = false;
    const second = st.restoreBackup();
    eq('第二次回滚成功', second.ok, true);
    ok('原备份没有从任何存储键里消失（复核 R6 的核心）',
      JSON.stringify(store).indexOf('ORIGINAL_BACKUP') >= 0, Object.keys(store));
    eq('回滚后历史就是备份内容', store.history.map(x => x.id), ['ORIGINAL_BACKUP']);
    ok('临时键已清理', !store.history_tmp, store.history_tmp);

    // ② 临时键现在只存一份救援快照（旧版塞了 cur+bak 两份，容易撞 1MB 单键上限）
    mk(); fail = true;
    st.restoreBackup();
    ok('临时键只保存救援快照，不再保存两份完整历史',
      !!store.history_tmp && !!store.history_tmp.bak && store.history_tmp.cur === undefined, Object.keys(store.history_tmp || {}));

    // ③ recoverRestore：历史已经是救援快照（上次其实换成功、只是没清理）→ 只清临时键
    store.history = [{ id: 'ORIGINAL_BACKUP' }];
    store.history_bak = { at: 9, projects: [{ id: 'CURRENT' }] };
    store.history_tmp = { at: 9, bak: { at: 1, projects: [{ id: 'ORIGINAL_BACKUP' }] } };
    const r1 = st.recoverRestore();
    eq('识别出这是"已完成但没清理"的情形', [r1.recovered, r1.restored], [true, false]);
    ok('只清临时键，不动备份', JSON.stringify(store.history_bak).indexOf('CURRENT') >= 0, store.history_bak);
    ok('临时键已清掉', !store.history_tmp, store.history_tmp);

    // ④ recoverRestore：半换状态 → 把救援快照放回备份键
    store.history = [{ id: 'CURRENT' }];
    store.history_bak = { at: 9, projects: [{ id: 'CURRENT' }] };   // 已被覆盖
    store.history_tmp = { at: 9, bak: { at: 1, projects: [{ id: 'ORIGINAL_BACKUP' }] } };
    const r2 = st.recoverRestore();
    eq('识别出"换到一半"并做恢复', [r2.recovered, r2.restored], [true, true]);
    eq('救援快照回到了备份键', store.history_bak.projects.map(x => x.id), ['ORIGINAL_BACKUP']);
    ok('临时键已清掉', !store.history_tmp, store.history_tmp);

    // ⑤ recoverRestore：备份键写不回去时，必须保留临时键（它是唯一一份）
    store.history = [{ id: 'CURRENT' }];
    store.history_bak = { at: 9, projects: [{ id: 'CURRENT' }] };
    store.history_tmp = { at: 9, bak: { at: 1, projects: [{ id: 'ORIGINAL_BACKUP' }] } };
    global.wx.setStorageSync = (k, v) => { if (k === 'history_bak') throw Error('no space'); store[k] = clone(v); };
    const r3 = st.recoverRestore();
    eq('写不回去就报告失败', r3.recovered, false);
    eq('并且明确保留了临时键', r3.keptTmp, true);
    ok('救援快照仍在临时键里（没有被抹掉）',
      JSON.stringify(store.history_tmp || {}).indexOf('ORIGINAL_BACKUP') >= 0, store.history_tmp);
    const tmpTried = [];
    global.wx.getStorageSync = k => (store[k] ? clone(store[k]) : '');
    global.wx.setStorageSync = (k, v) => { tmpTried.push(k); store[k] = clone(v); };
    const r4 = st.recoverRestore();
    eq('故障排除后能收尾', r4.recovered, true);
    eq('救援快照终于回到备份键', store.history_bak.projects.map(x => x.id), ['ORIGINAL_BACKUP']);
    ok('确实写了备份键', tmpTried.indexOf('history_bak') >= 0, tmpTried);

    // ⑥ 写入内容校验：写进去了但内容不对也要按失败处理
    store.history = [{ id: 'A' }];
    store.history_bak = { at: 1, projects: [{ id: 'B' }] };
    delete store.history_tmp;
    global.wx.setStorageSync = (k, v) => { if (k === 'history') { store[k] = [{ id: 'WRONG' }]; return; } store[k] = clone(v); };
    const r5 = st.restoreBackup();
    eq('内容校验不过 → 判为失败', r5.ok, false);
    ok('失败原因说的是校验未过', /校验/.test(String(r5.reason)), r5.reason);
    ok('救援快照回到了备份键（B 还在）', JSON.stringify(store.history_bak || {}).indexOf('"B"') >= 0, store.history_bak);

    // ⑦ 静态：启动与历史页都要收尾未完成事务
    const appSrc = strip(readFile('app.js'));
    ok('app.js 启动时调用 recoverRestore', appSrc.indexOf('storage.recoverRestore()') >= 0, true);
    const histSrc = strip(readFile('pages/history/history.js'));
    ok('历史页展示回滚入口前也调用 recoverRestore', histSrc.indexOf('storage.recoverRestore()') >= 0, true);
    const stSrc = strip(readFile('utils/storage.js'));
    // 断言要落在**代码**上，不能落在注释上（strip 会把注释去掉，写在注释里的
    // 字样永远匹配不到 —— 这就是一条永远验不到东西的假断言）。
    const rbAt = stSrc.indexOf('function restoreBackup() {');
    const rbBody = rbAt < 0 ? '' : stSrc.slice(rbAt);
    const atRecover = rbBody.indexOf('recoverRestore();');
    const atTmpWrite = rbBody.indexOf('TMP_KEY');
    ok('restoreBackup 开头先收尾未完成事务（先于任何临时键动作）',
      atRecover >= 0 && atTmpWrite >= 0 && atRecover < atTmpWrite, { atRecover: atRecover, atTmpWrite: atTmpWrite });
    ok('旧的"无条件覆盖临时键"已消失',
      stSrc.indexOf("const t = safeSet(TMP_KEY, { cur: curSnap, bak: bakSnap, at: stamp });") < 0, true);
  });

  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})();
