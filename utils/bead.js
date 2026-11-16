// utils/bead.js
// 拼豆转化核心：把小尺寸像素数组降色/映射色板，生成最终图纸数据模型与材料清单(BOM)。
// 像素提取(canvas)在页面里完成，这里只处理纯数据，方便复用与测试。

const quantize = require('./quantize.js');
const { createMapper, redmeanDist } = require('./mapToPalette.js');

// 底板形状：矩形 / 圆形 / 六边形
const SHAPES = ['rect', 'circle', 'hexagon'];
const SHAPE_LABELS = { rect: '矩形', circle: '圆形', hexagon: '六边形' };

// 生成形状遮罩：返回 Int8Array(w*h)，1=需要拼的格子，-1=形状外(不拼)
function buildShapeMask(w, h, shape) {
  const mask = new Int8Array(w * h).fill(1);
  if (shape === 'rect') return mask;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  if (shape === 'circle') {
    const r = Math.min(w, h) / 2 - 0.05;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx, dy = y - cy;
        if (Math.sqrt(dx * dx + dy * dy) > r) mask[y * w + x] = -1;
      }
    }
  } else if (shape === 'hexagon') {
    // 正六边形（平顶），用点到中心的比例判断
    const rx = w / 2 - 0.05, ry = h / 2 - 0.05;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = Math.abs(x - cx) / rx;
        const ny = Math.abs(y - cy) / ry;
        // 六边形边界：|x|/rx 与 |y|/ry 的折线约束
        if (nx > 1 || ny > 1 || (nx + ny * 0.5 > 1 && nx * 0.5 + ny > 1 && nx + ny > 1.6)) {
          if (nx + ny > 1.0 && !(nx < 0.5 && ny < 0.5)) {
            // 圆角近似：用更紧的六边判定
            const a = nx, b = ny;
            if (a > 1 || b > 1 || (a * 0.866 + b * 0.5 > 1 && b * 0.866 + a * 0.5 > 1)) {
              mask[y * w + x] = -1;
            }
          }
        }
      }
    }
  }
  return mask;
}

// 把形状遮罩应用到 grid：形状外(-1)的格子标记为 -1（不拼）
function applyShapeMask(grid, w, h, shape) {
  const mask = buildShapeMask(w, h, shape);
  const out = new Int32Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = mask[i] < 0 ? -1 : grid[i];
  return out;
}

// 同一份色板复用同一个映射器：色板对象不变时，记忆化缓存才能跨调用生效。
// 这样色板扩到 291 色也不会变慢（实测比原来的逐像素写法快约 2.8 倍）。
const _mappers = new WeakMap();
function mapperFor(paletteColors) {
  let m = _mappers.get(paletteColors);
  if (!m) { m = createMapper(paletteColors); _mappers.set(paletteColors, m); }
  return m;
}

// 在色板中找到与某 RGB 最近的色板颜色下标
function nearestPalette(rgb, paletteColors) {
  return mapperFor(paletteColors)(rgb[0], rgb[1], rgb[2]);
}

// 逐像素映射到最接近的色板颜色
// pixels: 扁平 RGB; paletteColors: [{id,name,hex,rgb}]
// 返回 Int32Array（指向 paletteColors 的下标）
function mapToPalette(pixels, paletteColors) {
  const map = mapperFor(paletteColors);
  const n = pixels.length / 3;
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    labels[i] = map(pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]);
  }
  return labels;
}

// 先中位切分把图片量化到 N 种颜色，再把这 N 种代表色映射到色板，
// 得到「最多 N 种、且全部是真实豆子色」的网格。
// 返回 Int32Array（指向 paletteColors 的下标）
function mapMedianToPalette(pixels, paletteColors, N) {
  const q = quantize.medianCut(pixels, Math.max(2, N | 0));
  const mapped = q.palette.map(rgb => nearestPalette(rgb, paletteColors));
  const out = new Int32Array(q.labels.length);
  for (let i = 0; i < q.labels.length; i++) out[i] = mapped[q.labels[i]];
  return out;
}

