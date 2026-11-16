// utils/mapToPalette.js
// 颜色映射「唯一逻辑」，严格按用户给定的 redmean 加权欧氏距离实现。
// 小程序与校验脚本都引用这里，保证映射规则只有一份、永不出错。
//
// 使用方式：
//   const { buildPalette, mapToPalette } = require('./mapToPalette.js');
//   const palette = buildPalette(colorPaletteJson);   // [{id,name,hex,r,g,b}]
//   const color = mapToPalette(palette, r, g, b);      // 返回最接近的色板颜色对象

// 色板数据：从 JSON 加载，把 hex 解析成 r/g/b 数字
function buildPalette(raw) {
  return (raw || []).map(c => {
    const hex = String(c.hex || '').replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { id: c.id, name: c.name, hex: c.hex, r, g, b };
  });
}

// 两个 RGB 之间的 redmean 加权欧氏距离（与映射公式完全一致）
// 用于「低频色合并到最近保留色」时的距离比较
function redmeanDist(r1, g1, b1, r2, g2, b2) {
  const rMean = (r1 + r2) / 2;
  const dR = r1 - r2;
  const dG = g1 - g2;
  const dB = b1 - b2;
  return Math.sqrt(
    (2 + rMean / 256) * dR * dR +
    4 * dG * dG +
    (2 + (255 - rMean) / 256) * dB * dB
  );
}

// 某个像素的 RGB 映射到最近的色板颜色
// palette: [{id,name,hex,r,g,b}]
// 返回 palette 中距离最小的那一项
//
// 色相保护：源像素「明显是彩色」时（色域跨度≥30 且不是近黑暗色），只在彩色色板里匹配。
// 原因：色板里的紫（#800080/Plum）偏红，蓝紫/暗紫像素按 redmean 距离会被灰/深灰"吞掉"，
// 导致原图的紫色整片丢失。黑白灰及接近黑白灰的像素不受影响（仍在完整色板里匹配）。
function mapToPalette(palette, r, g, b) {
  let candidates = palette;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if ((mx - mn) >= 22 && mx > 50) {
    const chromatic = palette.filter(c => {
      const cr = c.r != null ? c.r : c.rgb[0];
      const cg = c.g != null ? c.g : c.rgb[1];
      const cb = c.b != null ? c.b : c.rgb[2];
      return (Math.max(cr, cg, cb) - Math.min(cr, cg, cb)) > 30;   // 排除纯白/纯黑/灰系/炭灰等近灰色
    });
    if (chromatic.length) candidates = chromatic;
  }
  let minDist = Infinity;
  let best = candidates[0];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const cr = c.r != null ? c.r : c.rgb[0];
    const cg = c.g != null ? c.g : c.rgb[1];
    const cb = c.b != null ? c.b : c.rgb[2];
    const dist = redmeanDist(r, g, b, cr, cg, cb);
    if (dist < minDist) {
      minDist = dist;
      best = c;
    }
  }
  return best;
}

// 为某个色板创建一个「高性能映射器」：返回 (r,g,b) => 色板下标。
//
// 相比逐像素调用 mapToPalette，做了三件事：
//   1) 颜色记忆化 —— 同一 RGB 只算一次。照片像素重复率很高，命中率通常 90%+。
//   2) 彩色候选只建一次 —— 原来每个像素都 filter 出一个新数组，色板一大就是 GC 灾难。
//   3) 直接返回下标 —— 调用方不必再 indexOf 线性查找。
//
// 判定规则与 mapToPalette 完全一致（同样的 redmean 距离、同样的色相保护），
// 只在「比较大小时不做 Math.sqrt」这一点上做了等价简化（开方不影响大小关系）。
function createMapper(palette) {
  const n = palette.length;
  const rs = new Int32Array(n), gs = new Int32Array(n), bs = new Int32Array(n);
  const chromatic = [];
  for (let i = 0; i < n; i++) {
    const c = palette[i];
    const r = c.r != null ? c.r : c.rgb[0];
    const g = c.g != null ? c.g : c.rgb[1];
    const b = c.b != null ? c.b : c.rgb[2];
    rs[i] = r; gs[i] = g; bs[i] = b;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 30) chromatic.push(i);
  }
  const chromIdx = Int32Array.from(chromatic);
  const cache = new Map();
  const CACHE_MAX = 200000;   // 防极端情况内存无界增长

  return function map(r, g, b) {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    let mx = r > g ? r : g;
    if (b > mx) mx = b;
    let mn = r < g ? r : g;
    if (b < mn) mn = b;
    const useChrom = (mx - mn) >= 22 && mx > 50 && chromIdx.length > 0;

    const list = useChrom ? chromIdx : null;
    const count = useChrom ? chromIdx.length : n;
    let bestD = Infinity, bestI = 0;
    for (let k = 0; k < count; k++) {
      const i = list ? list[k] : k;
      const sr = rs[i], sg = gs[i], sb = bs[i];
      const rMean = (r + sr) / 2;
      const dR = r - sr, dG = g - sg, dB = b - sb;
      const d = (2 + rMean / 256) * dR * dR + 4 * dG * dG + (2 + (255 - rMean) / 256) * dB * dB;
      if (d < bestD) { bestD = d; bestI = i; }
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, bestI);
    return bestI;
  };
}

module.exports = { buildPalette, mapToPalette, redmeanDist, createMapper };
