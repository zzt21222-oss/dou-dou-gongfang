// verification/brands_offline_test.js
// 多品牌色号体系的离线验证：数据完整性 / 加载器行为 / 色号转换 / 映射等价性与性能。
//
// 运行：node verification/brands_offline_test.js
//
// 这些断言挡的是「肉眼很难发现」的问题：色号重复、短码过长印爆格子、
// 转换后图案走样、缓存版映射器与权威函数结果不一致。

const path = require('path');
const ROOT = path.join(__dirname, '..');
const brandsData = require(path.join(ROOT, 'data/brands.js'));
const paletteLoader = require(path.join(ROOT, 'utils/paletteLoader.js'));
const brandConvert = require(path.join(ROOT, 'utils/brandConvert.js'));
const m2p = require(path.join(ROOT, 'utils/mapToPalette.js'));
const render = require(path.join(ROOT, 'utils/render.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), { got: got, want: want }); }

function rnd(n) { return Math.floor(Math.random() * n); }
function makePixels(n, src) {
  const px = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = src[rnd(src.length)];
    px[i * 3] = Math.max(0, Math.min(255, c.r + rnd(90) - 45));
    px[i * 3 + 1] = Math.max(0, Math.min(255, c.g + rnd(90) - 45));
    px[i * 3 + 2] = Math.max(0, Math.min(255, c.b + rnd(90) - 45));
  }
  return px;
}

// ---------- 1. 数据完整性 ----------
console.log('\n[1] 品牌色板数据完整性');
const EXPECT_COUNT = { mard: 291, artkal_c: 174, artkal_s: 199, hama: 92, perler: 103 };
ok('品牌数量为 5', brandsData.BRANDS.length === 5, brandsData.BRANDS.length);
ok('默认品牌为 mard', brandsData.DEFAULT_BRAND === 'mard', brandsData.DEFAULT_BRAND);

brandsData.BRANDS.forEach(function (b) {
  const n = EXPECT_COUNT[b.key];
  if (n) eq(b.name + ' 色数', b.colors.length, n);

  const codes = {}, shorts = {};
  let dupCode = null, dupShort = null, badHex = null, longShort = null;
  b.colors.forEach(function (c) {
    if (codes[c.code]) dupCode = c.code; else codes[c.code] = true;
    if (shorts[c.short]) dupShort = c.short; else shorts[c.short] = true;
    if (!/^#[0-9A-F]{6}$/.test(c.hex)) badHex = c.code + '=' + c.hex;
    if (String(c.short).length > 5) longShort = c.code + '->' + c.short;
  });
  ok(b.name + ' 色号唯一', dupCode === null, dupCode);
  ok(b.name + ' 短码唯一', dupShort === null, dupShort);
  ok(b.name + ' hex 规整', badHex === null, badHex);
  ok(b.name + ' 短码不超 5 字符', longShort === null, longShort);
  ok(b.name + ' 每项都有 short', b.colors.every(function (c) { return !!c.short; }));
});

// ---------- 2. 加载器行为 ----------
console.log('\n[2] paletteLoader 行为');
eq('默认品牌', paletteLoader.getDefaultBrand(), 'mard');
eq('品牌清单含通用色板', paletteLoader.getBrandList().length, 6);

const mard = paletteLoader.getPaletteColors('mard');
ok('返回项字段齐备', !!(mard[0].id && mard[0].hex && mard[0].rgb && mard[0].short && mard[0].r != null));
eq('rgb 与 hex 一致', mard[0].rgb, [parseInt(mard[0].hex.substr(1, 2), 16), parseInt(mard[0].hex.substr(3, 2), 16), parseInt(mard[0].hex.substr(5, 2), 16)]);

eq('切换品牌生效', paletteLoader.setCurrentBrand('hama'), 'hama');
eq('不传参时跟随当前品牌', paletteLoader.getPaletteColors().length, 92);
eq('显式指定优先于当前品牌', paletteLoader.getPaletteColors('mard').length, 291);
eq('未知品牌回退到默认', paletteLoader.getPaletteColors('no-such').length, 291);
eq('通用色板保留 56 色', paletteLoader.getPaletteColors('generic').length, 56);
ok('同一品牌复用同一数组引用（缓存器的前提）', paletteLoader.getPaletteColors('mard') === paletteLoader.getPaletteColors('mard'));
paletteLoader.setCurrentBrand('mard');

// ---------- 3. 色号转换 ----------
console.log('\n[3] 色号转换（换品牌不改图案）');
const srcPal = paletteLoader.getPaletteColors('mard');
const W = 6, H = 4;
const colorMeta = {};
// 取 MARD 前 4 个颜色铺满 4 块区域，另留一格形状外(-1)
const useIds = [0, 1, 2, 3];
useIds.forEach(function (i) {
  const c = srcPal[i];
  colorMeta[i] = { rgb: c.rgb, code: c.id, name: c.name, hex: c.hex, short: c.short };
});
const grid = new Int32Array(W * H);
for (let i = 0; i < grid.length; i++) grid[i] = useIds[i % 4];
grid[5] = -1;

const res = brandConvert.convert({ grid: grid, colorMeta: colorMeta, toBrand: 'hama' });
ok('转换成功', res.ok === true, res.reason);
eq('网格长度不变', res.grid.length, grid.length);
eq('形状外(-1)保持不变', res.grid[5], -1);

const hama = paletteLoader.getPaletteColors('hama');
let allValid = true, allMatch = true;
for (let i = 0; i < res.grid.length; i++) {
  const v = res.grid[i];
  if (v < 0) continue;
  if (!(v >= 0 && v < hama.length)) { allValid = false; break; }
  const m = res.colorMeta[v];
  if (!m || m.hex !== hama[v].hex) { allMatch = false; break; }
}
ok('转换后下标都在目标色板范围内', allValid);
ok('colorMeta 与下标严格对应', allMatch);

// 每个格子换算后的颜色，应该就是原色在 Hama 里最接近的那颗
const mapHama = m2p.createMapper(hama);
let consistent = true;
for (let i = 0; i < grid.length; i++) {
  if (grid[i] < 0) continue;
  const src = colorMeta[grid[i]];
  const expect = mapHama(src.rgb[0], src.rgb[1], src.rgb[2]);
  if (res.grid[i] !== expect) { consistent = false; break; }
}
ok('逐格结果 = 原色在目标品牌中的最近色', consistent);

ok('颜色种数只减不增', res.after <= res.before, { before: res.before, after: res.after });
eq('合并数与种数一致', res.merged, res.before - res.after);
eq('目标品牌名回传正确', res.brandName, 'Hama');

// 转回通用色板也要能work（老图纸场景）
const back = brandConvert.convert({ grid: res.grid, colorMeta: res.colorMeta, toBrand: 'generic' });
ok('可再转回其它品牌', back.ok === true);
ok('不可用品牌返回明确失败', brandConvert.convert({ grid: grid, colorMeta: colorMeta, toBrand: 'no-such' }).ok === false);

// ---------- 4. 映射等价性（缓存版 vs 权威函数） ----------
console.log('\n[4] 映射等价性（缓存版必须与 mapToPalette 结果一致）');
const mapper = m2p.createMapper(srcPal);
let same = true, checked = 0, firstBad = null;
for (let t = 0; t < 4000; t++) {
  const r = rnd(256), g = rnd(256), b = rnd(256);
  const fastIdx = mapper(r, g, b);
  const slowObj = m2p.mapToPalette(srcPal, r, g, b);
  const slowIdx = srcPal.indexOf(slowObj);
  checked++;
  if (fastIdx !== slowIdx) { same = false; firstBad = { rgb: [r, g, b], fast: srcPal[fastIdx].id, slow: slowObj.id }; break; }
}
ok('4000 组随机色结果完全一致', same, firstBad);
eq('校验样本数', checked, 4000);

// 记忆化确实生效：同一批颜色再跑一次应该更快
const px = makePixels(20000, srcPal);
function runMapper(pixels, pal) {
  const m = m2p.createMapper(pal);
  const n = pixels.length / 3;
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = m(pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]);
  return out;
}
function runNaive(pixels, pal) {
  const n = pixels.length / 3;
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = m2p.mapToPalette(pal, pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]);
    out[i] = pal.indexOf(c);
  }
  return out;
}