// 颜色数量上限控制（严格按用户给定规则）：
//   1) 统计直接映射后每个色板色的使用次数(count)；
//   2) 若使用色种类 > limit，按使用次数「升序」循环移除最少用色 C_removed：
//        - 对每个原本映射为 C_removed 的像素，找「剩余可用颜色」中与 C_removed 色差最小的
//          C_replace，替换该像素；
//        - 把 C_removed 从可用颜色列表中移除；
//      - 直到颜色种类 <= limit；
//   3) 重新生成颜色统计与图纸（由调用方 finalize 后渲染）。
// labels: 指向 paletteColors 的下标；返回新的 Int32Array
function limitPaletteColors(labels, paletteColors, limit, ratioThreshold) {
  limit = Math.max(1, limit | 0);
  if (ratioThreshold == null) ratioThreshold = 0.01; // 默认 1% 占比阈值
  const n = labels.length;
  // 1) 统计使用次数（形状外 -1 不计入）并累计总像素
  const counts = new Array(paletteColors.length).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] < 0) continue;
    counts[labels[i]]++;
    total++;
  }
  if (total === 0) return Int32Array.from(labels);
  // 占比 < 阈值的像素数（至少 1，避免 0 把主色误吞）
  const minCount = Math.max(1, Math.floor(total * ratioThreshold));

  // 可用颜色列表（使用次数 > 0）
  let avail = [];
  for (let i = 0; i < paletteColors.length; i++) if (counts[i] > 0) avail.push(i);

  const out = Int32Array.from(labels);
  // 2) 合并循环：
  //    触发条件 = 种类 > 上限  OR  存在占比 < 阈值 的噪点色
  //    每次移除「低于阈值的颜色里次数最少者」；若无低于阈值者，则移除全局最少用色（满足上限约束）
  while (avail.length > limit || avail.some((id) => counts[id] < minCount)) {
    const below = avail.filter((id) => counts[id] < minCount);
    const pool = below.length ? below : avail;
    pool.sort((a, b) => counts[a] - counts[b]);
    const removed = pool[0];

    // 替换目标：优先选「大色块」（占比 >= 阈值），否则在剩余色中选 redmean 最近者
    const rest = avail.filter((id) => id !== removed);
    const bigs = rest.filter((id) => counts[id] >= minCount);
    const cand = bigs.length ? bigs : rest;
    let replace = cand[0];
    let bestD = Infinity;
    const rc = paletteColors[removed];
    for (let k = 0; k < cand.length; k++) {
      const c = paletteColors[cand[k]];
      const d = redmeanDist(rc.r, rc.g, rc.b, c.r, c.g, c.b);
      if (d < bestD) { bestD = d; replace = cand[k]; }
    }
    // 替换所有原本映射为 removed 的像素
    for (let i = 0; i < n; i++) {
      if (out[i] === removed) out[i] = replace;
    }
    counts[replace] += counts[removed];
    counts[removed] = 0;
    avail = rest; // removed 已从可用列表移除，继续循环
  }
  return out;
}

// 清理抗锯齿边缘：把偏离主体颜色较远的孤立像素归并到相邻主色，
// 避免出现"灰色描边"把文字/星星糊掉。
function cleanEdges(grid, w, h, colors) {
  const out = new Int32Array(grid);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const id = out[i];
      if (id < 0) continue;
      // 只处理面积较小的颜色（通常是边缘过渡色）
      const c = colors[id];
      if (!c || c.count > Math.max(4, w * h * 0.02)) continue;
      // 统计邻居主色
      const neigh = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nid = out[ny * w + nx];
          if (nid < 0 || nid === id) continue;
          neigh.set(nid, (neigh.get(nid) || 0) + 1);
        }
      }
      if (neigh.size === 0) continue;
      let bestN = -1, bestC = -1;
      neigh.forEach((cnt, nid) => {
        if (cnt > bestC) { bestC = cnt; bestN = nid; }
      });
      // 如果自己是少数色，替换为最多邻居
      if (bestC >= 3) out[i] = bestN;
    }
  }
  return out;
}

