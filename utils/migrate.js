// utils/migrate.js
// 历史记录 / 草稿的自动迁移：修正上一版「色号字段错配」留下的错误色号。
//
// 背景（2026-09-19 第三方源码审查 F01 确认）：
//   paletteLoader 曾把品牌色号只放在 id 字段上，而 bead.finalize() 读的是 code。
//   读不到 code 就静默回退成位置编号 'C' + (序号)，于是记录里出现
//       { code: 'C1', short: 'F5', hex: '#D80127', name: 'F5' }
//   同一个颜色两个编号，而且错的那个正好是用户照着采购的那一栏。
//
// 为什么可以安全地自动修正：
//   色值（hex / rgb）从来没有被写错 —— 它就是色卡里那颗豆子的色值。
//   所以用 hex 回到色卡里查，得到的必然是同一个颜色，只是拿回它真正的色号。
//   整个过程**只改颜色元数据，绝不动 grid**，因此图案形状与用豆颗数完全不变。
//
// 迁移规则：
//   1) 品牌：记录自带且有效就用它；否则先从「短码命中率」判，再从「hex 命中率」判
//      （两者都要 ≥0.6 才认）。都判不出来就标 brandUnknown，不猜。
//   2) 色号：按 hex 在色卡里找同色项，用它的 code / short / name 覆盖。
//      色卡里找不到同 hex（色值被人工改过）且原色号也无效时，用最近色兜底。
//   3) 判不出品牌时保留原样，只打标记，由界面提示用户重新选品牌。

const paletteLoader = require('./paletteLoader.js');

const _hexSets = {};
const _codeSets = {};

// 直接用加载器已缓存的色板数组（它按品牌复用同一引用），不再另存一份，
// 免得两处缓存不同步。
function paletteOf(brandKey) {
  return paletteLoader.getPaletteColors(brandKey) || [];
}

function hexSetOf(brandKey) {
  if (!_hexSets[brandKey]) {
    const pal = paletteOf(brandKey);
    const s = new Set();
    for (let i = 0; i < pal.length; i++) s.add(pal[i].hex);
    _hexSets[brandKey] = s;
  }
  return _hexSets[brandKey];
}

function codeSetOf(brandKey) {
  if (!_codeSets[brandKey]) {
    const pal = paletteOf(brandKey);
    const s = new Set();
    for (let i = 0; i < pal.length; i++) s.add(String(pal[i].code));
    _codeSets[brandKey] = s;
  }
  return _codeSets[brandKey];
}

// 迁移在每次 getHistory() 时都会跑，所以缓存必须能在换品牌后失效
function resetCache() {
  Object.keys(_hexSets).forEach(function (k) { delete _hexSets[k]; });
  Object.keys(_codeSets).forEach(function (k) { delete _codeSets[k]; });
}

function hexOf(m) {
  const h = String((m && m.hex) || '').replace('#', '').toUpperCase();
  if (h.length === 6) return '#' + h;
  const rgb = m && m.rgb;
  if (rgb && rgb.length === 3) {
    let out = '#';
    for (let i = 0; i < 3; i++) {
      const s = Number(rgb[i] || 0).toString(16).toUpperCase();
      out += s.length === 1 ? '0' + s : s;
    }
    return out;
  }
  return '';
}

function rgbOfHex(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return null;
  return [
    parseInt(h.substring(0, 2), 16) || 0,
    parseInt(h.substring(2, 4), 16) || 0,
    parseInt(h.substring(4, 6), 16) || 0
  ];
}

// 与 mapToPalette 一致的 redmean 距离（这里只是迁移兜底，量很小）
function redmean(r, g, b, c) {
  const rm = (r + c.r) / 2;
  const dr = r - c.r, dg = g - c.g, db = b - c.b;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
}

function nearestIn(pal, rgb) {
  let best = null, bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const d = redmean(rgb[0], rgb[1], rgb[2], pal[i]);
    if (d < bd) { bd = d; best = pal[i]; }
  }
  return best;
}

// 取出一条记录里所有的颜色元数据（历史用 colors 数组，草稿用 colorMeta 对象）
function collectMetas(rec) {
  const out = [];
  if (rec && Array.isArray(rec.colors)) {
    rec.colors.forEach(function (m) { if (m) out.push(m); });
  }
  if (rec && rec.colorMeta && typeof rec.colorMeta === 'object') {
    Object.keys(rec.colorMeta).forEach(function (k) { if (rec.colorMeta[k]) out.push(rec.colorMeta[k]); });
  }
  return out;
}

