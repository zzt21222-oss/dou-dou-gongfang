'use strict';
// verification/audit_p1_regression_test.js
//
// 针对 2026-09-19 第三方源码审查报告所列 P1 问题的「已修复」回归测试。
//
// 与旧验证资产的关键区别（审查报告点名批评过）：
//   旧的品牌对比页在构造 colorMeta 时手工写了 `code: c.id`，等于把字段补齐了
//   再画图 —— 测的是一条被修补过的路径，不是产品真实路径，所以 F01 没被拦住。
//   本文件所有用例都从**真实入口**进链路：
//     paletteLoader.getPaletteColors() → bead.mapToPalette/finalize → 页面逻辑，
//   不手工补任何字段。
//
// 用法：
//   NODE_PATH=<node_modules> node verification/audit_p1_regression_test.js
// 依赖 @napi-rs/canvas（与审查脚本同一依赖）。

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
const migrate = requireSrc('./utils/migrate.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '   → ' + JSON.stringify(detail) : '')); }
}
function eq(name, actual, expect) {
  const a = JSON.stringify(actual), e = JSON.stringify(expect);
  ok(name, a === e, a === e ? undefined : { actual: actual, expect: expect });
}
function section(t) { console.log('\n=== ' + t + ' ==='); }
const clone = x => JSON.parse(JSON.stringify(x));
const silent = { log() {}, error() {}, warn() {} };

// ---------- 页面环境（与审查脚本同一套桩，保证可比） ----------
function page(name, options) {
  options = options || {};
  let def;
  const store = options.store || {};
  const app = options.app || {
    globalData: { prefs: { brand: 'mard', boardSize: { w: 50, h: 50 }, colorCount: 12, accessibility: {} }, project: null },
    savePrefs() {},
    setBrand(k) { this.globalData.prefs.brand = loader.setCurrentBrand(k); }
  };
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
    Uint8ClampedArray, Uint8Array, Int32Array, Map, Set, Object, Array, JSON, Math, Date, String, Number, Boolean, Promise, Error
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  def.data = clone(def.data);
  def.setData = function (p, cb) { Object.assign(this.data, p); if (cb) cb(); };
  return { p: def, app, wx, store };
}
function initEditor(options) {
  const env = page('editor', options);
  env.p.onLoad({ src: encodeURIComponent('test.png') });
  env.p.renderGrid = () => {};
  env.p.computeCell = () => {};
  return env;
}
function metaOf(rgb, code, short) {
  return {
    rgb: rgb, code: code, short: short || code, name: code,
    hex: '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('')
  };
}
function fakeCtx() {
  const texts = [];
  return {
    texts, fillStyle: '', font: '', textAlign: '', textBaseline: '',
    fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, clip() {}, save() {}, restore() {}, clearRect() {},
    fillText(t, x, y) { texts.push({ text: t, x: x, y: y, fill: this.fillStyle, font: this.font }); }
  };
}

