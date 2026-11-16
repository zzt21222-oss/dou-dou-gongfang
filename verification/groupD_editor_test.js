'use strict';
// verification/groupD_editor_test.js
//
// 组 D（第三方**修复复核**报告 R1 / R2）回归测试。
//
// 这两项都是组 B「权威网格模型」重构引入的**新增回归**，基线 a1328ae 上不存在：
//
//   R1 圆形外侧填充陷入死循环（编辑器卡死）
//      floodFill 用 `grid[i] !== old` 判断「访问过没有」，可 grid 只是形状投影，
//      形状外的格子经 _setCell 写过之后**投影仍然恒为 -1**。起点 old 也是 -1，
//      于是两个相邻外格不断把彼此重新入栈 —— 算法不终止，_stroke 还会无限增长。
//      基线版本直接写 grid，格子真的变了，所以能停下来。
//
//   R2 在形状外画笔后撤销，会删除隐藏层颜色（静默数据丢失）
//      _recordCell 从**投影** grid 取旧值（形状外恒为 -1），却把修改写进 fullGrid；
//      撤销时又把这个 -1 写回 fullGrid —— 实测 0 → 1 → -1，切回矩形那格就没了。
//
// 本文件同时是这两项的**鉴别力**证明：在修复前的代码上必须失败。
//
// 用法：
//   NODE_PATH=<node_modules> node verification/groupD_editor_test.js
// 依赖 @napi-rs/canvas（页面桩用真画布，editing 逻辑本身不依赖画布）。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..');
const requireSrc = createRequire(path.join(ROOT, 'app.js'));
const loader = requireSrc('./utils/paletteLoader.js');
const bead = requireSrc('./utils/bead.js');

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

function makeApp() {
  return {
    globalData: { prefs: { brand: 'mard', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} }, project: null },
    savePrefs() {},
    setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
  };
}
// 用 vm.createContext 显式建上下文，这样才能用 runInContext 的 timeout 守卫
// 抓住「死循环」——直接调 p.onTouch 会把整个测试进程挂住。
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
  const sandbox = {
    require: createRequire(filename), getApp: () => app, Page: d => { def = d; }, wx,
    console: silent, setTimeout, clearTimeout, setImmediate,
    Uint8ClampedArray, Uint8Array, Int8Array, Int32Array, Map, Set,
    Object, Array, JSON, Math, Date, String, Number, Boolean, Promise, Error
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  def.data = clone(def.data);
  def.setData = function (p, cb) { Object.assign(this.data, p); if (cb) cb(); };
  // 把页面实例挂到上下文上，供 guarded() 在 VM 里以 `p` 引用
  // （事件处理器必须在 VM 内执行，才能被 runInContext 的 timeout 守卫住）
  sandbox.p = def;
  return { p: def, app, wx, store, context };
}
// 在上下文中执行一段代码，超时就判定为「未终止」
function guarded(env, code, ms) {
  try { vm.runInContext(code, env.context, { timeout: ms || 120 }); return null; }
  catch (e) { return e; }
}
const tap = (env, idx, ms) =>
  guarded(env, "p.onTouch({type:'touchstart',touches:[{x:" + px(env, idx) + ",y:" + py(env, idx) +
    "}],changedTouches:[]})", ms);
const lift = (env, ms) =>
  guarded(env, "p.onTouch({type:'touchend',touches:[],changedTouches:[]})", ms || 60);
function px(env, idx) { const w = env.p.data.w; return (idx % w) * env.p.cell + env.p.cell / 2; }
function py(env, idx) { const w = env.p.data.w; return Math.floor(idx / w) * env.p.cell + env.p.cell / 2; }

function metaOf(rgb, code) {
  return {
    rgb: rgb, code: code, short: code, name: code,
    hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  };
}
const RED = [216, 1, 39], BLUE = [0, 0, 255], GREEN = [0, 160, 80];

// 建一个形状作品：fullGrid 权威、grid 是投影，与真实 onLoad 之后的状态一致
function setup(size, shape) {
  const env = page('editor');
  const p = env.p;
  const shapeIndex = Math.max(0, ['rect', 'circle', 'hexagon'].indexOf(shape));
  p.setData({ w: size, h: size, shape: shape, shapeIndex: shapeIndex, activeTool: 'fill', activeColorId: 1 });
  p.cell = 10; p.offX = 0; p.offY = 0;
  p.fullGrid = new Array(size * size).fill(0);
  p.colorMeta = { 0: metaOf(RED, 'A'), 1: metaOf(BLUE, 'B'), 2: metaOf(GREEN, 'C') };
  p.locked = {};
  p._undoStack = []; p._redoStack = []; p._stroke = null; p._dirty = false;
  p.renderGrid = () => {}; p.renderCell = () => {}; p.computeCell = () => {};
  p._applyShapeToGrid(size, size);
  return env;
}
const outsideIdx = p => { const a = []; for (let i = 0; i < p._shapeMask.length; i++) if (p._shapeMask[i] < 0) a.push(i); return a; };
const insideIdx = p => { const a = []; for (let i = 0; i < p._shapeMask.length; i++) if (p._shapeMask[i] >= 0) a.push(i); return a; };

