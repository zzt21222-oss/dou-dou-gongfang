// utils/paletteLoader.js
// 色板加载器：小程序里所有「颜色映射」的唯一数据源。
//
// 支持多品牌真实色号（data/brands.js，由 tools/gen_brands.py 从社区色卡库生成），
// 并保留内置的通用色板（data/colorPalette.js，C01–C56）作为 'generic' 选项，
// 使老图纸、老用户升级后仍能正常打开。
//
// 用法：
//   paletteLoader.getPaletteColors()          // 当前品牌色板
//   paletteLoader.getPaletteColors('hama')    // 指定品牌
//   paletteLoader.getBrandList()              // 可选品牌清单
//   paletteLoader.setCurrentBrand('mard')     // 切换当前品牌
//   paletteLoader.getPaletteInfo('hama')      // { key, brandName, size, count }
//
// 返回的每项：{ id, code, brandKey, name, hex, short, rgb, r, g, b }
//   id / code 品牌色号（两者同值：code 是领域字段，id 为兼容旧代码保留）
//   brandKey  该色板所属品牌
//   short     格内标注用短码（Perler 的长 SKU 会被截断）
//
// ! 绝不能只给 id 不给 code：bead.finalize() 读的是 code，缺 code 会静默
//   回退成位置编号 'C1'/'C2'，于是格内印真实色号、材料清单印位置编号，
//   用户照着清单买就买错（2026-09-19 审查 F01）。
//
// 注意：同一品牌的色板数组会被缓存并复用同一个引用 —— bead.js 依赖这个引用
// 复用它的记忆化映射器，反复切品牌也不会重建缓存。

const brandsData = require('../data/brands.js');

const GENERIC_KEY = 'generic';
const GENERIC_NAME = '通用色板';

let _current = null;
let _defs = null;
const _cache = {};

function parseHex(hex) {
  const h = String(hex || '').replace('#', '');
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return { hex: '#' + h.toUpperCase(), rgb: [r, g, b], r: r, g: g, b: b };
}

// 全部品牌定义（真实品牌 + 内置通用色板）
function defs() {
  if (_defs) return _defs;
  const list = (brandsData.BRANDS || []).map(function (b) {
    return {
      key: b.key,
      name: b.name,
      size: b.size || '',
      colors: (b.colors || []).map(function (c) {
        return {
          code: c.code,
          name: c.name || c.code,
          hex: c.hex,
          short: c.short || c.code
        };
      })
    };
  });
  const generic = require('../data/colorPalette.js');
  list.push({
    key: GENERIC_KEY,
    name: GENERIC_NAME,
    size: '不分品牌',
    colors: (generic || []).map(function (c) {
      return {
        code: c.id,
        name: c.name || c.id,
        hex: c.hex,
        short: c.id
      };
    })
  });
  _defs = list;
  return _defs;
}

function getBrandList() {
  return defs().map(function (b) {
    return { key: b.key, name: b.name, size: b.size, count: b.colors.length };
  });
}

function getBrand(key) {
  const k = key == null ? '' : String(key);
  const all = defs();
  for (let i = 0; i < all.length; i++) {
    if (all[i].key === k) return all[i];
  }
  return null;
}

function getDefaultBrand() {
  if (getBrand(brandsData.DEFAULT_BRAND)) return brandsData.DEFAULT_BRAND;
  const all = defs();
  return all.length ? all[0].key : GENERIC_KEY;
}

function setCurrentBrand(key) {
  const b = getBrand(key);
  _current = b ? b.key : getDefaultBrand();
  return _current;
}

function getCurrentBrand() {
  return _current || getDefaultBrand();
}

function getPaletteColors(brandKey) {
  const key = brandKey == null ? getCurrentBrand() : String(brandKey);
  const b = getBrand(key) || getBrand(getDefaultBrand());
  if (!b) return [];
  if (_cache[b.key]) return _cache[b.key];
  const colors = b.colors.map(function (c) {
    const p = parseHex(c.hex);
    return {
      id: c.code,
      code: c.code,
      brandKey: b.key,
      name: c.name,
      hex: p.hex,
      short: c.short || c.code,
      rgb: p.rgb,
      r: p.r,
      g: p.g,
      b: p.b
    };
  });
  _cache[b.key] = colors;
  return colors;
}

// 清空缓存（换品牌或换文件后重新加载）
function resetCache() {
  Object.keys(_cache).forEach(function (k) { delete _cache[k]; });
  _defs = null;
}

function getPaletteInfo(brandKey) {
  const key = brandKey == null ? getCurrentBrand() : String(brandKey);
  const b = getBrand(key) || getBrand(getDefaultBrand());
  const colors = getPaletteColors(key);
  return {
    key: b ? b.key : key,
    brandName: b ? b.name : '',
    size: b ? b.size : '',
    count: colors.length,
    name: b ? b.name : ''
  };
}

function loadRaw() {
  // 兼容旧接口：返回内置通用色板的原始数据
  try {
    const data = require('../data/colorPalette.js');
    if (data) return data;
  } catch (e) { /* 忽略，返回 null */ }
  return null;
}

function normalize(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw) {
    if (!x || !x.hex) continue;
    const p = parseHex(x.hex);
    const id = String(x.id != null ? x.id : '');
    out.push({
      id: id,
      code: id,
      brandKey: x.brandKey || '',
      name: x.name || '',
      hex: p.hex,
      short: id,
      rgb: p.rgb,
      r: p.r,
      g: p.g,
      b: p.b
    });
  }
  return out;
}

module.exports = {
  GENERIC_KEY: GENERIC_KEY,
  getPaletteColors: getPaletteColors,
  getPaletteInfo: getPaletteInfo,
  getBrandList: getBrandList,
  getBrand: getBrand,
  getCurrentBrand: getCurrentBrand,
  setCurrentBrand: setCurrentBrand,
  getDefaultBrand: getDefaultBrand,
  loadRaw: loadRaw,
  normalize: normalize,
  resetCache: resetCache
};
