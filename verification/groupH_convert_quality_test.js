'use strict';
// verification/groupH_convert_quality_test.js
//
// 组 H（转换质量：自动裁剪误伤 / 照片五官被合并，2026-10-12）回归测试。
// 对应用户实测反馈：① Claude logo 转出来丢字母；② 证件照转出来脸没细节。
//
// 两个根因（都在 _detectContentBBox / 降色合并链上，已离线复现）：
//   R-A 只保留「最大连通块」会把与主体断开的部件当噪点整块丢掉
//       （实测：合成 logo 的星号被吃；用户图里是字母 e 断开被吃）。
//   R-B 背景亮度门槛 120 太宽：蓝色证件照背景(lum≈125)擦边过关，
//       整块蓝底被当背景裁掉（内容只剩原图 15%）；且照片类图片被
//       consolidateColors(0.6%) 把五官特征色并进皮肤主色（最终只剩 5 色）。
//
// 修法：背景须低饱和浅色(lum≥200 且 rng≤40)；保留面积≥max(6,最大块2%)的连通块；
//       裁后面积<30% 直接放弃；照片类(nonWhite≥30%)合并门槛降为 minBeads 3 / 0.2%。
//
// 断言原则：走真实管线（_processImageCore 全程），本文件在修复前的代码上必须 FAIL。
//
// 用法：
//   NODE_PATH=<node_modules> node verification/groupH_convert_quality_test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
try { GlobalFonts.registerFromPath('/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf', 'serif'); } catch (e) { /* 无就用默认字体 */ }
try { GlobalFonts.registerFromPath('/System/Library/Fonts/STHeiti Light.ttc', 'sans-serif'); } catch (e) { /* 忽略 */ }

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
const silent = { log() {}, warn() {}, error() {} };

