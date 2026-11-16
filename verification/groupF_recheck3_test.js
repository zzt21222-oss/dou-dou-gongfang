'use strict';
// verification/groupF_recheck3_test.js
//
// 组 F（第三方**第三轮复核报告 S1~S5**，2026-09-20）回归测试。
//
// 与前几组的分工：组 E 验的是"每个修复函数本身对不对"，
// 组 F 专门补报告点出的**组合路径**——跨入口的数据一致性、同一作品的不同版本、
// 失败分支继续失败。这类 bug 的特征是：单独调某个函数都正常，连起来才出错。
//
// 对应关系：
//   S1 预览页补选品牌只换可见网格：fullGrid / colorMeta / locked 不一致，
//      保存→重开→切回矩形抛 reading 'rgb'。
//   S2 回滚校验只比 ID：同一作品改过之后（同 id 不同 grid）两版被判"同一份"，
//      旧版本被删。
//   S3 恢复前置步骤失败后没停：恢复仍失败时继续开新事务，覆盖并删掉唯一救援快照。
//   S4 8pt 下限只对三字符成立：四字符色号（Artkal C100 / Hama H101 / Perler 5179）
//      实得 13px = 6.24pt；纸面其它文字 15/16px 也不够。
//   S5 普通"保存图纸"的图例按固定 300px 算画布，而 drawLegend 会按实测文本撑宽
//      → 右列数量文本被裁到画布外。
//
// 断言原则（承袭组 E）：
//   · 全部走真实页面入口（onPickBrand / saveHistory / loadFromData / onShape /
//     restoreBackup / recoverRestore / _printLayout / _buildPrintPage / exportImage）；
//   · 字号取**真实 fillText 那一刻的 ctx.font**，不自己复算理论值；
//   · 每节独立隔离异常；本文件在修复前的代码上必须大面积 FAIL。
//
// 用法：
//   NODE_PATH=<node_modules> node verification/groupF_recheck3_test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..');
const requireSrc = createRequire(path.join(ROOT, 'app.js'));
const loader = requireSrc('./utils/paletteLoader.js');
const render = requireSrc('./utils/render.js');
const bead = requireSrc('./utils/bead.js');
const storage = requireSrc('./utils/storage.js');

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

// 一次可复用的共享存储：预览页写、编辑器读，必须落在同一个 store 上
function sharedStore(init) {
  const store = init || {};
  return {
    store,
    wx: {
      getStorageSync: k => (store[k] !== undefined && store[k] !== '' ? clone(store[k]) : (store[k] === '' ? '' : '')),
      setStorageSync: (k, v) => { store[k] = clone(v); },
      removeStorageSync: k => { delete store[k]; }
    }
  };
}

// 通用页面加载器：真画布 + 可注入 wx + 记录每次 fillText 的**真实字体与实宽**
function page(name, options) {
  options = options || {};
  let def;
  const store = options.store || {};
  const app = options.app || {
    globalData: { prefs: { brand: 'mard', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} }, project: null },
    savePrefs() {}, setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
  };
  const record = options.record || { texts: [], exports: [], pages: [], calls: [] };
  const wx = Object.assign({
    getStorageSync: k => (store[k] ? clone(store[k]) : ''),
    setStorageSync: (k, v) => { store[k] = clone(v); },
    removeStorageSync: k => { delete store[k]; },
    showToast() {}, showModal() {}, navigateTo() {}, navigateBack() {}, showLoading() {}, hideLoading() {}, vibrateShort() {},
    setClipboardData() {},
    getWindowInfo: () => ({ pixelRatio: 1, windowWidth: 375, windowHeight: 800 }),
    createOffscreenCanvas(o) {
      const c = createCanvas(o.width, o.height);
      const origGet = c.getContext.bind(c);
      c.getContext = function (type) {
        const ctx = origGet(type);
        if (!ctx.__hooked) {
          ctx.__hooked = true;
          const oFill = ctx.fillText.bind(ctx);
          ctx.fillText = function (t, x, y) {
            const s = String(t);
            let w = 0;
            try { w = this.measureText(s).width; } catch (e) { /* 量不到就记 0 */ }
            const al = this.textAlign || 'start';
            let left = x;
            if (al === 'center') left = x - w / 2;
            else if (al === 'right' || al === 'end') left = x - w;
            record.texts.push({
              text: s, x: x, y: y, align: al, font: this.font,
              width: w, left: left, right: left + w, canvas: [c.width, c.height]
            });
            return oFill(t, x, y);
          };
        }
        return ctx;
      };
      return c;
    },
    canvasToTempFilePath(o) {
      record.exports.push({ canvas: o.canvas, withCode: !!o.__withCode });
      if (o.success) o.success({ tempFilePath: '/tmp/f-page-' + record.exports.length + '.png' });
    },
    saveImageToPhotosAlbum(o) { if (o.success) o.success(); }
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
  return { p: def, app, wx, store, record };
}

function metaOf(rgb, code, name) {
  return {
    rgb: rgb, code: code, short: code, name: name || code,
    hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  };
}
// 一个下标是否能在色元数据里取到（绘图就靠这一步）
function hasMeta(colorMeta, id) {
  const m = colorMeta && colorMeta[id];
  return !!(m && m.rgb);
}
// 网格里有值的下标是否都有色元数据；返回孤立下标
function orphans(grid, colorMeta) {
  const bad = {};
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (v >= 0 && !hasMeta(colorMeta, v)) bad[v] = true;
  }
  return Object.keys(bad).map(Number);
}