(async () => {
  console.log('《豆豆工坊A》组 D 回归测试 —— 复核报告 R1（填充死循环）/ R2（撤销删隐藏颜色）');
  console.log('入口：真实 onTouch → applyTool → floodFill / _recordCell → undo / redo → onShape');

  // ============================================================
  await sec('R1a 形状外点击填充：必须在有限时间内结束，且一格都不写', async () => {
    for (const shape of ['circle', 'hexagon']) {
      const env = setup(10, shape);
      const p = env.p;
      p.setData({ activeTool: 'fill', activeColorId: 1 });
      const outs = outsideIdx(p);
      ok(shape + ' 形状外格子存在（前提成立）', outs.length > 0, outs.length);
      const target = outs[0];
      const beforeFull = p.fullGrid.slice(), beforeGrid = Array.from(p.grid);

      const err = tap(env, target, 120);
      ok(shape + ' 形状外填充 120ms 内结束（死循环已消除）', err === null, err && err.message);
      eq(shape + ' 权威网格零改动', p.fullGrid.slice(), beforeFull);
      eq(shape + ' 投影零改动', Array.from(p.grid), beforeGrid);
      eq(shape + ' 没有产生撤销记录', p._undoStack.length, 0);
    }
  });

  // ============================================================
  await sec('R1b 形状内空白填充：正常铺满，且不越出制作范围', async () => {
    const env = setup(10, 'circle');
    const p = env.p;
    const ins = insideIdx(p), outs = outsideIdx(p);
    const err = tap(env, 55, 200);
    ok('圆形内部填充 200ms 内结束', err === null, err && err.message);
    eq('圆内每一格都填成新色', ins.every(i => p.fullGrid[i] === 1), true);
    eq('圆外一格都没被写', outs.every(i => p.fullGrid[i] === 0), true);
  });

  // ============================================================
  await sec('R1c 形状内透明洞与外部相连：终止，且只补洞不越界', async () => {
    const env = setup(10, 'circle');
    const p = env.p;
    // 找「圆内、但四邻里存在圆外」的格子 —— 正是报告点名的边界情形
    const mask = p._shapeMask;
    let edge = -1;
    for (let i = 0; i < mask.length && edge < 0; i++) {
      if (mask[i] < 0) continue;
      const x = i % 10, y = (i - x) / 10;
      const nb = [];
      if (x > 0) nb.push(i - 1);
      if (x < 9) nb.push(i + 1);
      if (y > 0) nb.push(i - 10);
      if (y < 9) nb.push(i + 10);
      if (nb.some(j => mask[j] < 0)) edge = i;
    }
    ok('找到「紧邻圆外的圆内格」（前提成立）', edge >= 0, edge);

    // 把它擦除成透明洞（投影同为 -1），这是最容易触发死循环的形态
    p.fullGrid[edge] = -1;
    p._applyShapeToGrid(10, 10);
    eq('该格投影确实为 -1（与形状外同值）', p.grid[edge], -1);
    const outs = outsideIdx(p);
    const beforeOutFull = outs.map(i => p.fullGrid[i]);

    p.setData({ activeColorId: 2 });
    const err = tap(env, edge, 200);
    ok('从透明洞填充 200ms 内结束', err === null, err && err.message);
    eq('洞被补上新色', p.fullGrid[edge], 2);
    eq('圆外一格都没被写', outs.map(i => p.fullGrid[i]), beforeOutFull);
  });

  // ============================================================
  await sec('R1d 锁定颜色边界仍然有效', async () => {
    const env = setup(10, 'circle');
    const p = env.p;
    p.locked = { 0: true };
    const before = p.fullGrid.slice();
    const err = tap(env, 55, 120);
    ok('锁定后填充在 120ms 内结束', err === null, err && err.message);
    eq('锁定颜色未被填充覆盖', p.fullGrid.slice(), before);
  });

  // ============================================================
  await sec('R2a 形状外画笔后撤销：隐藏层的原值必须回来（0 → 1 → 0）', async () => {
    const env = setup(10, 'circle');
    const p = env.p;
    const target = outsideIdx(p)[0];
    p.setData({ activeTool: 'brush', activeColorId: 1 });
    eq('前提：该格在投影里被隐藏', p.grid[target], -1);
    const before = p.fullGrid[target];
    eq('前提：隐藏层原本有颜色 0', before, 0);

    tap(env, target, 60); lift(env);
    eq('画笔写入权威网格', p.fullGrid[target], 1);
    p.undo();
    eq('撤销后权威网格回到 0（修复前会被写成 -1）', p.fullGrid[target], before);
    p.redo();
    eq('重做后又回到 1', p.fullGrid[target], 1);
    p.undo();
    eq('再次撤销回到 0', p.fullGrid[target], before);
  });

  // ============================================================
  await sec('R2b 形状外橡皮 / 换色：撤销同样恢复权威网格原值', async () => {
    const env = setup(10, 'circle');
    const p = env.p;
    const target = outsideIdx(p)[0];
    // 隐藏层里本来有颜色 1
    p.fullGrid[target] = 1;
    p._applyShapeToGrid(10, 10);

    p.setData({ activeTool: 'eraser' });
    tap(env, target, 60); lift(env);
    eq('擦除后权威网格为 -1', p.fullGrid[target], -1);
    p.undo();
    eq('撤销恢复为 1（修复前 from 取自投影 -1，撤销把它写回 -1）', p.fullGrid[target], 1);

    p.setData({ activeTool: 'recolor', activeColorId: 2 });
    tap(env, target, 60); lift(env);
    eq('换色后权威网格为 2', p.fullGrid[target], 2);
    p.undo();
    eq('撤销恢复为 1', p.fullGrid[target], 1);
  });

  // ============================================================
  await sec('R2c 画笔横扫穿过形状边界：撤销/重做逐格一致，切回矩形不丢', async () => {
    const env = setup(10, 'circle');
    const p = env.p;
    p.setData({ activeTool: 'brush', activeColorId: 2 });
    for (let x = 0; x < 10; x++) { tap(env, x, 60); lift(env); }   // 第 0 行整行扫过

    const afterBrush = p.fullGrid.slice();
    ok('确实画进去了颜色 2', afterBrush.filter(v => v === 2).length > 0, afterBrush.filter(v => v === 2).length);
    ok('形状外那几格也被写进权威网格', outsideIdx(p).some(i => p.fullGrid[i] === 2), true);

    // 每一格是一笔（各自 tap + 抬笔），所以撤销单位是「一格」：必须全部撤销再比
    const strokes = p._undoStack.length;
    eq('每次落笔各自记成一笔', strokes, 10);
    for (let k = 0; k < strokes; k++) p.undo();
    eq('全部撤销后权威网格逐格回到画笔前', p.fullGrid.slice(), new Array(100).fill(0));
    for (let k = 0; k < strokes; k++) p.redo();
    eq('全部重做后与撤销前逐格一致', p.fullGrid.slice(), afterBrush);

    p.onShape({ detail: { value: 0 } });        // 切回矩形
    eq('切回矩形后投影 == 权威网格（形状外不再残留 -1）', Array.from(p.grid), p.fullGrid.slice());
  });

  // ============================================================
  await sec('R2d 多项工具混合后撤销到起点：权威网格必须完全复原', async () => {
    const env = setup(10, 'circle');
    const p = env.p;
    const outs = outsideIdx(p), ins = insideIdx(p);
    const actions = [
      { tool: 'brush', color: 1, idx: outs[0] },
      { tool: 'brush', color: 2, idx: ins[0] },
      { tool: 'eraser', color: 0, idx: ins[ins.length - 1] },
      { tool: 'brush', color: 1, idx: outs[outs.length - 1] }
    ];
    actions.forEach(a => { p.setData({ activeTool: a.tool, activeColorId: a.color }); tap(env, a.idx, 60); lift(env); });
    eq('四步操作都记进了撤销栈', p._undoStack.length, actions.length);
    while (p._undoStack.length) p.undo();
    eq('全部撤销后权威网格逐格复原', p.fullGrid.slice(), new Array(100).fill(0));
  });

  // ============================================================
  await sec('R1/R2 静态标记：终止性与同源旧值都在代码里，旧写法已消失', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'pages/editor/editor.js'), 'utf8');
    ok('存在 _isOutside 判定（区分「形状外」与「擦除后的 -1」）', src.indexOf('_isOutside(idx)') >= 0, true);
    ok('填充引入了 visited 表（终止性保证）', src.indexOf('const visited = new Uint8Array(w * h)') >= 0, true);
    ok('_recordCell 从权威网格取旧值', src.indexOf('const src = (this.fullGrid && idx < this.fullGrid.length)') >= 0, true);
    ok('旧写法「从投影取旧值」已消失', src.indexOf('const old = this.grid[idx];') < 0, true);
    ok('旧的「按颜色相等判访问」邻居入栈已消失', src.indexOf('stack.push([cx + 1, cy]') < 0, true);
    ok('填充已显式排除制作范围外', src.indexOf('!this._isOutside(i - 1)') >= 0, true);
  });

  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})();