// 保守去孤立杂色点：某像素的 8 邻域中同色邻居 <=1 时，视为孤立点，
// 并入邻域多数色。迭代 2 次，不影响大色块/主体边缘。
function denoise(grid, w, h) {
  const g = new Int32Array(grid);
  const total = w * h;
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const idx = g[i];
        if (idx < 0) continue;
        const neigh = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            neigh.push(g[ny * w + nx]);
          }
        }
        if (neigh.length === 0) continue;
        let same = 0;
        for (let k = 0; k < neigh.length; k++) if (neigh[k] === idx) same++;
        // 只移除「完全孤立的单点」(8 邻域中没有任何同色)：绝不动 ≥1 个同色邻居的像素，
        // 否则会把 1px 细线 / 小色块整片吞掉，导致图纸丢色丢形。
        if (same === 0) {
          const map = new Map();
          for (let k = 0; k < neigh.length; k++) {
            const v = neigh[k];
            if (v < 0) continue;
            map.set(v, (map.get(v) || 0) + 1);
          }
          let bestN = -1, bestC = -1;
          map.forEach((cnt, v) => { if (cnt > bestC) { bestC = cnt; bestN = v; } });
          if (bestN !== idx && bestN >= 0) {
            g[i] = bestN;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  return g;
}

// 合并「细小 / 近似背景」的颜色，让简单图（如纯色 logo）只保留真正的少数主色，
// 不被源图自带的抗锯齿 / JPEG 噪点拆成十几种杂色。
// 处理顺序（全部基于「已映射到色板」的结果，不生成新颜色）：
//   1) 背景吸附：映射到的色若「接近白」(亮度高且通道差小) → 白；若「接近黑」(亮度低) → 黑。
//      这一步专门吃掉抗锯齿在白底/黑字边缘产生的浅粉、浅灰、淡紫等「类白/类黑」噪点。
//   2) 低频合并：剩余颜色里，使用数低于阈值(绝对下限 或 总数占比)的「小色」，
//      整体并入与之 redmean 最近的「主色」。阈值保守，不会误并真实主色。
// labels: 指向 paletteColors 的下标；返回新的 Int32Array
function consolidateColors(labels, paletteColors, opts) {
  opts = opts || {};
  const whiteSnap = opts.whiteSnap !== false;
  const blackSnap = opts.blackSnap !== false;
  const minBeads = opts.minBeads != null ? opts.minBeads : 6;
  const minFrac = opts.minFrac != null ? opts.minFrac : 0.006;
  const n = labels.length;
  let idxWhite = -1, idxBlack = -1;
  for (let i = 0; i < paletteColors.length; i++) {
    const hex = (paletteColors[i].hex || '').toUpperCase().replace('#', '');
    if (hex === 'FFFFFF') idxWhite = i;
    else if (hex === '1A1A1A' || hex === '000000') idxBlack = i;
  }
  const lum = c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
  const rng = c => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  // 真正接近黑才吸到黑：用「最大通道 < 64」判定，绝不误伤饱和色（红/绿/蓝/深蓝等
  // 亮度低但饱和度高，lum<140 会把它们全吞掉，导致真机照片大量丢色）。
  const isNearBlack = c => Math.max(c.r, c.g, c.b) < 64;

  const out = new Int32Array(labels);
  // 1) 背景吸附
  for (let i = 0; i < n; i++) {
    const id = out[i];
    if (id < 0) continue;
    const c = paletteColors[id];
    if (whiteSnap && idxWhite >= 0 && lum(c) > 235 && rng(c) < 30) out[i] = idxWhite;
    else if (blackSnap && idxBlack >= 0 && isNearBlack(c)) out[i] = idxBlack;
  }
  // 2) 低频合并
  const counts = new Array(paletteColors.length).fill(0);
  for (let i = 0; i < n; i++) if (out[i] >= 0) counts[out[i]]++;
  let total = 0; for (let i = 0; i < counts.length; i++) total += counts[i];
  total = total || 1;
  const threshold = Math.max(minBeads, Math.ceil(total * minFrac));
  const majors = [];
  for (let i = 0; i < counts.length; i++) if (counts[i] > threshold) majors.push(i);
  if (majors.length === 0) return out;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] === 0 || counts[i] > threshold) continue;
    let best = majors[0], bestD = Infinity;
    const ci = paletteColors[i];
    for (let m = 0; m < majors.length; m++) {
      const cm = paletteColors[majors[m]];
      const d = redmeanDist(ci.r, ci.g, ci.b, cm.r, cm.g, cm.b);
      if (d < bestD) { bestD = d; best = majors[m]; }
    }
    for (let k = 0; k < n; k++) if (out[k] === i) out[k] = best;
    counts[best] += counts[i]; counts[i] = 0;
  }
  return out;
}

