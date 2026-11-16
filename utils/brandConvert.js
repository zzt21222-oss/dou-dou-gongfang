// utils/brandConvert.js
// 品牌色号转换：把一张图纸的配色按「就近色」换算成另一个品牌的色号。
//
// 用途：用户用 MARD 做好的图，手里只有 Hama 的豆子 → 一键换成 Hama 色号去买。
//
// 原则：**图案不变，只换色号。**
//   - 图纸上每一种颜色，都映射到目标品牌里最接近的那颗豆子；
//   - 若两种旧颜色落到同一颗新豆子，会自动合并（材料清单随之变少）；
//   - 形状外的格子（-1）始终保持不拼。

const paletteLoader = require('./paletteLoader.js');
const { createMapper } = require('./mapToPalette.js');

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16) || 0,
    parseInt(h.substring(2, 4), 16) || 0,
    parseInt(h.substring(4, 6), 16) || 0
  ];
}

// opts: { grid, colorMeta, toBrand }
//   grid      当前网格（下标数组，-1 = 形状外不拼）
//   colorMeta { [下标]: { rgb | hex, code, name } }
//   toBrand   目标品牌 key
// 返回 { ok:true, grid, colorMeta, brand, brandName, before, after, merged }
//   或 { ok:false, reason }
function convert(opts) {
  const toBrand = opts && opts.toBrand;
  // 品牌必须先真实存在：getPaletteColors 对未知 key 会回退到默认品牌，
  // 直接使用会把「换成 X」静默变成「其实换成了 MARD」。
  const def = toBrand ? paletteLoader.getBrand(toBrand) : null;
  if (!def) return { ok: false, reason: '未知品牌：' + toBrand };
  const palette = paletteLoader.getPaletteColors(def.key);
  if (!palette || !palette.length) {
    return { ok: false, reason: '目标品牌色板为空' };
  }
  const info = paletteLoader.getPaletteInfo(def.key);
  const src = opts.grid || [];
  const srcMeta = opts.colorMeta || {};

  const map = createMapper(palette);

  // 旧下标 -> 新下标
  const remap = {};
  Object.keys(srcMeta).forEach(function (k) {
    const m = srcMeta[k] || {};
    const rgb = m.rgb || hexToRgb(m.hex);
    remap[k] = map(rgb[0], rgb[1], rgb[2]);
  });

  const grid = new Int32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v < 0) { grid[i] = -1; continue; }
    const nv = remap[v];
    grid[i] = nv == null ? v : nv;
  }

  // 统计转换前后实际用到的颜色种数
  const usedBefore = {};
  for (let i = 0; i < src.length; i++) { if (src[i] >= 0) usedBefore[src[i]] = true; }
  const usedAfter = {};
  for (let i = 0; i < grid.length; i++) { if (grid[i] >= 0) usedAfter[grid[i]] = true; }

  const colorMeta = {};
  Object.keys(usedAfter).forEach(function (k) {
    const c = palette[k];
    if (c) {
      colorMeta[k] = {
        rgb: c.rgb,
        code: c.code || c.id,
        brandKey: def.key,
        name: c.name,
        hex: c.hex,
        short: c.short || c.code || c.id
      };
    }
  });

  const before = Object.keys(usedBefore).length;
  const after = Object.keys(colorMeta).length;

  return {
    ok: true,
    grid: grid,
    colorMeta: colorMeta,
    remap: remap,
    brand: info.key,
    brandName: info.brandName,
    before: before,
    after: after,
    merged: Math.max(0, before - after)
  };
}

// 作品级换品牌：**以权威网格为准**，一次把整件作品换算干净。
//
// 为什么必须有这个函数（复核报告 S1）：convert() 只认它收到的那个网格，
// 而 colorMeta 是**按输入网格实际引用到的颜色**生成的。预览页当时传的是
// 已经做过形状掩膜的可见 grid，于是形状外那些颜色既没进新的 colorMeta、
// 也没进 remap，但存进历史的 fullGrid 还是旧下标 —— 重新打开切回矩形，
// 那些下标就取不到颜色项，绘图直接抛 reading 'rgb'。
// 编辑器早先踩过同一个坑（审查 F06b），两边各写一遍就必然会再偏一次，
// 所以统一到这里：传 fullGrid（没有就退回 grid）、可见网格、locked，
// 一次算出互相自洽的四样东西。
//
// opts: { fullGrid, grid, colorMeta, locked, toBrand }
// 返回 { ok, fullGrid, grid, colorMeta, locked, remap, brand, brandName, merged }
function convertWork(opts) {
  opts = opts || {};
  const src = (opts.fullGrid && opts.fullGrid.length) ? opts.fullGrid : opts.grid;
  if (!src || !src.length || !opts.colorMeta) {
    return { ok: false, reason: '没有可换算的网格' };
  }
  const r = convert({ grid: src, colorMeta: opts.colorMeta, toBrand: opts.toBrand });
  if (!r.ok) return r;

  const remap = r.remap;
  // 可见网格用**同一张 remap** 过一遍：这样 grid 与 fullGrid 的对应关系
  // （可见处相等、被藏处为负）在换算后依然成立。
  const mapArr = function (arr) {
    if (!arr || !arr.length) return arr;
    const out = new Int32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      out[i] = v < 0 ? v : (remap[v] != null ? remap[v] : v);
    }
    return out;
  };
  // 锁定色按下标存储，换算后下标换了，跟着重排
  const oldLocked = opts.locked || {};
  const locked = {};
  Object.keys(oldLocked).forEach(function (k) {
    if (!oldLocked[k]) return;
    const nv = remap[k];
    if (nv != null) locked[nv] = true;
  });

  return {
    ok: true,
    fullGrid: r.grid,
    grid: mapArr(opts.grid),
    colorMeta: r.colorMeta,
    locked: locked,
    remap: remap,
    brand: r.brand,
    brandName: r.brandName,
    before: r.before,
    after: r.after,
    merged: r.merged
  };
}

module.exports = { convert: convert, convertWork: convertWork, hexToRgb: hexToRgb };