(async () => {
  console.log('《豆豆工坊A》组 F 回归测试 —— 第三方第三轮复核 S1~S5（组合路径）');
  console.log('入口：真实 preview / editor / storage 页面与模块');

  // ============================================================
  await sec('F1 (S1) 预览补选品牌必须换整件作品：保存→重开→切矩形不能崩', async () => {
    const W = 12, H = 12;
    // 用真实形状掩膜造一张圆形作品：颜色 0 **只出现在圆外**（形状藏起来的颜色）
    const full = new Array(W * H).fill(0);
    const mask = bead.buildShapeMask(W, H, 'circle');
    for (let i = 0; i < W * H; i++) if (mask[i] >= 0) full[i] = 1;
    const grid = bead.applyShapeMask(full, W, H, 'circle');
    const colorMeta = { 0: metaOf([10, 20, 30], 'X1'), 1: metaOf([200, 30, 40], 'X2') };

    const shar = sharedStore();
    const store = shar.store;
    const app = {
      globalData: {
        prefs: { brand: 'mard', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} },
        project: {
          w: W, h: H, grid: grid, fullGrid: full, colorMeta: colorMeta,
          brand: '', brandName: '', brandUnknown: true, shape: 'circle',
          locked: { 1: true }, recId: '', boards: null, src: ''
        }
      },
      savePrefs() {}, setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
    };
    const env = page('preview', { app: app, store: store, wx: shar.wx });
    const p = env.p;
    p.onLoad();

    ok('前置：颜色 0 确实只在形状外出现',
      grid.indexOf(0) < 0 && full.indexOf(0) >= 0, { inVisible: grid.indexOf(0) >= 0, inFull: full.indexOf(0) >= 0 });
    eq('前置：进入预览时品牌未知', p.data.brandUnknown, true);

    // 真实入口：手选 Hama
    const idx = loader.getBrandList().findIndex(b => b.key === 'hama');
    p.onPickBrand({ detail: { value: String(idx) } });

    ok('选完品牌解除未知', p.data.brandUnknown === false, p.data.brandUnknown);
    eq('预览的项目品牌已换成目标品牌', p.project.brand, 'hama');
    // 核心：换算后的三样东西必须互相自洽（报告 S1 就是这里断的）
    eq('换算后可见网格没有孤立下标', orphans(p.grid, p.colorMeta), []);
    eq('换算后权威网格没有孤立下标', orphans(p.project.fullGrid, p.colorMeta), []);
    ok('权威网格真的被换过了（不是原样留着旧下标）',
      p.project.fullGrid.indexOf(0) < 0 && p.project.fullGrid.indexOf(1) < 0,
      Array.from(p.project.fullGrid).slice(0, 8));
    ok('形状外的颜色也进了新色元数据（旧实现会把它丢掉）',
      Object.keys(p.colorMeta).length >= 2, Object.keys(p.colorMeta));

    // 锁定色按下标存，换算后必须跟着换；换完的点应该落在新色元数据里
    const lockedKeys = Object.keys(p.project.locked || {}).filter(k => p.project.locked[k]);
    eq('锁定色没有指向不存在的下标', lockedKeys.filter(k => !hasMeta(p.colorMeta, k)), []);
    ok('原来锁的那颗颜色仍然锁着（换成新下标，不是被丢掉）',
      lockedKeys.length === 1, { locked: lockedKeys, visibleIds: Array.from(new Set(Array.from(p.grid).filter(v => v >= 0))) });

    // 保存到历史 → 从存储里读回来 → 进编辑器 → 切回矩形 → 真绘图
    p.saveHistory();
    const saved = (store.history || [])[0];
    ok('已存进历史', !!saved, Object.keys(store));
    eq('历史里的权威网格没有孤立下标', orphans(saved.fullGrid, saved.colorMeta), []);
    eq('历史里的可见网格没有孤立下标', orphans(saved.grid, saved.colorMeta), []);

    const e2 = page('editor', { wx: shar.wx, store: store });
    const ep = e2.p;
    ep.onLoad({});
    ep.loadFromData(saved);
    ok('编辑器载入了这张作品', !!ep.fullGrid && ep.fullGrid.length > 0, ep.fullGrid && ep.fullGrid.length);

    // 切回矩形：这一步会把 fullGrid 整段投影出来，旧实现就是在这里炸的
    const rectIdx = ep.data.shapeKeys.indexOf('rect');
    let threw = null;
    try { ep.onShape({ detail: { value: String(rectIdx) } }); }
    catch (err) { threw = String(err.message); }
    ok('切回矩形不抛异常', threw === null, threw);
    eq('切回矩形后没有孤立下标', orphans(ep.grid, ep.colorMeta), []);

    // 真画一遍：报告的报错就是从这里出来的
    let drawErr = null;
    try {
      render.drawGrid(createCanvas(64, 64).getContext('2d'), {
        grid: ep.grid, w: W, h: H, cell: 5, offX: 0, offY: 0,
        colorMeta: ep.colorMeta, mode: 'pixel'
      });
    } catch (err) { drawErr = String(err.message); }
    ok('真实 drawGrid 不报 reading \'rgb\'', drawErr === null, drawErr);

    // 鉴别力对照：只换算"可见网格"会留下孤立下标（旧实现正是这样）
    const onlyVisible = requireSrc('./utils/brandConvert.js').convert({
      grid: grid, colorMeta: colorMeta, toBrand: 'hama'
    });
    ok('对照：只换算可见网格确实会丢颜色（旧写法复现）',
      onlyVisible.ok && Object.keys(onlyVisible.colorMeta).length < 2,
      Object.keys(onlyVisible.colorMeta));
  });

  // ============================================================
  await sec('F2 (S2) 回滚校验看内容：同一作品的不同版本不能被当成同一份', async () => {
    // 同一件作品 P，历史是改后的 grid=[1]，备份是改前的 grid=[2] —— 正常情况
    const store = {
      history: [{ id: 'P', grid: [1] }],
      history_bak: { at: 1, projects: [{ id: 'P', grid: [2] }] }
    };
    let phase = 1, bakWrites = 0;
    const writes = [];
    global.wx = {
      getStorageSync: k => (store[k] ? clone(store[k]) : ''),
      setStorageSync(k, v) {
        writes.push(k);
        if (phase === 1 && (k === 'history' || (k === 'history_bak' && ++bakWrites === 2))) {
          throw Error('injected write failure');
        }
        store[k] = clone(v);
      },
      removeStorageSync: k => { delete store[k]; }
    };
    const st = requireSrc('./utils/storage.js');

    const first = st.restoreBackup();
    eq('首次回滚失败（预期）', first.ok, false);
    eq('失败时保留临时键', first.keptTmp, true);
    ok('旧版本 grid=[2] 这时只活在救援区',
      JSON.stringify(store.history_tmp || {}).indexOf('[2]') >= 0, Object.keys(store));

    // 故障排除后再点一次
    phase = 2;
    const second = st.restoreBackup();
    eq('第二次回滚成功', second.ok, true);
    ok('★旧版本内容没有消失（复核 S2 的核心）',
      JSON.stringify(store).indexOf('[2]') >= 0, {
        keys: Object.keys(store),
        history: store.history,
        bak: store.history_bak
      });
    eq('回滚后历史就是备份内容', (store.history || []).map(x => x.grid), [[2]]);

    // 反例：ID 相同、内容不同的两种列表，绝不能被判成"同一份"
    const a = [{ id: 'P', grid: [1] }], b = [{ id: 'P', grid: [2] }];
    ok('只比 ID 会判"相同"（旧口径）', JSON.stringify(a.map(x => x.id)) === JSON.stringify(b.map(x => x.id)), true);
    const src = readFile('utils/storage.js');
    ok('源码里已不再用"只比 ID"的做法判两侧一致',
      src.indexOf('sameIds(') < 0, src.indexOf('sameIds(') >= 0);

    // 内容一致时必须认得出来（否则收尾会一直以为"换到一半"）
    const store2 = {
      history: [{ id: 'P', grid: [7] }],
      history_bak: { at: 1, projects: [{ id: 'Q', grid: [9] }] },
      history_tmp: { at: 1, bak: { at: 1, projects: [{ id: 'P', grid: [7] }] } }
    };
    global.wx = {
      getStorageSync: k => (store2[k] ? clone(store2[k]) : ''),
      setStorageSync: (k, v) => { store2[k] = clone(v); },
      removeStorageSync: k => { delete store2[k]; }
    };
    const r = st.recoverRestore();
    const r2 = st.recoverRestore();
    eq('内容一致时判为"上次已完成、只需清理"', [r.recovered, r.restored, !!store2.history_tmp], [true, false, false]);
    eq('收尾之后就没事可做了', !!r2.recovered, false);
  });

  // ============================================================
  await sec('F3 (S3) 恢复仍失败时不许继续开新事务，救援区不能被覆盖或删除', async () => {
    const store = {
      history: [{ id: 'CURRENT', grid: [1] }],
      history_bak: { at: 1, projects: [{ id: 'BACKUP', grid: [2] }] }
    };
    let phase = 1, bakWrites = 0;
    const writes = [];
    global.wx = {
      getStorageSync: k => (store[k] ? clone(store[k]) : ''),
      setStorageSync(k, v) {
        writes.push(k);
        if (phase === 1 && (k === 'history' || (k === 'history_bak' && ++bakWrites === 2))) {
          throw Error('injected write failure');
        }
        // 第二阶段：备份键持续写不进去（故障没排除）
        if (phase === 2 && k === 'history_bak') throw Error('recovery write still failing');
        store[k] = clone(v);
      },
      removeStorageSync: k => { delete store[k]; }
    };
    const st = requireSrc('./utils/storage.js');
    const first = st.restoreBackup();
    eq('首次回滚失败并保留救援区', [first.ok, first.keptTmp], [false, true]);

    phase = 2;
    const tmpBefore = clone(store.history_tmp);
    const bakWritesBefore = writes.length;
    const second = st.restoreBackup();
    const writes2 = writes.slice(bakWritesBefore);
    writes2.length = 0;

    eq('恢复仍失败时如实返回失败', second.ok, false);
    eq('并且明确告知救援区还在', second.keptTmp, true);
    ok('★旧数据没有从任何键里消失（复核 S3 的核心）',
      JSON.stringify(store).indexOf('[2]') >= 0, { keys: Object.keys(store), bak: store.history_bak });
    eq('救援快照原样保留（没有被当前内容覆盖）', store.history_tmp, tmpBefore);
    ok('没有在救援区未收尾的情况下动过历史', (store.history || [])[0].id === 'CURRENT', store.history);

    // 故障排除后第三次点击必须能收尾，且旧数据回到可恢复位置
    phase = 3;
    const third = st.restoreBackup();
    eq('故障排除后能收尾', third.ok, true);
    ok('收尾后旧版本仍可恢复（落在历史或备份里）',
      JSON.stringify(store).indexOf('[2]') >= 0, { history: store.history, bak: store.history_bak });
    ok('临时键已清理', !store.history_tmp, store.history_tmp);

    // 静态：前置恢复的结果必须被检查（旧版直接调用后忽略返回值）
    const src = readFile('utils/storage.js');
    ok('restoreBackup 检查了 recoverRestore 的结果',
      /const rec = recoverRestore\(\);/.test(src) && /rec\.keptTmp/.test(src), true);
  });

  // ============================================================
  await sec('F4 (S4) 8pt 下限对真实色号成立：看真实绘图字体，不是复算理论值', async () => {
    const PT = px => px * 72 / 150;   // 150dpi 下像素 → 磅
    const brands = ['mard', 'artkal_c', 'artkal_s', 'hama', 'perler'];
    const rows = [];
    for (const brand of brands) {
      const pal = loader.getPaletteColors(brand);
      // 取该品牌**最长**的短码：报告的缺陷正是在四字符上暴露的
      const c = pal.slice().sort((a, b) => String(b.short || '').length - String(a.short || '').length)[0];
      const panel = [{
        id: c.id, hex: c.hex, code: c.code, name: c.name, short: c.short,
        count: 14, suggest: 15
      }];
      const app = {
        globalData: {
          prefs: { brand: brand, boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} },
          project: {
            w: 6, h: 6, grid: new Array(36).fill(c.id),
            colorMeta: { [c.id]: { rgb: c.rgb, hex: c.hex, code: c.code, short: c.short, name: c.name, brandKey: brand } },
            brand: brand, brandName: loader.getPaletteInfo(brand).brandName,
            brandUnknown: false, shape: 'rect', locked: {}, boards: null
          }
        },
        savePrefs() {}, setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
      };
      const env = page('preview', { app: app });
      env.p.onLoad();
      env.p.setData({ palettePanel: panel, colorCount: 1, totalCount: 36 });
      env.p.data.palettePanel = panel;
      const lay = env.p._printLayout();
      env.record.texts.length = 0;
      env.p._buildPrintPage(lay, 0, 0);
      env.p._buildBomPage(lay, 0);
      const texts = env.record.texts;
      // 格内色号那一笔：真实字体
      const label = texts.find(t => t.text === String(c.short));
      const gridFont = label ? parseFloat(label.font) : NaN;
      // 纸面上所有文字（除大标题这类本来就更粗更大的）都不得低于 8pt
      const tooSmall = texts
        .map(t => ({ text: t.text.slice(0, 14), px: parseFloat(t.font) }))
        .filter(t => !(t.px >= 17));
      rows.push({ brand: brand, short: c.short, cell: lay.cell, gridFontPx: gridFont, small: tooSmall.length });
      ok('[' + brand + '] 格内色号 ' + c.short + ' 实际字号 ≥ 8pt',
        gridFont >= 17 && PT(gridFont) >= 8, { fontPx: gridFont, pt: +PT(gridFont).toFixed(2) });
      ok('[' + brand + '] 纸面所有文字都不低于最小字号（旧版有 15/16px）',
        tooSmall.length === 0, tooSmall.slice(0, 6));
    }
    console.log('    实测：' + rows.map(r => r.brand + '(' + r.short + ') cell=' + r.cell + ' font=' + r.gridFontPx + 'px=' + PT(r.gridFontPx).toFixed(2) + 'pt').join('  '));
    ok('四字符品牌的格宽确实被推大了（否则 8pt 不可能成立）',
      rows.filter(r => r.short.length >= 4).every(r => r.cell > 34),
      rows.map(r => r.short.length + ':' + r.cell));
    ok('三字符的 MARD 格宽没有被无谓放大（不白增纸张）',
      rows.filter(r => r.short.length <= 3).every(r => r.cell === 34),
      rows.filter(r => r.short.length <= 3).map(r => r.cell));

    // 反推用的必须是**绘制时同一个函数**，否则又会各算一套
    const srcRender = readFile('utils/render.js');
    ok('render 导出了 labelFontPx / minCellForLabel 供版面复用',
      /labelFontPx/.test(srcRender) && /minCellForLabel/.test(srcRender), true);
    const srcPreview = readFile('pages/preview/preview.js');
    ok('打印版面用 minCellForLabel 反推格宽（不再只按 0.5×格宽）',
      /render\.minCellForLabel\(/.test(srcPreview), true);
    const fs8 = Math.ceil(8 * 150 / 72);
    eq('反推函数与绘制函数一致（4 字符 ⇒ 45px）',
      render.minCellForLabel('C100', fs8), 45);
    eq('反推函数与绘制函数一致（3 字符 ⇒ 34px）',
      render.minCellForLabel('A10', fs8), 34);
  });

  // ============================================================
  await sec('F5 (S5) 普通保存图纸：图例必须落在画布内，画布尺寸跟最终布局走', async () => {
    const cases = [
      { n: 1, mode: 'image' }, { n: 3, mode: 'image' }, { n: 5, mode: 'plain' },
      { n: 7, mode: 'image' }, { n: 12, mode: 'plain' }
    ];
    for (const cs of cases) {
      // 挑名称最长的若干色：名字越长越容易把列撑宽
      const pal = loader.getPaletteColors('perler').slice().sort((a, b) => b.name.length - a.name.length);
      const picked = pal.slice(0, cs.n);
      const panel = picked.map(c => ({
        id: c.id, hex: c.hex, code: c.code, name: c.name, short: c.short, count: 140, suggest: 147
      }));
      const colorMeta = {};
      picked.forEach(c => {
        colorMeta[c.id] = { rgb: c.rgb, hex: c.hex, code: c.code, short: c.short, name: c.name, brandKey: 'perler' };
      });
      // 10×10 网格铺满这些颜色
      const grid = new Array(100).fill(0).map((_, i) => picked[i % picked.length].id);
      const app = {
        globalData: {
          prefs: { brand: 'perler', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} },
          project: {
            w: 10, h: 10, grid: grid, colorMeta: colorMeta,
            brand: 'perler', brandName: loader.getPaletteInfo('perler').brandName,
            brandUnknown: false, shape: 'rect', locked: {}, boards: null
          }
        },
        savePrefs() {}, setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
      };
      const env = page('preview', { app: app });
      env.p.onLoad();
      env.p.setData({ palettePanel: panel, colorCount: cs.n, totalCount: 100 });

      env.record.texts.length = 0;
      env.record.exports.length = 0;
      if (cs.mode === 'plain') env.p.exportPlain(); else env.p.exportImage();
      const exp = env.record.exports[0];
      ok('[' + cs.n + ' 色/' + cs.mode + '] 真的生成了图片', !!exp, env.record.exports.length);
      if (!exp) continue;
      const cw = exp.canvas.width, chh = exp.canvas.height;
      const outside = env.record.texts.filter(t => t.right > cw + 0.5 || t.left < -0.5);
      ok('[' + cs.n + ' 色/' + cs.mode + '] 没有文字被裁到画布外',
        outside.length === 0,
        outside.slice(0, 3).map(t => ({ text: t.text, right: +t.right.toFixed(1), canvas: cw })));

      // 画布宽度必须 ≥ 图例实际排版宽度（报告的建议做法：先排版、再定尺寸）
      const lay = render.legendLayout(env.p._measureCtx(), {
        panel: panel,
        cols: panel.length > 6 ? 3 : (panel.length > 3 ? 2 : 1),
        maxWidth: Math.max(300, Math.min(3200, Math.max(40 * 10 + 34 + 80, 900)) - 80),
        fontPx: 15, rowH: 34
      });
      ok('[' + cs.n + ' 色/' + cs.mode + '] 画布宽度容得下最终图例布局',
        lay.cols * lay.colWidth + 80 <= cw + 0.5,
        { legendW: +(lay.cols * lay.colWidth).toFixed(1), canvas: cw, cols: lay.cols });
    }

    // 静态：旧版是先用写死的 300px 算画布
    const src = readFile('pages/preview/preview.js');
    ok('旧的固定 300px 列宽已消失', src.indexOf('legendColW = 300') < 0, true);
    ok('画布尺寸改成先排图例再定', /legendSelect/.test(src) && /legendW \+ margin \* 2/.test(src), true);
  });

  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('顶层异常', e); process.exit(1); });
