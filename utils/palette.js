// utils/palette.js
// 纯颜色换算工具。
//
// 背景说明（避免误解）：
//   这个文件里曾放过一份「多品牌色板」，但那是手写的近似色值 + 自编色号
//   （P01 / H01 / A01 / Y01 / M01），既不是品牌真实色号，主流程也从未使用过。
//   品牌色板现已改为 data/brands.js（真实色卡数据，由 tools/gen_brands.py 生成），
//   统一经 utils/paletteLoader.js 加载。
//   本文件只保留颜色换算工具函数。

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16) || 0,
    parseInt(h.substring(2, 4), 16) || 0,
    parseInt(h.substring(4, 6), 16) || 0
  ];
}

function rgbToHex(rgb) {
  return '#' + rgb.map(v => ('0' + Math.max(0, Math.min(255, v | 0)).toString(16)).slice(-2)).join('').toUpperCase();
}

module.exports = { hexToRgb, rgbToHex };