// 仅保留使用最多的 n 个颜色，其余重新映射到最接近的保留色
function reduceToTopN(labels, rawColors, n) {
  const counts = new Array(rawColors.length).fill(0);
  // 与 finalize 同一类问题：-1 = 不拼，不能当颜色下标统计
  for (let i = 0; i < labels.length; i++) { const v = labels[i]; if (v >= 0) counts[v]++; }
  const order = rawColors.map((c, i) => ({ i, count: counts[i] }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);
  const keep = order.slice(0, n).map(x => x.i);
  // 为被丢弃的颜色找最近的保留色
  const remap = new Array(rawColors.length).fill(-1);
  keep.forEach((ki, newId) => { remap[ki] = newId; });
  // 保留色子集只建一次映射器，避免循环里反复构造数组与线性查找
  const keepMap = mapperFor(keep.map(ki => rawColors[ki]));
  for (let i = 0; i < rawColors.length; i++) {
    if (remap[i] >= 0) continue;
    // 在保留色里找最近（与 mapToPalette 同一套 redmean 规则）
    remap[i] = keepMap(rawColors[i].rgb[0], rawColors[i].rgb[1], rawColors[i].rgb[2]);
  }
  const newLabels = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i];
    newLabels[i] = v < 0 ? -1 : remap[v];
  }
  const colors = keep.map((ki, ni) => ({
    rgb: rawColors[ki].rgb,
    code: rawColors[ki].code || rawColors[ki].id || ('?' + (ni + 1)),
    brandKey: rawColors[ki].brandKey || '',
    name: rawColors[ki].name,
    hex: rawColors[ki].hex,
    short: rawColors[ki].short || rawColors[ki].code || rawColors[ki].id || ('?' + (ni + 1))
  }));
  return { labels: newLabels, colors };
}

// 统计并排序颜色，分配稳定 id（按使用量降序）
function finalize(labels, rawColors) {
  const counts = new Array(rawColors.length).fill(0);
  // labels 里可能已经有 -1（透明区 / 形状外 = 不拼），必须跳过：
  // 直接 counts[labels[i]]++ 会写到 counts[-1] 上，而且后面 remap[-1] 是
  // undefined，Int32Array 会把"不拼"悄悄变成下标 0（白色豆子）。
  for (let i = 0; i < labels.length; i++) { const v = labels[i]; if (v >= 0) counts[v]++; }
  const order = rawColors.map((c, i) => ({ i, count: counts[i] }))
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);
  const newLabels = new Int32Array(labels.length);
  const colors = order.map((o, newId) => {
    return {
      id: newId,
      rgb: rawColors[o.i].rgb,
      // 色号优先取 code（领域字段），退一步取 id（色板项的色号也存这里）。
      // 都没命中说明色板契约被破坏了，用 '?N' 明确标记 ——
      // 绝不能用 'C' + 序号：MARD 真的有 29 个 "C+数字" 形态的合法色号
      // （例如 C1 = #E8FFE7），位置编号会冒充成可采购的真实色号（审查 F01）。
      code: rawColors[o.i].code || rawColors[o.i].id || ('?' + (newId + 1)),
      brandKey: rawColors[o.i].brandKey || '',
      name: rawColors[o.i].name || ('颜色' + (newId + 1)),
      hex: rawColors[o.i].hex || rgbToHex(rawColors[o.i].rgb),
      short: rawColors[o.i].short || rawColors[o.i].code || rawColors[o.i].id || ('?' + (newId + 1)),
      count: o.count
    };
  });
  const remap = new Array(rawColors.length).fill(-1);
  order.forEach((o, newId) => { remap[o.i] = newId; });
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i];
    newLabels[i] = v < 0 ? -1 : remap[v];   // -1 原样保留，不参与重排
  }
  return { labels: newLabels, colors };
}

function rgbToHex(rgb) {
  return '#' + rgb.map(v => ('0' + v.toString(16)).slice(-2)).join('').toUpperCase();
}

// 自动分板：当尺寸超过单块底板时，切成多块并标注拼接序号
// maxBoard: 单板最大宽高（默认 29×29 mini 板）
function splitBoards(w, h, maxW, maxH) {
  maxW = maxW || 29;
  maxH = maxH || 29;
  if (w <= maxW && h <= maxH) return null;
  const cols = Math.ceil(w / maxW);
  const rows = Math.ceil(h / maxH);
  const boards = [];
  let seq = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * maxW;
      const y = r * maxH;
      const bw = Math.min(maxW, w - x);
      const bh = Math.min(maxH, h - y);
      boards.push({ seq: seq++, x, y, w: bw, h: bh, row: r, col: c });
    }
  }
  return { cols, rows, boards };
}

// 汇总 BOM
function computeBOM(colors) {
  let total = 0;
  colors.forEach(c => { total += c.count; });
  return { total, colorKinds: colors.length };
}

module.exports = {
  SHAPES,
  SHAPE_LABELS,
  buildShapeMask,
  applyShapeMask,
  nearestPalette,
  mapToPalette,
  mapMedianToPalette,
  limitPaletteColors,
  consolidateColors,
  reduceToTopN,
  finalize,
  rgbToHex,
  splitBoards,
  computeBOM,
  cleanEdges,
  denoise
};
