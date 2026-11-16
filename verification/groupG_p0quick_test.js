'use strict';
// verification/groupG_p0quick_test.js
//
// 组 G（第一批 P0 快赢：全局 loading / 锁文案 / 上传取消，2026-10-12）回归测试。
// 对应界面审计报告 #1 #3 #12（报告：豆豆工坊A-界面与体验审计报告-2026-10-12.md）。
//
// 验的都是「用户点了之后界面有没有话说」：
//   G1 编辑器生成图纸 = 秒级重操作 → loading 全程挂着，抛错也必须收（不能把用户关在小黑屋）；
//      锁定/解锁给触觉反馈（vibrateShort）。
//   G2 预览页单张导出 → 生成+存相册期间 loading，成功后 toast。
//   G3 打印逐页导出 → loading 文案当进度条；**用户中途取消存图必须停下序列并收 loading**
//      （旧代码取消后直接 return，序列卡死、loading 永远挂在屏幕上）。
//   G4 首页选图：用户取消是正常操作不能当异常抛；检测进行中重复点击要被互斥挡掉。
//
// 断言原则（承袭组 E/F）：走真实页面入口；wx 桩记录调用；本文件在修复前的代码上必须 FAIL。
//
// 用法：
//   NODE_PATH=<node_modules> node verification/groupG_p0quick_test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..');
const requireSrc = createRequire(path.join(ROOT, 'app.js'));
const loader = requireSrc('./utils/paletteLoader.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '   → ' + JSON.stringify(detail) : '')); }
}
async function sec(title, fn) {
  console.log('\n=== ' + title + ' ===');
  try { await fn(); }
  catch (e) { fail++; console.log('  FAIL [本节异常中断] ' + title + ' → ' + (e && e.message ? e.message : String(e))); }
}
const clone = x => JSON.parse(JSON.stringify(x));
const silent = { log() {}, error() {}, warn() {} };
const readFile = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 通用页面加载器（同组 F 的桩形制），额外记录 loading/toast/vibrate 调用
function page(name, options) {
  options = options || {};
  let def;
  const store = options.store || {};
  const app = options.app || {
    globalData: { prefs: { brand: 'mard', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} }, project: null },
    savePrefs() {}, setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
  };
  const rec = options.rec || { loading: [], hidden: 0, toasts: [], vibrates: [], picks: 0, exports: [], saves: [] };
  const wx = Object.assign({
    getStorageSync: k => (store[k] ? clone(store[k]) : ''),
    setStorageSync: (k, v) => { store[k] = clone(v); },
    removeStorageSync: k => { delete store[k]; },
    showToast(o) { rec.toasts.push(o && o.title); },
    showModal() {}, navigateTo() {}, navigateBack() {},
    showLoading(o) { rec.loading.push(o); },
    hideLoading() { rec.hidden++; },
    vibrateShort(o) { rec.vibrates.push(o); },
    setClipboardData() {},
    getWindowInfo: () => ({ pixelRatio: 1, windowWidth: 375, windowHeight: 800 }),
    createOffscreenCanvas(o) { return createCanvas(o.width, o.height); },
    canvasToTempFilePath(o) { rec.exports.push(1); if (o.success) o.success({ tempFilePath: '/tmp/g-' + rec.exports.length + '.png' }); },
    saveImageToPhotosAlbum(o) {
      rec.saves.push(1);
      const mode = options.saveMode ? options.saveMode(rec.saves.length) : 'ok';
      if (mode === 'ok') { if (o.success) o.success(); }
      else if (o.fail) o.fail({ errMsg: mode });
    }
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
  return { p: def, app, wx, store, rec };
}

function previewPage(rec, saveMode) {
  const colors = loader.getPaletteColors('mard').slice(0, 3);
  const colorMeta = {};
  colors.forEach((c, i) => { colorMeta[i] = { rgb: c.rgb, code: c.code, short: c.short || c.code, name: c.name || c.code, hex: c.hex }; });
  const e = page('preview', { rec: rec, saveMode: saveMode });
  e.app.globalData.project = {
    w: 10, h: 10, brand: 'mard', shape: 'rect',
    grid: Array.from({ length: 100 }, (_, i) => i % colors.length),
    colorMeta: colorMeta
  };
  e.p.onLoad();
  return e;
}

(async () => {

  // ---------- G1：编辑器生成图纸的 loading 生命周期 + 锁定震动 ----------
  await sec('G1 编辑器：processImage 全程挂 loading（抛错也收）+ 锁定震动', async () => {
    const e = page('editor');
    const p = e.p;

    // 正常完成：showLoading 恰好 1 次（带遮罩），hideLoading 恰好 1 次
    p._processImageCore = async () => {};
    await p.processImage();
    ok('生成开始挂 loading', e.rec.loading.length === 1, e.rec.loading);
    ok('loading 带遮罩防连点', e.rec.loading[0] && e.rec.loading[0].mask === true, e.rec.loading[0]);
    ok('生成结束收 loading', e.rec.hidden === 1, e.rec.hidden);

    // 核心抛错：loading 也必须收掉，不能把用户关在小黑屋
    p._processImageCore = async () => { throw new Error('boom'); };
    let threw = false;
    try { await p.processImage(); } catch (err) { threw = true; }
    ok('核心抛错时异常仍向外抛（不吞）', threw);
    ok('抛错后 loading 也被收掉', e.rec.hidden === 2, e.rec.hidden);

    // 并发重入（改尺寸连点）：多个任务共享一个 loading，最后一个结束才收
    p._processImageCore = () => new Promise(r => setTimeout(r, 5));
    const baseLoad = e.rec.loading.length, baseHide = e.rec.hidden;
    const a = p.processImage(); const b = p.processImage();
    ok('并发重入只新增一个 loading', e.rec.loading.length === baseLoad + 1 && e.rec.hidden === baseHide,
      { loading: e.rec.loading.length, hidden: e.rec.hidden });
    await Promise.all([a, b]);
    ok('并发全部结束后才收 loading', e.rec.hidden === baseHide + 1, e.rec.hidden);

    // 锁定/解锁给触觉反馈
    p.recomputeColors = () => {};
    p.locked = {};
    p.toggleLock({ currentTarget: { dataset: { id: '3' } } });
    ok('锁定操作触发震动反馈', e.rec.vibrates.length === 1, e.rec.vibrates);
    ok('锁定状态确实翻转', p.locked[3] === true, p.locked);
  });

  // ---------- G2：预览页单张导出的 loading ----------
  await sec('G2 预览：单张导出挂 loading，存完收掉并提示', async () => {
    const e = previewPage({ loading: [], hidden: 0, toasts: [], vibrates: [], exports: [], saves: [] });
    await e.p.exportImage();
    ok('导出期间挂 loading', e.rec.loading.length === 1, e.rec.loading.length);
    ok('存图完成收 loading', e.rec.hidden === 1, e.rec.hidden);
    ok('成功后有 toast 提示', (e.rec.toasts[0] || '').indexOf('已保存') >= 0, e.rec.toasts);
  });

  // ---------- G3：打印逐页导出——进度文案 + 中途取消必须停 ----------
  await sec('G3 预览：打印序列 loading 当进度条，取消即停不挂死', async () => {
    const rec = { loading: [], hidden: 0, toasts: [], vibrates: [], exports: [], saves: [] };
    // 第 1 张存成功、第 2 张用户点取消
    const e = previewPage(rec, n => (n >= 2 ? 'saveImageToPhotosAlbum:fail cancel' : 'ok'));
    // 生成器桩：只验序列调度，不真画 2 张 A4
    e.p._buildPrintPage = () => e.wx.createOffscreenCanvas({ width: 8, height: 8 });
    e.p._buildBomPage = () => e.wx.createOffscreenCanvas({ width: 8, height: 8 });
    const lay = { totalPages: 2, pageCount: 1, pagesX: 1, pagesY: 1 };
    e.p._renderPrintPage(lay, 0);
    await new Promise(r => setImmediate(() => setImmediate(r)));

    ok('每一页都刷新 loading 文案', rec.loading.length === 2, rec.loading.map(o => o.title));
    ok('第 2 页文案带进度', (rec.loading[1] && rec.loading[1].title).indexOf('2/2') >= 0, rec.loading[1]);
    ok('取消后 loading 被收掉（不挂死）', rec.hidden >= 1, rec.hidden);
    ok('取消后有序列终止提示', (rec.toasts.some(t => (t || '').indexOf('已取消') >= 0)) === true, rec.toasts);
    ok('提示里带剩余张数', (rec.toasts.some(t => (t || '').indexOf('还剩 1 张') >= 0)) === true, rec.toasts);
    ok('取消后不再生成后面的页', rec.exports.length === 2 && rec.saves.length === 2,
      { exports: rec.exports.length, saves: rec.saves.length });
  });

  // ---------- G4：首页选图——取消不抛异常 + 检测中互斥 ----------
  await sec('G4 首页：选图取消静默返回，检测中重复点击被挡', async () => {
    // a) 用户取消：promise reject cancel → 返回空串，不抛
    const e1 = page('index', { wx: { chooseMedia: () => Promise.reject({ errMsg: 'chooseMedia:fail cancel' }) } });
    let r = '';
    let threw = false;
    try { r = await e1.p._pickAndCheck({ sourceType: ['album'] }); } catch (err) { threw = true; }
    ok('取消选图不抛未捕获异常', threw === false);
    ok('取消选图返回空串', r === '', r);

    // b) 真失败：给出 toast，同样不抛
    const e2 = page('index', { wx: { chooseMedia: () => Promise.reject({ errMsg: 'chooseMedia:fail xxx' }) } });
    r = ''; threw = false;
    try { r = await e2.p._pickAndCheck({ sourceType: ['album'] }); } catch (err) { threw = true; }
    ok('选图异常也不抛', threw === false);
    ok('选图异常有 toast 提示', (e2.rec.toasts[0] || '').indexOf('选图失败') >= 0, e2.rec.toasts);

    // c) 检测进行中再点一次：互斥生效，不会叠出第二个选图框
    const e3 = page('index', {});
    let picks = 0, release = null;
    e3.wx.chooseMedia = () => new Promise(res => { picks++; release = res; });
    const first = e3.p._pickAndCheck({ sourceType: ['album'] });
    const second = await e3.p._pickAndCheck({ sourceType: ['album'] });
    ok('检测中重复点击被互斥挡掉', second === '' && picks === 1, { second: second, picks: picks });
    release({ tempFiles: [{ tempFilePath: '/tmp/g-pick.png' }] });
    r = await first;
    ok('放行后正常返回图片路径', r === '/tmp/g-pick.png', r);
  });

  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})();
