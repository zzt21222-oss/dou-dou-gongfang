'use strict';
// verification/groupB_grid_test.js
//
// 组 B（审查报告第一轮）回归测试：
//   · F03 透明语义：去白底 / 笔刷抠图产出的透明区**真的不拼豆**（不是填成白豆）
//   · F06 权威网格模型：fullGrid 是权威、grid 只是形状投影
//       F06a 切形状不覆盖手工改动
//       F06b 换品牌后切形状不出现 missingColorMeta
//       F06c 圆形图纸重开切矩形绘图不再报 reading 'rgb'
//   · 附带发现：网格落库的形态归一化（Int32Array 经 storage 的 JSON 序列化会退化成对象）
//
// 与审查报告点名批评的"假验证"保持一致的原则：所有断言都走**真实入口**，
// 不手工修补链路中间字段。少量用例为了构造状态会直接给页面实例赋初值，
// 但被断言的读写都经过页面自身的真实方法（onShape / onBrand / floodFill / _snapshot …）。
//
// 每一节独立隔离异常：某一节失败（甚至因为旧代码缺方法而抛错）不会中断后续节，
// 保证"跑一遍就能拿到完整的失败清单"。
//
// 用法：
//   NODE_PATH=<node_modules> node verification/groupB_grid_test.js
// 依赖 @napi-rs/canvas。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..');
const requireSrc = createRequire(path.join(ROOT, 'app.js'));
const loader = requireSrc('./utils/paletteLoader.js');
const bead = requireSrc('./utils/bead.js');
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

// ---------- 页面环境（与审查回归测试同一套桩，保证可比） ----------
function makeApp(brand) {
  return {
    globalData: {
      prefs: { brand: brand || 'mard', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} },
      project: null
    },
    savePrefs() {},
    setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
  };
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
function initEditor(options, loadOptions) {
  const env = page('editor', options);
  env.p.onLoad(loadOptions || { src: encodeURIComponent('test.png') });
  env.p.renderGrid = () => {};
  env.p.computeCell = () => {};
  return env;
}
function metaOf(rgb, code, short) {
  return {
    rgb: rgb, code: code, short: short || code, name: code,
    hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  };
}
function fakeCtx() {
  const texts = [];
  return {
    texts, fillStyle: '', font: '', textAlign: '', textBaseline: '', lineWidth: 1, strokeStyle: '',
    fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, clip() {}, save() {}, restore() {}, clearRect() {},
    fillText(t, x, y) { texts.push({ text: t, x: x, y: y, fill: this.fillStyle }); }
  };
}
// 严格色板：取到不存在的颜色下标立刻抛错（复现 "reading 'rgb'"）
function strictMeta(colorMeta) {
  return new Proxy(colorMeta, {
    get(t, k) {
      if (typeof k === 'string' && !(k in t)) throw new Error('missingColorMeta: colorMeta[' + k + '] is undefined');
      return t[k];
    }
  });
}
// 造一张「透明底 + 左上角不透明方块」的源图（等价于用户抠完背景后导出的 PNG）
function transparentCorner(size, inner, cssColor) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, inner, inner);
  return c;
}
// 造一张「不透明白底 + 左上角方块」的源图（对照组）
function opaqueWhiteCorner(size, inner, cssColor) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, inner, inner);
  return c;
}
// 微信 storage 的真实行为模拟：读出时过一遍 JSON（Int32Array 会退化成对象）
function jsonLossyWx(store) {
  return {
    getStorageSync: k => (k in store ? JSON.parse(JSON.stringify(store[k])) : ''),
    setStorageSync: (k, v) => { store[k] = v; },
    removeStorageSync: k => { delete store[k]; },
    showToast() {}, showModal() {}, navigateTo() {}, showLoading() {}, hideLoading() {}, vibrateShort() {},
    getWindowInfo: () => ({ pixelRatio: 1 }),
    createOffscreenCanvas: o => createCanvas(o.width, o.height)
  };
}