// 品牌判定：**只按 hex 判**，绝不按色号字符串判。
//
// 为什么不能用色号：位置编号 'C1'/'C2' 会撞上真实色号 —— MARD 色卡里
// 真的有 29 个 "C+数字" 形态的合法色号（C1 = #E8FFE7 等）。拿一个短码为
// C1/C2/C3 的旧图纸去比对，MARD 的命中率会是 100%，直接误判成 MARD ——
// 这正是审查报告提醒的"C1 偶尔可能恰好也是某品牌的合法色号，不能代表匹配结果"。
//
// 而 hex 从来没错过：它就是色卡里那颗豆子的色值，且各品牌色卡之间几乎不重叠
// （通用色板与 MARD 的交集只有 1/56），所以按 hex 命中率判定既准又稳。
//
// 样本太少时不猜：只有 1 种颜色时，很多色板都可能有这个色值，判不出就交给用户手选。
const MIN_SAMPLE = 2;

function inferBrand(metas) {
  const list = paletteLoader.getBrandList();
  if (!list.length) return '';
  const hexes = [];
  metas.forEach(function (m) { const v = hexOf(m); if (v) hexes.push(v); });
  if (hexes.length < MIN_SAMPLE) return '';

  const rows = list.map(function (b) {
    const set = hexSetOf(b.key);
    let hit = 0;
    hexes.forEach(function (h) { if (set.has(h)) hit++; });
    return { key: b.key, rate: hit / hexes.length, hit: hit };
  }).sort(function (a, b) { return b.rate - a.rate || b.hit - a.hit; });

  const win = rows[0], second = rows[1];
  if (!win || win.rate < 0.6) return '';
  // 必须"明显胜出"：与第二名同分时说明样本落在共享色值上，宁可不判
  if (second && second.rate >= win.rate) return '';
  return win.key;
}

// 把一条颜色元数据统一到某个目标色的 code/short/hex/rgb/name 上。
// 关键：**五个字段必须同源**。旧版只在字段缺失时才补 rgb，
// 于是出现「色号已换成目标色卡的、rgb 还是旧颜色」的同一颜色两个值 ——
// 画布按 rgb 上色、图例与采购清单按 code 标注，两边不一致（复核 R7）。
// 原色如确实与目标色不同，存进 sourceColor 留档（不进图例、不影响绘制）。
function alignTo(out, pc, brand) {
  const prevRgb = out.rgb;
  const prevHex = out.hex;
  const moved = !!(pc.rgb && prevRgb && (prevRgb[0] !== pc.rgb[0] ||
    prevRgb[1] !== pc.rgb[1] || prevRgb[2] !== pc.rgb[2]));
  if (moved && !out.sourceColor) {
    out.sourceColor = { rgb: prevRgb, hex: prevHex || '' };
  }
  out.code = pc.code;
  out.short = pc.short || pc.code;
  out.brandKey = brand;
  out.name = pc.name || pc.code;
  out.hex = pc.hex;
  out.rgb = pc.rgb;
  return out;
}

// 色卡里没有这个色值、原色号又仍然有效时：不动色号，但 rgb/hex 必须自洽。
// 否则渲染（读 rgb）与标注（读 hex）会各说各话。
function alignSelf(out) {
  const hex = hexOf(out);
  const fromHex = hex ? rgbOfHex(hex) : null;
  if (!fromHex) return out;
  const cur = out.rgb;
  if (!cur || cur[0] !== fromHex[0] || cur[1] !== fromHex[1] || cur[2] !== fromHex[2]) {
    if (!out.sourceColor && cur) out.sourceColor = { rgb: cur, hex: out.hex || '' };
    out.rgb = fromHex;
    out.hex = hex;
  }
  return out;
}