// —— 编辑器页桩（真实 editor.js，渲染方法打桩，数据链路全真）——
function editorPage() {
  let def;
  const store = {};
  const app = {
    globalData: { prefs: { brand: 'perler', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} }, project: null },
    savePrefs() {}, setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
  };
  const wx = {
    getStorageSync: k => (store[k] ? clone(store[k]) : ''),
    setStorageSync: (k, v) => { store[k] = clone(v); },
    removeStorageSync: k => { delete store[k]; },
    showToast() {}, showModal() {}, navigateTo() {}, navigateBack() {},
    showLoading() {}, hideLoading() {}, vibrateShort() {}, setClipboardData() {},
    getWindowInfo: () => ({ pixelRatio: 1, windowWidth: 375, windowHeight: 800 }),
    createOffscreenCanvas(o) { return createCanvas(o.width, o.height); },
    canvasToTempFilePath() {}, saveImageToPhotosAlbum() {}
  };
  global.wx = wx;
  const filename = path.join(ROOT, 'pages', 'editor', 'editor.js');
  const context = vm.createContext({
    require: createRequire(filename), getApp: () => app, Page: d => { def = d; }, wx,
    console: silent, setTimeout, clearTimeout, setImmediate,
    Uint8ClampedArray, Uint8Array, Int8Array, Int32Array, Map, Set,
    Object, Array, JSON, Math, Date, String, Number, Boolean, Promise, Error
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  def.data = clone(def.data);
  def.setData = function (patch, cb) { Object.assign(this.data, patch); if (cb) cb(); };
  def.renderGrid = () => {}; def.renderCell = () => {}; def.computeCell = () => {};
  return def;
}

// —— 合成测试图 ——
// logo：白底 1200×300，珊瑚色星号（与文字不连通）+ 黑色 "Claude"（宽衬线，e 在最右）
function makeLogo() {
  const c = createCanvas(1200, 300), x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 1200, 300);
  x.strokeStyle = '#D97757'; x.lineWidth = 22; x.lineCap = 'round';
  const cx = 140, cy = 150, R = 95;
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 6;
    x.beginPath(); x.moveTo(cx - Math.cos(a) * R, cy - Math.sin(a) * R);
    x.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); x.stroke();
  }
  x.fillStyle = '#111111';
  x.font = 'bold 200px serif';
  x.textBaseline = 'middle';
  x.fillText('Claude', 290, 158);
  return c.toBuffer('image/png');
}
// 证件照：蓝底 295×413，脸/发/西装/衬衫 + 低占比特征色（眉/眼/鼻影/嘴）
function makeIdPhoto() {
  const W = 295, H = 413, c = createCanvas(W, H), x = c.getContext('2d');
  x.fillStyle = '#4A89C7'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#1e2a3a';
  x.beginPath(); x.moveTo(30, H); x.lineTo(70, 320); x.lineTo(W / 2, 360); x.lineTo(W - 70, 320); x.lineTo(W - 30, H); x.fill();
  x.fillStyle = '#f2f4f6';
  x.beginPath(); x.moveTo(W / 2 - 34, 330); x.lineTo(W / 2, 405); x.lineTo(W / 2 + 34, 330); x.closePath(); x.fill();
  x.fillStyle = '#e8b58c'; x.fillRect(W / 2 - 30, 268, 60, 70);
  x.fillStyle = '#eec39a';
  x.beginPath(); x.ellipse(W / 2, 205, 78, 95, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = 'rgba(200,140,100,0.35)';
  x.beginPath(); x.ellipse(W / 2, 225, 12, 18, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = 'rgba(220,120,110,0.5)';
  x.beginPath(); x.ellipse(W / 2, 258, 22, 8, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#3a2a20';
  x.fillRect(W / 2 - 52, 178, 36, 8); x.fillRect(W / 2 + 16, 178, 36, 8);
  x.fillStyle = '#26170f';
  x.beginPath(); x.ellipse(W / 2 - 34, 200, 14, 8, 0, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.ellipse(W / 2 + 34, 200, 14, 8, 0, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#171717';
  x.beginPath(); x.ellipse(W / 2, 140, 88, 62, 0, Math.PI, 0); x.fill();
  x.fillRect(W / 2 - 88, 138, 20, 60); x.fillRect(W / 2 + 68, 138, 20, 60);
  return c.toBuffer('image/png');
}

function hexLum(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return -1;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// 灰白照片底 logo（#b8b8b8，lum≈184）：照片里带阴影的白底真实亮度常在 170~200。
// 2026-10-12 第一版把亮度门槛卡到 200 会拒裁（logo 只占网格一半、字母糊成几格）。
function makeGreyLogo() {
  const c = createCanvas(1000, 1000), x = c.getContext('2d');
  x.fillStyle = '#b8b8b8'; x.fillRect(0, 0, 1000, 1000);
  x.strokeStyle = '#D97757'; x.lineWidth = 18; x.lineCap = 'round';
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 6;
    x.beginPath(); x.moveTo(150 - Math.cos(a) * 70, 500 - Math.sin(a) * 70);
    x.lineTo(150 + Math.cos(a) * 70, 500 + Math.sin(a) * 70); x.stroke();
  }
  x.fillStyle = '#111111'; x.font = 'bold 150px serif'; x.textBaseline = 'middle';
  x.fillText('Claude', 270, 505);
  return c.toBuffer('image/png');
}
// 二维码式黑白模块图（ss=2 路径）：低对比拉伸与平滑改动不得破坏黑白两色
function makeQR() {
  const N = 21, M = 14, S = N * M;
  const c = createCanvas(S, S), x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, S, S);
  x.fillStyle = '#111111';
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let my = 0; my < N; my++) for (let mx = 0; mx < N; mx++) {
    const finder = (mx < 7 && my < 7) || (mx >= N - 7 && my < 7) || (mx < 7 && my >= N - 7);
    const on = finder
      ? (mx % 6 === 0) || (my % 6 === 0) || ((mx % 6 >= 2) && (mx % 6 <= 4) && (my % 6 >= 2) && (my % 6 <= 4))
      : rnd() > 0.5;
    if (on) x.fillRect(mx * M, my * M, M, M);
  }
  return c.toBuffer('image/png');
}

async function runPipeline(img, w, h) {
  const p = editorPage();
  p._moduleAutoTried = true;         // 跳过模块周期自动检测（本组只验裁剪与降色）
  p.loadImage = async () => img;     // 源图注入：其余链路全真
  p.src = 'groupH-test';
  p.data.w = w; p.data.h = h;
  await p._processImageCore();
  return p;
}

(async () => {

  // ---------- H1：logo 部件不被整块丢弃 ----------
  await sec('H1 logo：星号与末尾字母都必须活下来', async () => {
    const img = await loadImage(makeLogo());
    const p0 = editorPage();
    // 直接验包围盒：星号在源图 x≈45..235，字母从 290 起。
    // 修复前「只留最大连通块」会把与文字断开的星号整块丢掉 → bbox.sx ≈ 292。
    const bbox = p0._detectContentBBox(img);
    ok('包围盒包含星号（bbox.sx ≤ 250）', !!bbox && bbox.sx <= 250, bbox);

    const p = await runPipeline(img, 156, 48);
    const w = p.data.w, h = p.data.h, grid = p.grid, meta = p.colorMeta;
    const isBlank = id => (id < 0) || !meta[id] || hexLum(meta[id].hex) > 235;

    let rightCol = -1;
    for (let x = w - 1; x >= 0 && rightCol < 0; x--)
      for (let y = 0; y < h; y++) if (!isBlank(grid[y * w + x])) { rightCol = x; break; }
    ok('末尾字母没被裁掉（最右内容列 ≥ 95% 宽）', rightCol >= Math.floor(w * 0.95),
      { rightCol: rightCol, w: w });

    // 星号区（左 1/4）：修复后 bbox 含星号，网格左段应有一块珊瑚色独立区域
    let asterisk = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < Math.floor(w * 0.25); x++) {
      const id = grid[y * w + x];
      if (!isBlank(id)) asterisk++;
    }
    ok('星号没被连通块过滤吃掉（左 1/4 有内容 ≥ 60 颗）', asterisk >= 60, asterisk);

    // 黑色字母主体仍然在（修复不能把内容改没了）
    let dark = 0;
    for (let i = 0; i < grid.length; i++) { const id = grid[i]; if (id >= 0 && meta[id] && hexLum(meta[id].hex) < 80) dark++; }
    ok('字母主体仍在（深色 ≥ 800 颗）', dark >= 800, dark);
  });

  // ---------- H2：证件照构图与五官不被破坏 ----------
  await sec('H2 证件照：蓝底不被当背景裁掉，五官特征色保留', async () => {
    const img = await loadImage(makeIdPhoto());
    const p = await runPipeline(img, 150, 200);
    const w = p.data.w, h = p.data.h, grid = p.grid, meta = p.colorMeta;

    ok('蓝底没被自动裁剪（网格保持 150×200）', w === 150 && h === 200, { w: w, h: h });

    const counts = {};
    for (let i = 0; i < grid.length; i++) { const id = grid[i]; if (id >= 0) counts[id] = (counts[id] || 0) + 1; }
    const total = Object.keys(counts).reduce((s, k) => s + counts[k], 0);
    ok('照片类保留足够多的颜色（≥7 种，旧版只剩 5）', Object.keys(counts).length >= 7, Object.keys(counts).length);

    // 构图完整：西装（深色）与蓝底（中饱和蓝）都得有可观的数量
    const darkSuit = Object.keys(counts).filter(id => hexLum(meta[id].hex) < 70)
      .reduce((s, id) => s + counts[id], 0);
    ok('西装/头发等深色主体仍在（≥15%）', darkSuit >= total * 0.15, darkSuit);
    const bgBlue = Object.keys(counts).filter(id => {
      const hx = (meta[id].hex || '').replace('#', '');
      if (hx.length !== 6) return false;
      const b = parseInt(hx.slice(4, 6), 16);
      const r = parseInt(hx.slice(0, 2), 16);
      return b > 120 && b - r > 40;   // 蓝底色
    }).reduce((s, id) => s + counts[id], 0);
    ok('蓝底仍在（≥20%，说明没把背景裁掉）', bgBlue >= total * 0.20, bgBlue);

    // 五官：按源图 y 比例找行，特征色数量必须显著（旧版被 0.6% 合并吞掉）
    const rowIds = (ySrc) => {
      const gy = Math.round(ySrc * h / 413);
      const m = {};
      for (let x = 0; x < w; x++) { const id = grid[gy * w + x]; if (id >= 0) m[id] = (m[id] || 0) + 1; }
      return m;
    };
    const browRow = rowIds(178), mouthRow = rowIds(258);
    // 眉毛 = 深棕色（lum 40~110、非纯黑）在该行 ≥ 10 颗
    const browish = Object.keys(browRow).filter(id => { const L = hexLum(meta[id].hex); return L >= 30 && L <= 110; })
      .reduce((s, id) => s + browRow[id], 0);
    ok('眉毛行保留深棕特征色（≥10 颗）', browish >= 10, browRow);
    // 嘴唇 = 该行存在与肤色不同的暖色块 ≥ 6 颗
    const mouthColors = Object.keys(mouthRow).filter(id => (mouthRow[id] >= 6 && mouthRow[id] <= 60)).length;
    ok('嘴巴行存在小面积特征色块（≥1 组）', mouthColors >= 1, mouthRow);
  });

  // ---------- H3：照片灰白底也要能裁，且必须裁全（第二版门槛回归） ----------
  await sec('H3 灰白照片底 logo：能裁，且 bbox 盖住全部文字', async () => {
    const img = await loadImage(makeGreyLogo());
    const p = editorPage();
    // 用与 makeGreyLogo 完全相同的字体量出文字右缘（不同环境 serif 度量不同，不能硬编码）
    const mc = createCanvas(10, 10).getContext('2d');
    mc.font = 'bold 150px serif';
    const textRight = 270 + mc.measureText('Claude').width;
    const bbox = p._detectContentBBox(img);
    ok('灰白底(#b8b8b8, lum≈184)能检出内容框', !!bbox, bbox);
    // 60406f5 实测 bbox={sx:30,sw:340}——裁是裁了，但把 "laude" 整段裁掉。
    // 教训（同 H1）：坏 bbox 也会铺满自己的网格，必须直接断言 bbox 覆盖已知内容范围。
    ok('bbox 盖住文字右缘（右缘≈' + Math.round(textRight) + '）',
      !!bbox && (bbox.sx + bbox.sw) >= textRight - 12, { bbox: bbox, textRight: Math.round(textRight) });
    const q = await runPipeline(img, 150, 150);
    ok('裁剪后网格变横条（w 明显大于 h）', q.data.w > q.data.h * 1.5, { w: q.data.w, h: q.data.h });
    // 内容占网格的比例要显著提高（不裁时 logo 只占 ~55% 宽）
    const meta = q.colorMeta, grid = q.grid;
    const isBlank = id => (id < 0) || !meta[id] || hexLum(meta[id].hex) > 235;
    let rightCol = -1, leftCol = q.data.w;
    for (let x = 0; x < q.data.w && leftCol === q.data.w; x++)
      for (let y = 0; y < q.data.h; y++) if (!isBlank(grid[y * q.data.w + x])) { leftCol = x; break; }
    for (let x = q.data.w - 1; x >= 0 && rightCol < 0; x--)
      for (let y = 0; y < q.data.h; y++) if (!isBlank(grid[y * q.data.w + x])) { rightCol = x; break; }
    const cover = (rightCol - leftCol + 1) / q.data.w;
    ok('内容铺满网格宽度（≥90%）', cover >= 0.9, { leftCol: leftCol, rightCol: rightCol, w: q.data.w });
  });

  // ---------- H4：二维码式黑白图不被拉伸/平滑破坏 ----------
  await sec('H4 QR（ss=2）：黑白两色图保持两色', async () => {
    const img = await loadImage(makeQR());
    const p = await runPipeline(img, 105, 105);
    const n = Object.keys(p.colorMeta).length;
    ok('黑白模块图输出仍为 2 色', n === 2, { colors: Object.values(p.colorMeta).map(m => m.hex) });
    const hasBlack = Object.values(p.colorMeta).some(m => hexLum(m.hex) < 60);
    const hasWhite = Object.values(p.colorMeta).some(m => hexLum(m.hex) > 220);
    ok('黑与白都在（图形没被抹掉）', hasBlack && hasWhite, p.colorMeta);
  });

  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})();