// ---------- 5. 性能 ----------
console.log('\n[5] 映射性能（20000 像素）');
function timeIt(fn) { const t0 = Date.now(); const r = fn(); return { ms: Date.now() - t0, r: r }; }

const n56 = paletteLoader.getPaletteColors('generic');
const tNaive56 = timeIt(function () { return runNaive(px, n56); });
const tFast56 = timeIt(function () { return runMapper(px, n56); });
const tNaive291 = timeIt(function () { return runNaive(px, srcPal); });
const tFast291 = timeIt(function () { return runMapper(px, srcPal); });

console.log('      56 色   旧写法 ' + tNaive56.ms + ' ms   缓存版 ' + tFast56.ms + ' ms');
console.log('      291 色  旧写法 ' + tNaive291.ms + ' ms   缓存版 ' + tFast291.ms + ' ms');

ok('缓存版快于旧写法（56 色）', tFast56.ms <= tNaive56.ms, { fast: tFast56.ms, naive: tNaive56.ms });
ok('缓存版快于旧写法（291 色）', tFast291.ms < tNaive291.ms, { fast: tFast291.ms, naive: tNaive291.ms });
ok('291 色缓存版没有明显慢于 56 色旧写法',
  tFast291.ms <= tNaive56.ms * 2 + 20, { fast291: tFast291.ms, naive56: tNaive56.ms });
// 结果一致性
const a1 = runMapper(px, srcPal), a2 = runNaive(px, srcPal);
let sameLabels = true;
for (let i = 0; i < a1.length; i++) { if (a1[i] !== a2[i]) { sameLabels = false; break; } }
ok('整幅像素两种写法结果一致', sameLabels);

// ---------- 6. 渲染端使用短码 ----------
console.log('\n[6] 格内标注使用短码（长 SKU 印不下）');
function fakeCtx() {
  const texts = [];
  return {
    texts: texts,
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    fillRect: function () {}, strokeRect: function () {}, beginPath: function () {},
    moveTo: function () {}, lineTo: function () {}, stroke: function () {},
    clip: function () {}, save: function () {}, restore: function () {},
    fillText: function (t, x, y) { texts.push({ text: String(t), x: x, y: y }); }
  };
}
const perler = paletteLoader.getPaletteColors('perler');
const perlerMeta = {};
perlerMeta[0] = { rgb: perler[0].rgb, code: perler[0].id, short: perler[0].short, hex: perler[0].hex };
const oneGrid = new Int32Array([0]);
const ctx = fakeCtx();
render.drawGrid(ctx, {
  grid: oneGrid, w: 1, h: 1, cell: 30, offX: 0, offY: 0,
  colorMeta: perlerMeta, mode: 'pixel', showCode: true
});
eq('格内印的是短码而不是长 SKU', ctx.texts.map(function (t) { return t.text; }), [perler[0].short]);
ok('短码确实比完整色号短', perler[0].short.length < perler[0].id.length, { short: perler[0].short, code: perler[0].id });

// ---------- 结果 ----------
console.log('\n=== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail === 0 ? 0 : 1);