function fixOne(m, brand, pal, byHex, codes) {
  if (!m || typeof m !== 'object') return { m: m, changed: false };
  const out = Object.assign({}, m);
  const hex = hexOf(out);
  const exact = hex ? byHex[hex] : null;

  if (exact) {
    const changed = String(out.code || '') !== String(exact.code) ||
      !!(out.rgb && (!exact.rgb || out.rgb[0] !== exact.rgb[0] ||
        out.rgb[1] !== exact.rgb[1] || out.rgb[2] !== exact.rgb[2])) ||
      out.hex !== exact.hex;
    alignTo(out, exact, brand);
    return { m: out, changed: changed };
  }

  // 色卡里没有同 hex 的色（色值被人为改过）：原色号还有效就原样留着
  if (out.code && codes.has(String(out.code))) {
    const before = out.rgb;
    alignSelf(out);
    const moved = before !== out.rgb;
    const changed = out.brandKey !== brand || moved;
    out.brandKey = brand;
    return { m: out, changed: changed };
  }

  // 原色号无效（就是被回退写坏的 'C1' 之类）→ 用最近色兜底
  const rgb = (out.rgb && out.rgb.length === 3) ? out.rgb : rgbOfHex(hex);
  if (!rgb) return { m: m, changed: false };
  const near = nearestIn(pal, rgb);
  if (!near) return { m: m, changed: false };
  // 兜底色用的是「旧 rgb 的最近色」，所以旧 rgb 就是原色，先留档再对齐
  if (out.rgb && !out.sourceColor) out.sourceColor = { rgb: out.rgb, hex: out.hex || '' };
  alignTo(out, near, brand);
  return { m: out, changed: true };
}

// 返回 { rec, changed, notes }
//   changed=false 时返回的是原对象（不产生额外分配，getHistory 可以放心每次调用）
function migrateRecord(rec) {
  if (!rec || typeof rec !== 'object') return { rec: rec, changed: false, notes: [] };
  const metas = collectMetas(rec);
  if (!metas.length) return { rec: rec, changed: false, notes: [] };

  const notes = [];
  let brand = rec.brand || '';
  if (brand && !paletteLoader.getBrand(brand)) brand = '';
  let brandChanged = false;
  if (!brand) {
    brand = inferBrand(metas);
    if (brand) {
      brandChanged = true;
      const info = paletteLoader.getPaletteInfo(brand);
      notes.push('已按色号推定品牌：' + (info.brandName || brand));
    }
  }

  if (!brand) {
    // 判不出来就不猜，只在界面上说明，避免把别的品牌的色号冒充成默认品牌
    if (rec.brandUnknown) return { rec: rec, changed: false, notes: [] };
    const marked = Object.assign({}, rec, { brandUnknown: true });
    notes.push('无法判定色号系统，已标记为未知');
    return { rec: marked, changed: true, notes: notes };
  }

  const pal = paletteOf(brand);
  const codes = codeSetOf(brand);
  const byHex = {};
  for (let i = 0; i < pal.length; i++) { if (!byHex[pal[i].hex]) byHex[pal[i].hex] = pal[i]; }

  let repaired = 0;
  const out = Object.assign({}, rec);
  out.brand = brand;
  if (rec.brandUnknown) delete out.brandUnknown;

  if (Array.isArray(rec.colors) && rec.colors.length) {
    out.colors = rec.colors.map(function (m) {
      const r = fixOne(m, brand, pal, byHex, codes);
      if (r.changed) repaired++;
      return r.m;
    });
  }
  if (rec.colorMeta && typeof rec.colorMeta === 'object') {
    const cm = {};
    Object.keys(rec.colorMeta).forEach(function (k) {
      const r = fixOne(rec.colorMeta[k], brand, pal, byHex, codes);
      if (r.changed) repaired++;
      cm[k] = r.m;
    });
    out.colorMeta = cm;
  }

  const changed = brandChanged || repaired > 0 || !!rec.brandUnknown;
  if (repaired > 0) notes.push('已修正 ' + repaired + ' 个色号');
  return { rec: changed ? out : rec, changed: changed, notes: notes };
}

// 列表级迁移：任一条都不需要改时，原样返回整个数组（避免无谓的分配与拷贝）
function migrateList(list) {
  if (!Array.isArray(list) || !list.length) return Array.isArray(list) ? list : [];
  let anyChanged = false;
  const out = list.map(function (r) {
    const res = migrateRecord(r);
    if (res.changed) anyChanged = true;
    return res.rec;
  });
  return anyChanged ? out : list;
}

module.exports = {
  migrateRecord: migrateRecord,
  migrateList: migrateList,
  inferBrand: inferBrand,
  hexOf: hexOf,
  resetCache: resetCache
};