const pal = loader.getPaletteColors('mard');
const RED = pal.findIndex(c => c.rgb[0] > 200 && c.rgb[1] < 70 && c.rgb[2] < 70);
const BLUE = pal.findIndex(c => c.rgb[2] > 170 && c.rgb[0] < 70);
const RED_RGB = pal[RED] ? pal[RED].rgb : [255, 0, 0];
const BLUE_RGB = pal[BLUE] ? pal[BLUE].rgb : [0, 0, 255];

(async () => {
  console.log('《豆豆工坊A》组 B 回归测试 —— F03 透明语义 / F06 权威网格 / 网格持久化形态');
  console.log('入口：真实 processImage / onShape / onBrand / floodFill / _snapshot（不手工补链路字段）');

  ok('前置：色板里能取到一红一蓝（供形状/换品牌用例使用）', RED >= 0 && BLUE >= 0, { RED: RED, BLUE: BLUE });

  // ============================================================
  await sec('F03-A 透明区真的不拼豆（真实 processImage 全链路）', async () => {
    const { p } = initEditor();
    p.data.w = 10; p.data.h = 10;
    p.brandKey = 'mard';
    const src = transparentCorner(40, 20, '#D80127');   // 左上 20×20 不透明，其余透明
    p.loadImage = async () => src;
    p._moduleAutoTried = true; p._autoTrimmed = true;
    await p.processImage();

    eq('透明区（75 格）标记为不拼', p.grid.filter(v => v === -1).length, 75);
    eq('可见区（25 格）正常拼豆', p.grid.filter(v => v >= 0).length, 25);
    eq('材料清单只有 1 种颜色', Object.keys(p.colorMeta).length, 1);
    eq('材料清单里没有白豆', Object.values(p.colorMeta).some(m => /^#FFFFFF$/i.test(m.hex)), false);
    eq('这一种颜色就是图案色', p.colorMeta[0] && p.colorMeta[0].hex, '#D80127');
    eq('用豆总数不含透明格', p.data.totalCount, 25);
    eq('权威网格 fullGrid 与投影一致（矩形无掩膜）', p.fullGrid.filter(v => v === -1).length, 75);
  });

  // 对照组：不透明白底不能被"顺手去掉"（防止 F03 修过头）
  await sec('F03-A2 对照组：不透明白底仍是正常拼豆', async () => {
    const { p } = initEditor();
    p.data.w = 10; p.data.h = 10;
    const src = opaqueWhiteCorner(40, 20, '#D80127');
    p.loadImage = async () => src;
    p._moduleAutoTried = true; p._autoTrimmed = true;
    await p.processImage();
    eq('不透明白底仍是正常拼豆（没有 -1）', p.grid.filter(v => v === -1).length, 0);
    eq('白底 + 图案共 2 种颜色', Object.keys(p.colorMeta).length, 2);
  });

  // ============================================================
  await sec('F03-B 去白底把近白像素置为透明（adjust 页真实实现）', async () => {
    const { p } = page('adjust');
    const cv = createCanvas(4, 4);
    const actx = cv.getContext('2d');
    actx.fillStyle = '#FFFFFF'; actx.fillRect(0, 0, 4, 4);
    actx.fillStyle = '#D80127'; actx.fillRect(0, 0, 2, 2);
    p.canvas = cv; p.ctx = actx;
    p.applyCutWhite();
    const d = actx.getImageData(0, 0, 4, 4).data;
    eq('红格仍不透明', d[(0 * 4 + 0) * 4 + 3], 255);
    eq('白格 alpha 归零（真的去掉了）', d[(3 * 4 + 3) * 4 + 3], 0);

    // canvas 读回时预乘 alpha 会把全透明像素的 RGB 归零，这是画布行为。
    // 真正要保证的是：这份 alpha=0 的数据进编辑器后会被认成"透明、不拼"。
    const ed = page('editor');
    const probe = ed.p._toPixels(d, 4, 4);
    eq('去白底后的白格被编辑器认成透明', probe.mask[15], 0);
    eq('去白底后的红格仍要拼', probe.mask[0], 1);
  });

  // 静态断言：两条提取路径都不能预填白底（填了就等于把透明抹成 255）
  await sec('F03-B2 提取路径不预填白底（静态断言）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'pages/editor/editor.js'), 'utf8');
    // 只查两条提取路径各自的离屏画布，不误伤诊断自检函数里故意画的红蓝图
    ok('提取路径不再设置白色填充色', src.indexOf("octx.fillStyle = '#FFFFFF'") === -1);
    ok('区域众数采样路径不再预填白底', src.indexOf('octx.fillRect(0, 0, W2, H2)') === -1);
    ok('离屏点采样路径不再预填白底', src.indexOf('octx.fillRect(0, 0, w, h)') === -1);
  });

  // ============================================================
  await sec('F03-C finalize 保留 -1，且不把"不拼"算成白豆', async () => {
    const labels = new Int32Array([RED, RED, -1, -1, -1]);
    const fin = bead.finalize(labels, pal);
    eq('finalize 原样保留 -1', Array.from(fin.labels), [0, 0, -1, -1, -1]);
    eq('finalize 只为真实用色建清单', fin.colors.length, 1);
    eq('用量只算非透明格', fin.colors[0].count, 2);
    eq('颜色下标 0 不再落到"第一个颜色"身上', fin.colors[0].hex, pal[RED].hex);
  });

  // ============================================================
  await sec('F06a 切形状不覆盖手工改动（油漆桶真实入口）', async () => {
    const { p } = initEditor();
    p.setData({ w: 5, h: 5, shape: 'rect', shapeIndex: 0, activeTool: 'fill', activeColorId: 1 });
    p.data.w = 5; p.data.h = 5;
    p.fullGrid = new Array(25).fill(0);
    p.colorMeta = { 0: metaOf(RED_RGB, 'A'), 1: metaOf(BLUE_RGB, 'B') };
    p.locked = {};
    p.grid = p._applyShapeToGrid(5, 5);
    p.cell = 20; p.offX = 0; p.offY = 0;

    // 真实入口：fill 工具点 (0,0)
    p.onTouch({ type: 'touchstart', touches: [{ x: 5, y: 5 }], changedTouches: [] });
    eq('填充后投影全变 1', p.grid.filter(v => v === 1).length, 25);
    eq('填充同时写入了权威网格', p.fullGrid.filter(v => v === 1).length, 25);

    p.onShape({ detail: { value: 1 } });      // 圆形：四角在形状外
    eq('圆形下角落投影为 -1', p.grid[0], -1);
    eq('权威网格仍保留角落的填充结果', p.fullGrid[0], 1);
    eq('切形状不再清空撤销历史', p._undoStack.length > 0, true);

    p.onShape({ detail: { value: 0 } });      // 切回矩形
    eq('切回矩形后填充结果还在（旧版会丢）', p.grid[0], 1);
    eq('切回矩形后四角恢复可见', [p.grid[0], p.grid[4], p.grid[20], p.grid[24]], [1, 1, 1, 1]);
  });

  // ============================================================
  await sec('F06b 换品牌换算的是权威网格，之后切形状不出现 missingColorMeta', async () => {
    const { p } = initEditor();
    p.setData({ w: 5, h: 5, shape: 'rect', shapeIndex: 0 });
    p.data.w = 5; p.data.h = 5;
    p.locked = {};
    // 四角用颜色 1，内部用颜色 0 —— 圆形下颜色 1 完全不可见
    p.fullGrid = new Array(25).fill(0);
    [0, 4, 20, 24].forEach(i => { p.fullGrid[i] = 1; });
    p.colorMeta = { 0: metaOf(RED_RGB, pal[RED].code), 1: metaOf(BLUE_RGB, pal[BLUE].code) };
    p._applyShapeToGrid(5, 5);

    p.onShape({ detail: { value: 1 } });      // 圆形：颜色 1 被藏起来
    eq('圆形下可见网格里没有颜色 1', p.grid.some(v => v === 1), false);
    eq('权威网格仍保留颜色 1', p.fullGrid.some(v => v === 1), true);

    const bi = p.data.brandList.findIndex(b => b.key === 'hama');
    ok('品牌列表里能找到 Hama', bi >= 0, { bi: bi });
    p.onBrand({ detail: { value: bi } });

    let missing = [];
    for (const v of p.fullGrid) if (v >= 0 && !p.colorMeta[v]) missing.push(v);
    eq('换品牌后权威网格每个下标都有颜色元数据', missing, []);

    p.onShape({ detail: { value: 0 } });      // 切回矩形，被藏起来的颜色重新出现
    missing = [];
    for (const v of p.grid) if (v >= 0 && !p.colorMeta[v]) missing.push(v);
    eq('换品牌 + 切形状后不出现 missingColorMeta（旧版必现）', missing, []);

    // 真实绘图：用严格色板，取不到颜色就直接抛错
    let threw = null;
    try {
      render.drawGrid(fakeCtx(), {
        grid: p.grid, w: 5, h: 5, cell: 10, offX: 0, offY: 0,
        colorMeta: strictMeta(p.colorMeta), mode: 'pixel', showCode: true
      });
    } catch (e) { threw = String(e.message); }
    ok('换品牌+切形状后绘图不报 missingColorMeta', threw === null, threw);
  });

  // ============================================================
  await sec('F06c 圆形图纸重开 → 切矩形，绘图不再报 reading rgb（preview 快照 → storage → editor 全链路）', async () => {
    loader.setCurrentBrand('mard');
    const store = {};
    const app = makeApp('mard');

    // ① 编辑器做出一个圆形图纸，四角被形状藏起来
    const e1 = initEditor({ store: store, app: app });
    e1.p.setData({ w: 5, h: 5, shape: 'rect', shapeIndex: 0 });
    e1.p.locked = {};
    e1.p.fullGrid = new Array(25).fill(0);
    [0, 4, 20, 24].forEach(i => { e1.p.fullGrid[i] = 1; });
    e1.p.colorMeta = { 0: metaOf(RED_RGB, pal[RED].code), 1: metaOf(BLUE_RGB, pal[BLUE].code) };
    e1.p.brandKey = 'mard';
    e1.p._applyShapeToGrid(5, 5);
    e1.p.onShape({ detail: { value: 1 } });    // 圆形
    e1.p.goPreview();

    eq('预览拿到的是圆形图纸', app.globalData.project.shape, 'circle');
    eq('预览拿到全量 colorMeta（2 色）', Object.keys(app.globalData.project.colorMeta).length, 2);

    // ② 预览页保存到历史（走 _snapshot + storage.addProject）
    const pv = page('preview', { store: store, app: app });
    pv.p.onLoad();
    eq('预览面板只列可见颜色（1 色）', pv.p.data.palettePanel.length, 1);
    pv.p.saveHistory();
    const recId = app.globalData.project.recId;
    ok('已写入历史并拿到记录 id', !!recId, recId);

    const saved = clone(store.history[0]);
    eq('落库记录带全量 colorMeta（2 色）', Object.keys(saved.colorMeta || {}).length, 2);
    eq('落库的 grid 长度正确', saved.grid.length, 25);

    // ③ 重新打开这张历史记录，切回矩形
    const e2 = initEditor({ store: store, app: app }, { id: recId });
    eq('重开后恢复出全量 colorMeta（不是只有可见色）', Object.keys(e2.p.colorMeta).length, 2);
    e2.p.onShape({ detail: { value: 0 } });

    let threw = null;
    try {
      render.drawGrid(fakeCtx(), {
        grid: e2.p.grid, w: 5, h: 5, cell: 10, offX: 0, offY: 0,
        colorMeta: strictMeta(e2.p.colorMeta), mode: 'pixel', showCode: true
      });
    } catch (e) { threw = String(e.message); }
    ok('圆形图纸重开切矩形：绘图不再报 reading rgb（旧版必崩）', threw === null, threw);
    eq('四角重新出现且颜色正确', e2.p.grid[0], 1);
  });

  // ============================================================
  await sec('网格持久化形态：Int32Array 经微信 storage 的 JSON 序列化不再丢数据', async () => {
    const raw = new Int32Array([1, 2, 3]);
    ok('前提确认：Int32Array 过一遍 JSON 就没有 length 了',
      JSON.parse(JSON.stringify(raw)).length === undefined, JSON.parse(JSON.stringify(raw)));

    const store = {};
    global.wx = jsonLossyWx(store);

    // 历史记录
    const arr = new Int32Array(25);
    for (let i = 0; i < 25; i++) arr[i] = i % 3 === 0 ? -1 : (i % 2);
    const full = new Int32Array(25);
    for (let i = 0; i < 25; i++) full[i] = i % 2;
    const rec = storage.addProject({ name: 'T', w: 5, h: 5, grid: arr, fullGrid: full, colors: [] });
    ok('写入历史成功', !!rec, rec);
    const back = storage.getProject(rec.id);
    ok('读回后 grid 仍是数组（不是退化对象）', Array.isArray(back.grid), typeof back.grid);
    eq('grid 长度完整', back.grid.length, 25);
    eq('grid 内容完整', back.grid, Array.from(arr));
    ok('fullGrid 同样被归一化', Array.isArray(back.fullGrid) && back.fullGrid.length === 25);

    // 历史里塞一条"已被写坏"的老记录，读的时候要能自愈
    store.history.push({ id: 'broken', w: 2, h: 2, grid: { 0: 1, 1: 1, 2: 0, 3: 0 }, colors: [] });
    const healed = storage.getProject('broken');
    ok('老数据里退化成对象的 grid 被自愈成数组', Array.isArray(healed.grid), typeof healed.grid);
    eq('自愈后的内容正确', healed.grid, [1, 1, 0, 0]);

    // 草稿
    storage.saveDraft({ recId: '', w: 5, h: 5, grid: arr, fullGrid: full, colorMeta: { 0: metaOf([1, 2, 3], 'X') } });
    const draft = storage.getDraft();
    ok('草稿能读回（旧版因 grid 无 length 被静默丢弃）', !!draft, draft && typeof draft.grid);
    eq('草稿 grid 长度完整', draft && draft.grid.length, 25);
    ok('草稿 fullGrid 同样被归一化', !!draft.fullGrid && Array.isArray(draft.fullGrid) && draft.fullGrid.length === 25);

    // 局部更新（只带 thumb）不能把 grid 清掉
    storage.updateProject(rec.id, { thumb: 'x.png' });
    const after = storage.getProject(rec.id);
    eq('局部更新后 grid 长度不变', after.grid.length, 25);
    eq('局部更新后 grid 内容不变', after.grid, Array.from(arr));
    eq('thumb 已写入', after.thumb, 'x.png');
  });

  // ============================================================
  await sec('编辑器从历史恢复：网格形态兜底（旧数据不抛类型错误）', async () => {
    const store = {};
    const app = makeApp('mard');
    // 直接塞一条 grid 为退化对象的记录
    store.history = [{ id: 'old1', w: 2, h: 2, grid: { 0: 0, 1: 0, 2: 1, 3: 1 }, colors: [] }];
    global.wx = jsonLossyWx(store);
    const env = page('editor', { store: store, app: app });
    env.p.renderGrid = () => {};
    env.p.computeCell = () => {};
    let threw = null;
    try { env.p.onLoad({ id: 'old1' }); } catch (e) { threw = String(e.message); }
    ok('打开网格形态退化的老记录不再抛错', threw === null, threw);
    eq('恢复出的网格内容正确', env.p.grid, [0, 0, 1, 1]);
  });

  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})();