(async () => {
  console.log('《豆豆工坊A》审查 P1 回归测试 —— 断言"已修复"状态');
  console.log('入口：真实 paletteLoader → bead → 页面逻辑（不手工补字段）');

  // ============================================================
  section('F01 真实色号不再丢失（加载器 → 映射 → finalize 全链路）');
  const brands = loader.getBrandList().filter(b => b.key !== loader.GENERIC_KEY);
  const f01rows = [];
  for (const b of brands) {
    const pal = loader.getPaletteColors(b.key);
    const i = pal.findIndex(c => c.code !== 'C1');
    const labels = bead.mapToPalette(pal[i].rgb, pal);
    const matched = pal[labels[0]];
    const fin = bead.finalize(labels, pal);
    f01rows.push({ brand: b.key, matched: matched.code, out: fin.colors[0].code, short: fin.colors[0].short });
  }
  eq('五个品牌 finalize 后的 code 都等于真实色号',
    f01rows.map(r => r.out), f01rows.map(r => r.matched));
  ok('五个品牌都不再回退成位置编号 C1',
    f01rows.every(r => r.out !== 'C1' || r.matched === 'C1'), f01rows);
  ok('每项都带 brandKey', (() => {
    const pal = loader.getPaletteColors('mard');
    const fin = bead.finalize(bead.mapToPalette(pal[5].rgb, pal), pal);
    return fin.colors[0].brandKey === 'mard';
  })());
  ok('Perler 长 SKU：code 是全长、short 是短码', (() => {
    const pal = loader.getPaletteColors('perler');
    const c = pal.find(x => String(x.code).indexOf('-') > 0);
    const fin = bead.finalize(bead.mapToPalette(c.rgb, pal), pal);
    return fin.colors[0].code === c.code && fin.colors[0].short === c.short && fin.colors[0].short.length < fin.colors[0].code.length;
  })());

  // F01b 完整 processImage 链路
  {
    const { p } = initEditor();
    const pal = loader.getPaletteColors('mard');
    const src = createCanvas(20, 20), ctx = src.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, 20, 20);
    ctx.fillStyle = '#D80127'; ctx.fillRect(0, 0, 10, 20);
    p.data.w = 20; p.data.h = 20;
    p.loadImage = async () => src;
    p._moduleAutoTried = true; p._autoTrimmed = true;
    await p.processImage();
    const codes = Object.values(p.colorMeta).map(m => m.code);
    ok('完整生成链路不再出现 C1/C2 位置编号', codes.every(c => !/^C\d+$/.test(c)), codes);
    ok('生成后 colorMeta 带品牌', Object.values(p.colorMeta).every(m => m.brandKey === 'mard'));
    ok('生成后作品品牌被钉住', p.brandKey === 'mard', p.brandKey);
    ok('红/白都拿到真实色号', codes.length === 2, codes);
  }
  console.log('     各品牌结果：' + f01rows.map(r => `${r.brand}:${r.out}`).join('  '));

  // ============================================================
  section('F02 格内色号任何时候都用正确颜色绘制');
  {
    const html = fs.readFileSync(path.join(ROOT, 'verification/brand_compare.html'), 'utf8');
    const m = html.match(/const VARIANTS = (\[.*?\]);/s);
    if (m) {
      const variants = JSON.parse(m[1]);
      variants.forEach(v => {
        const ctx = fakeCtx();
        render.drawGrid(ctx, {
          grid: v.grid, w: 20, h: 20, cell: 26, offX: 0, offY: 0,
          colorMeta: v.meta, mode: 'pixel', showCode: true
        });
        const wrong = ctx.texts.filter((t, i) => {
          const rgb = v.meta[v.grid[i]].rgb;
          const want = (.299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2]) > 150
            ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)';
          return t.fill !== want;
        }).length;
        eq(`${v.label}：全部 ${ctx.texts.length} 格文字颜色都符合明暗规则`, wrong, 0);
      });
    } else {
      ok('能找到品牌对比页的样例数据', false);
    }
    // 连续同类明暗（审查指出旧测试只覆盖交替明暗，漏了这种）
    const ctx2 = fakeCtx();
    const meta = { 0: metaOf([20, 20, 20], 'H1'), 1: metaOf([250, 250, 250], 'H2') };
    render.drawGrid(ctx2, {
      grid: new Array(400).fill(0), w: 20, h: 20, cell: 26, offX: 0, offY: 0,
      colorMeta: meta, mode: 'pixel', showCode: true
    });
    eq('连续深色 400 格：全部白字', ctx2.texts.filter(t => t.fill === 'rgba(0,0,0,0.82)').length, 0);
    eq('连续深色 400 格：文字数量正确', ctx2.texts.length, 400);
  }

  // ============================================================
  section('F04 收笔事件接通、填充标脏、退出路径覆盖');
  {
    const { p, store } = initEditor();
    p.grid = [0, 0, 1, 1];
    p.colorMeta = { 0: metaOf([255, 0, 0], 'A'), 1: metaOf([0, 0, 255], 'B') };
    p.data.w = 2; p.data.h = 2; p.cell = 20;
    p.data.activeTool = 'fill'; p.data.activeColorId = 1;
    p.onTouch({ type: 'touchstart', touches: [{ x: 5, y: 5 }], changedTouches: [] });
    p.onTouch({ type: 'touchend', touches: [], changedTouches: [{ x: 5, y: 5 }] });
    p.onHide();
    eq('单次区域填充后网格已改变', p.grid, [1, 1, 1, 1]);
    ok('填充后 _dirty = true', p._dirty === true);
    ok('填充后草稿已写入', !!store.draft);
    eq('填充后撤销栈有 1 笔', p._undoStack.length, 1);
    ok('填充后 canUndo = true', p.data.canUndo === true);

    const wxml = fs.readFileSync(path.join(ROOT, 'pages/editor/editor.wxml'), 'utf8');
    ok('WXML 已绑定 bindtouchend', /bindtouchend=/.test(wxml));
    ok('WXML 已绑定 bindtouchcancel', /bindtouchcancel=/.test(wxml));
    ok('编辑器实现了 onUnload', typeof p.onUnload === 'function');
  }

  // ============================================================
  section('F05 打开历史不冒充品牌，预览标注作品自身品牌');
  {
    loader.setCurrentBrand('mard');
    const { p, app } = initEditor();
    const pal = loader.getPaletteColors('hama');
    const rec = {
      id: 'hama-old', brand: 'hama', w: 2, h: 1, grid: [0, 0],
      colors: [Object.assign({ id: 0 }, metaOf(pal[0].rgb, pal[0].code, pal[0].short))]
    };
    p.loadFromRecord(rec);
    p.goPreview();
    eq('编辑器记住了作品的品牌', p.brandKey, 'hama');
    eq('预览标注的是作品品牌，不是全局默认', app.globalData.project.brand, 'mard' === app.globalData.project.brand ? 'mard(错)' : 'hama');
    ok('预览品牌 = hama', app.globalData.project.brand === 'hama', app.globalData.project.brand);
    ok('预览品牌名 = Hama', /Hama/i.test(app.globalData.project.brandName), app.globalData.project.brandName);
  }

  // ============================================================
  section('F08 正常彩色图不再被误判为全白/全黑');
  {
    const { p } = initEditor();
    ok('橙青双色像素不再判为退化', p._isDegenerate([255, 0, 0, 0, 255, 0, 0, 0, 255], 3, 1) === false);
    ok('空缓冲仍判为退化', p._isDegenerate(null, 1, 1) === true);
    ok('长度不足仍判为退化', p._isDegenerate([1, 2, 3], 10, 10) === true);

    // 真实 MARD 双色图走完整链路，必须生成出网格
    const pal = loader.getPaletteColors('mard');
    let pair = null;
    for (let i = 0; i < pal.length && !pair; i++) {
      for (let j = i + 1; j < pal.length; j++) {
        const a = pal[i], b = pal[j], sum = c => c.rgb.reduce((x, y) => x + y, 0);
        if (Math.abs(sum(a) - sum(b)) >= 24) continue;
        if (a.rgb.reduce((v, x, k) => v + (x - b.rgb[k]) ** 2, 0) < 70000) continue;
        if (bead.mapToPalette(a.rgb, pal)[0] !== i || bead.mapToPalette(b.rgb, pal)[0] !== j) continue;
        pair = [a, b]; break;
      }
    }
    ok('找得到"平均值相同但颜色不同"的 MARD 双色', !!pair, pair && pair.map(c => c.code));
    const src = createCanvas(20, 20), ctx = src.getContext('2d');
    ctx.fillStyle = pair[0].hex; ctx.fillRect(0, 0, 10, 20);
    ctx.fillStyle = pair[1].hex; ctx.fillRect(10, 0, 10, 20);
    const env = initEditor();
    let dialog = null;
    env.wx.showModal = o => { dialog = o; };
    env.p.data.w = 20; env.p.data.h = 20;
    env.p.loadImage = async () => src;
    env.p._moduleAutoTried = true; env.p._autoTrimmed = true;
    await env.p.processImage();
    ok('完整链路生成出了网格（旧版这里被拒绝）', env.p.grid.length === 400, env.p.grid.length);
    ok('没有弹出"像素提取失败"', !dialog, dialog && dialog.title);
  }

  // ============================================================
  section('F10 购买词带品牌与真实粒径');
  {
    const { p, wx } = page('preview');
    let copied = '';
    wx.setClipboardData = o => { copied = o.data; };
    p.project = { brand: 'hama' };
    p.copyBuy({ currentTarget: { dataset: { item: { name: 'Red', code: 'H22' } } } });
    ok('购买词含品牌 Hama', /Hama/i.test(copied), copied);
    ok('购买词含真实粒径 5mm', /5mm/.test(copied), copied);
    ok('购买词不再硬编码 2.6mm mini', !/2\.6mm/.test(copied), copied);

    p.project = { brand: 'mard' };
    let copied2 = '';
    wx.setClipboardData = o => { copied2 = o.data; };
    p.copyBuy({ currentTarget: { dataset: { item: { name: 'Red', code: 'F5' } } } });
    ok('MARD 用的是 2.6mm 中豆', /2\.6mm/.test(copied2), copied2);
  }

  // ============================================================
  section('F11 图例同时给出实际用量与建议购买量');
  {
    const ctx = fakeCtx();
    render.drawLegend(ctx, {
      panel: [
        { hex: '#ffffff', code: 'H1', name: 'White', count: 100, suggest: 105 },
        { hex: '#000000', code: 'H2', name: 'Black', count: 50, suggest: 53 }
      ],
      startX: 0, startY: 0, rowH: 30, title: '色卡 / 用量 · 建议购买（+5% 备用）', cols: 1
    });
    const texts = ctx.texts.map(t => t.text);
    ok('印出了用量/建议购买 100/105', texts.indexOf('100/105') >= 0, texts);
    ok('印出了用量/建议购买 50/53', texts.indexOf('50/53') >= 0, texts);
    ok('标题说明了建议购买', texts.some(t => /建议购买/.test(t)), texts);
  }

  // ============================================================
  section('F12 试色器在高 DPR 下读整张图（不再只读左上角）');
  {
    for (const dpr of [1, 2, 3]) {
      const { p, wx } = page('colorpicker', { dpr: dpr });
      // 主画布：真实小程序里会被 ctx.scale(dpr,dpr)；这里照样还原，验证修复不依赖它
      const display = createCanvas(108, 108);
      wx.createSelectorQuery = () => ({
        select() {
          return {
            fields() {
              return {
                exec(cb) {
                  cb([{ width: 36, height: 36, node: {
                    width: 36 * dpr, height: 36 * dpr,
                    getContext: () => display.getContext('2d'),
                    createImage: () => {
                      // 造一张「左上四分之一红、其余蓝」的图，并伪装成可 drawImage 的 img
                      const c = createCanvas(36, 36);
                      const g = c.getContext('2d');
                      g.fillStyle = 'blue'; g.fillRect(0, 0, 36, 36);
                      g.fillStyle = 'red'; g.fillRect(0, 0, 18, 18);
                      let _src = '';
                      Object.defineProperty(c, 'src', {
                        configurable: true,
                        set(v) { _src = v; setImmediate(() => { if (c.onload) c.onload(); }); },
                        get() { return _src; }
                      });
                      c.onload = null; c.onerror = null;
                      return c;
                    }
                  } }]);
                }
              };
            }
          };
        }
      });
      p.allColors = [
        { rgb: [255, 0, 0], code: 'red', name: 'red', hex: '#ff0000' },
        { rgb: [0, 0, 255], code: 'blue', name: 'blue', hex: '#0000ff' }
      ];
      await p.analyze('fake.png');
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      const top = p.data.matches[0];
      ok(`DPR=${dpr} 识别出的主色是占多数面积的 blue`, top && top.code === 'blue',
        top ? top.code + ' 分布=' + JSON.stringify(p.data.matches.map(m => m.code + ':' + m.count)) : null);
      ok(`DPR=${dpr} loading 已结束`, p.data.loading === false);
    }
  }

  // ============================================================
  section('F13 回滚失败时两个版本都留得住');
  {
    // ① 备份键写失败
    const st1 = { history: [{ id: 'current' }], history_bak: { projects: [{ id: 'backup' }] } };
    const { wx } = page('preview', { store: st1 });
    global.wx = wx;
    const st2 = { history: [{ id: 'current' }], history_bak: { projects: [{ id: 'backup' }] } };
    const { wx: wx2 } = page('preview', { store: st2 });
    global.wx = wx2;
    const realSet = wx2.setStorageSync;
    wx2.setStorageSync = (k, v) => { if (k === 'history_bak') throw new Error('test storage full'); realSet(k, v); };
    const res1 = storage.restoreBackup();
    ok('① 备份写失败时返回失败', res1.ok === false, res1);
    ok('① 当前作品没有被覆盖（旧版会丢）', st2.history[0].id === 'current', st2.history);
    ok('① 原备份仍在', st2.history_bak.projects[0].id === 'backup', st2.history_bak);

    // ② 历史键写失败
    const st3 = { history: [{ id: 'current' }], history_bak: { projects: [{ id: 'backup' }] } };
    const { wx: wx3 } = page('preview', { store: st3 });
    global.wx = wx3;
    const realSet3 = wx3.setStorageSync;
    wx3.setStorageSync = (k, v) => { if (k === 'history') throw new Error('test history write failure'); realSet3(k, v); };
    const res2 = storage.restoreBackup();
    ok('② 历史写失败时返回失败', res2.ok === false, res2);
    ok('② 当前作品仍在', st3.history[0].id === 'current', st3.history);
    ok('② 原备份被恢复回原样（旧版会丢）', st3.history_bak.projects[0].id === 'backup', st3.history_bak);
  }

  // ============================================================
  section('F15 模板色号映射到当前品牌');
  {
    const { p } = initEditor();
    p.applyTemplate({ currentTarget: { dataset: { key: 'heart', name: 'heart' } } });
    const codes = Object.values(p.colorMeta).map(m => m.code);
    ok('模板不再出现 T1 这类自编号码', codes.every(c => !/^T\d+$/.test(c)), codes);
    const palCodes = new Set(loader.getPaletteColors(loader.getCurrentBrand()).map(c => c.code));
    ok('模板色号全部真实存在于当前品牌色卡', codes.every(c => palCodes.has(c)), codes);
    ok('模板带品牌', Object.values(p.colorMeta).every(m => !!m.brandKey));
  }

  // ============================================================
  section('F01 历史数据自动迁移（用户选择"自动迁移修正"）');
  {
    const mardPal = loader.getPaletteColors('mard');
    const red = mardPal.find(c => c.hex === '#D80127') || mardPal[0];
    const white = mardPal.find(c => c.hex === '#FFFFFF') || mardPal[1];
    const broken = {
      id: 'broken-1', brand: 'mard', w: 2, h: 2, grid: [0, 0, 1, 1],
      colors: [
        { id: 0, code: 'C1', short: red.code, name: red.code, hex: red.hex, rgb: red.rgb, count: 2 },
        { id: 1, code: 'C2', short: white.code, name: white.code, hex: white.hex, rgb: white.rgb, count: 2 }
      ]
    };
    const before = JSON.stringify(broken.grid);
    const r = migrate.migrateRecord(clone(broken));
    ok('迁移报告有变更', r.changed === true, r);
    eq('色号已修正为真实色号', r.rec.colors.map(c => c.code), [red.code, white.code]);
    eq('grid 完全没被动过', JSON.stringify(r.rec.grid), before);
    eq('品牌保留', r.rec.brand, 'mard');

    // 已经正确的记录不应被改动
    const fine = {
      id: 'fine', brand: 'mard', w: 1, h: 1, grid: [0],
      colors: [{ id: 0, code: red.code, short: red.short, name: red.name, hex: red.hex, rgb: red.rgb, count: 1 }]
    };
    const r2 = migrate.migrateRecord(clone(fine));
    ok('正确的记录不被无谓改写', r2.changed === false, r2);

    // 没有 brand 的老记录：按色值推定品牌
    const noBrand = {
      id: 'nobrand', w: 2, h: 1, grid: [0, 0],
      colors: [
        { id: 0, code: 'C1', short: 'C1', name: '', hex: red.hex, rgb: red.rgb, count: 1 },
        { id: 1, code: 'C2', short: 'C2', name: '', hex: white.hex, rgb: white.rgb, count: 1 }
      ]
    };
    const r3 = migrate.migrateRecord(clone(noBrand));
    eq('无品牌老记录推定出品牌', r3.rec.brand, 'mard');
    eq('并按品牌修正了色号', r3.rec.colors.map(c => c.code), [red.code, white.code]);

    // 完全判不出来时不猜
    const alien = {
      id: 'alien', w: 1, h: 1, grid: [0],
      colors: [{ id: 0, code: 'C1', short: 'C1', name: '', hex: '#010203', rgb: [1, 2, 3], count: 1 }]
    };
    const r4 = migrate.migrateRecord(clone(alien));
    ok('判不出品牌时标记 brandUnknown，不冒充默认品牌',
      r4.rec.brandUnknown === true && !r4.rec.brand, { brand: r4.rec.brand, unknown: r4.rec.brandUnknown });

    // 关键：MARD 真的有一个色号就叫 C1（#E8FFE7），位置编号会撞上合法色号。
    // 迁移必须靠 hex 判定，不能被色号字符串骗到。
    const mardC1 = mardPal.find(c => c.code === 'C1');
    ok('确认 MARD 存在 code=C1 的真实色号（撞车前提）', !!mardC1, mardC1 && mardC1.hex);
    const alienC1 = {
      id: 'alien-c1', w: 2, h: 1, grid: [0, 0],
      colors: [
        { id: 0, code: 'C1', short: 'C1', name: '', hex: '#010203', rgb: [1, 2, 3], count: 1 },
        { id: 1, code: 'C2', short: 'C2', name: '', hex: '#040506', rgb: [4, 5, 6], count: 1 }
      ]
    };
    const r5 = migrate.migrateRecord(clone(alienC1));
    ok('短码形如 C1/C2 但色值不属于任何色板时，不误判成 MARD',
      r5.rec.brandUnknown === true && !r5.rec.brand, { brand: r5.rec.brand });

    // 单一颜色的老记录：判不出就不判
    const oneColor = {
      id: 'one', w: 1, h: 1, grid: [0],
      colors: [{ id: 0, code: 'C1', short: 'C1', name: '', hex: '#FFFFFF', rgb: [255, 255, 255], count: 1 }]
    };
    const r6 = migrate.migrateRecord(clone(oneColor));
    ok('只有 1 种颜色时不猜品牌（共享色值无法区分）',
      r6.rec.brandUnknown === true, { brand: r6.rec.brand });

    // 多品牌上线之前的老图纸用的是通用色板，应当被认出来
    const genericPal = loader.getPaletteColors(loader.GENERIC_KEY);
    const oldGeneric = {
      id: 'old-generic', w: 3, h: 1, grid: [0, 1, 2],
      colors: genericPal.slice(0, 3).map((c, i) => ({
        id: i, code: 'C' + (i + 1), short: 'C' + (i + 1), name: '', hex: c.hex, rgb: c.rgb, count: 1
      }))
    };
    const r7 = migrate.migrateRecord(clone(oldGeneric));
    eq('老图纸被认成通用色板', r7.rec.brand, loader.GENERIC_KEY);
    eq('并按通用色板的真实 id 修正色号', r7.rec.colors.map(c => c.code), genericPal.slice(0, 3).map(c => c.code));

    // storage 读取路径也要走迁移
    const st = { history: [clone(broken)] };
    const { wx } = page('preview', { store: st });
    global.wx = wx;
    delete require.cache[requireSrc.resolve('./utils/storage.js')];
    const st2 = requireSrc('./utils/storage.js');
    const got = st2.getHistory();
    eq('storage.getHistory() 返回的已是修正后的色号', got[0].colors.map(c => c.code), [red.code, white.code]);
  }

  // ============================================================
  section('F16 云端备份写入带归属身份、拉取能取回');
  {
    let docs = [], seq = 0;
    const coll = {
      where(q) {
        const key = Object.keys(q)[0];
        return { limit() { return { get: async () => ({ data: docs.filter(d => d[key] === q[key]).slice(0, 1) }) }; } };
      },
      add: async ({ data }) => { docs.push(Object.assign({ _id: String(++seq) }, data)); },
      doc(id) { return { update: async ({ data }) => { Object.assign(docs.find(d => d._id === id), data); } }; }
    };
    const cloud = {
      init() {}, DYNAMIC_CURRENT_ENV: 'test',
      getWXContext: () => ({ OPENID: 'test-user' }),
      database: () => ({ collection: () => coll })
    };
    const sandbox = { exports: {}, require: () => cloud, console: silent };
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'cloudfunctions/syncHistory/index.js'), 'utf8'), sandbox);
    const fn = sandbox.exports.main;

    const up1 = await fn({ action: 'upload', projects: [{ id: 'a' }] });
    const pull1 = await fn({ action: 'pull' });
    await fn({ action: 'upload', projects: [{ id: 'a' }, { id: 'b' }] });
    ok('首次上传成功', up1.ok === true, up1);
    ok('上传后立刻能拉回（旧版这里返回空）', pull1.projects.length === 1, pull1);
    eq('拉回的内容就是上传的内容', pull1.projects, [{ id: 'a' }]);
    eq('重复上传不新增记录（旧版会堆）', docs.length, 1);
    eq('记录上带有服务端写入的归属字段', Object.keys(docs[0]).sort(), ['_id', 'count', 'ownerOpenId', 'projects', 'updatedAt'].sort());
    eq('归属字段取自 getWXContext', docs[0].ownerOpenId, 'test-user');

    // 非法输入
    const bad = await fn({ action: 'upload', projects: 'oops' });
    ok('projects 非数组被拒绝', bad.ok === false && bad.code === -4, bad);
    const unknown = await fn({ action: 'nope' });
    ok('未知 action 被拒绝', unknown.ok === false && unknown.code === -2, unknown);

    // 客户端伪造身份无效
    const spoof = await fn({ action: 'upload', ownerOpenId: 'someone-else', _openid: 'someone-else', projects: [{ id: 'x' }] });
    ok('客户端传入的身份字段被忽略', spoof.ok === true && docs[0].ownerOpenId === 'test-user', docs[0].ownerOpenId);
  }

  console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  if (fail > 0) process.exit(1);
})();
