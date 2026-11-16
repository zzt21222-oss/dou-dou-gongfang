// utils/quantize.js
// 降色算法集合。输入 pixels 为扁平 RGB 数组 [r,g,b,r,g,b,...]，长度 = 像素数*3。
// 每个算法返回 { palette: [[r,g,b],...], labels: Int数组(长度=像素数，值为 palette 下标) }

function dist2(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

// 加权感知距离（人眼敏感度校正 / redmean）：
//   rMean = (R1 + R2) / 2
//   dR = R1 - R2, dG = G1 - G2, dB = B1 - B2
//   distance = sqrt( (2 + rMean/256)*dR^2 + 4*dG^2 + (2 + (255 - rMean)/256)*dB^2 )
// 该公式对绿色(人眼最敏感)加权最大、对红色/蓝色按亮度自适应，
// 比朴素欧氏距离更贴近人眼对拼豆配色的判断。
function redmeanDist(a, b) {
  const rMean = (a[0] + b[0]) / 2;
  const dR = a[0] - b[0];
  const dG = a[1] - b[1];
  const dB = a[2] - b[2];
  const rTerm = (2 + rMean / 256) * dR * dR;
  const gTerm = 4 * dG * dG;
  const bTerm = (2 + (255 - rMean) / 256) * dB * dB;
  return Math.sqrt(rTerm + gTerm + bTerm);
}

// 旧版加权距离（保留兼容，新代码一律使用 redmeanDist）
function dist2Weighted(a, b) {
  return redmeanDist(a, b);
}

function assignLabels(pixels, palette) {
  const n = pixels.length / 3;
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = [pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]];
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const d = redmeanDist(p, palette[k]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    labels[i] = best;
  }
  return labels;
}

function channelRange(box) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
  for (const c of box) {
    if (c[0] < rmin) rmin = c[0]; if (c[0] > rmax) rmax = c[0];
    if (c[1] < gmin) gmin = c[1]; if (c[1] > gmax) gmax = c[1];
    if (c[2] < bmin) bmin = c[2]; if (c[2] > bmax) bmax = c[2];
  }
  return { r: rmax - rmin, g: gmax - gmin, b: bmax - bmin };
}

function avgColor(box) {
  let r = 0, g = 0, b = 0;
  for (const c of box) { r += c[0]; g += c[1]; b += c[2]; }
  const n = box.length || 1;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// 1) 均匀量化
function uniform(pixels, n) {
  const k = Math.max(1, Math.round(Math.cbrt(n)));
  const step = 256 / k;
  const keyMap = new Map();
  const palette = [];
  const labels = new Int32Array(pixels.length / 3);
  for (let i = 0; i < pixels.length / 3; i++) {
    const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
    const br = Math.min(k - 1, Math.floor(r / step));
    const bg = Math.min(k - 1, Math.floor(g / step));
    const bb = Math.min(k - 1, Math.floor(b / step));
    const center = [Math.round(br * step + step / 2), Math.round(bg * step + step / 2), Math.round(bb * step + step / 2)];
    const key = br * 1000000 + bg * 1000 + bb;
    let idx = keyMap.get(key);
    if (idx === undefined) {
      idx = palette.length;
      palette.push(center);
      keyMap.set(key, idx);
    }
    labels[i] = idx;
  }
  return { palette, labels };
}

// 2) 中位切分
function medianCut(pixels, n) {
  let boxes = [[]];
  for (let i = 0; i < pixels.length / 3; i++) {
    boxes[0].push([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]]);
  }
  while (boxes.length < n) {
    let target = -1, bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.length < 2) continue;
      const range = channelRange(b);
      const score = b.length * Math.max(range.r, range.g, range.b);
      if (score > bestScore) { bestScore = score; target = i; }
    }
    if (target < 0) break;
    const b = boxes[target];
    const range = channelRange(b);
    const ch = (range.r >= range.g && range.r >= range.b) ? 0 : (range.g >= range.b ? 1 : 2);
    b.sort((a, c) => a[ch] - c[ch]);
    const mid = b.length >> 1;
    const b1 = b.slice(0, mid);
    const b2 = b.slice(mid);
    boxes.splice(target, 1, b1, b2);
  }
  const palette = boxes.map(b => avgColor(b));
  const labels = assignLabels(pixels, palette);
  return { palette, labels };
}

// 3) K均值
function kmeans(pixels, n, iters) {
  iters = iters || 8;
  const seeds = [];
  let tries = 0;
  const total = pixels.length / 3;
  while (seeds.length < n && tries < total * 3) {
    const idx = Math.floor(Math.random() * total);
    const c = [pixels[idx * 3], pixels[idx * 3 + 1], pixels[idx * 3 + 2]];
    let ok = true;
    for (const s of seeds) {
      if (Math.abs(s[0] - c[0]) + Math.abs(s[1] - c[1]) + Math.abs(s[2] - c[2]) < 36) { ok = false; break; }
    }
    if (ok) seeds.push(c);
    tries++;
  }
  while (seeds.length < n) seeds.push([Math.random() * 255, Math.random() * 255, Math.random() * 255]);
  const palette = seeds.map(s => [Math.round(s[0]), Math.round(s[1]), Math.round(s[2])]);
  let labels = new Int32Array(total);
  for (let it = 0; it < iters; it++) {
    // 指派：使用 redmean 加权距离
    for (let i = 0; i < total; i++) {
      const p = [pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]];
      let best = 0, bestD = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const d = redmeanDist(p, palette[k]);
        if (d < bestD) { bestD = d; best = k; }
      }
      labels[i] = best;
    }
    // 更新
    const sum = palette.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < total; i++) {
      const k = labels[i];
      sum[k][0] += pixels[i * 3];
      sum[k][1] += pixels[i * 3 + 1];
      sum[k][2] += pixels[i * 3 + 2];
      sum[k][3] += 1;
    }
    for (let k = 0; k < palette.length; k++) {
      if (sum[k][3] > 0) {
        palette[k] = [Math.round(sum[k][0] / sum[k][3]), Math.round(sum[k][1] / sum[k][3]), Math.round(sum[k][2] / sum[k][3])];
      }
    }
  }
  return { palette, labels };
}

// 4) 保留主色调（按出现频率取 Top N）
function dominant(pixels, n) {
  const buckets = new Map();
  for (let i = 0; i < pixels.length / 3; i++) {
    const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
    const br = (r >> 4) << 4, bg = (g >> 4) << 4, bb = (b >> 4) << 4;
    const key = br * 1000000 + bg * 1000 + bb;
    let e = buckets.get(key);
    if (!e) { e = [0, 0, 0, 0]; buckets.set(key, e); }
    e[0] += r; e[1] += g; e[2] += b; e[3] += 1;
  }
  const arr = [];
  buckets.forEach(e => arr.push({ c: [Math.round(e[0] / e[3]), Math.round(e[1] / e[3]), Math.round(e[2] / e[3])], count: e[3] }));
  arr.sort((a, b) => b.count - a.count);
  const palette = arr.slice(0, n).map(x => x.c);
  if (palette.length === 0) palette.push([0, 0, 0]);
  const labels = assignLabels(pixels, palette);
  return { palette, labels };
}

function run(name, pixels, n) {
  n = Math.max(1, Math.min(60, n | 0));
  switch (name) {
    case 'uniform': return uniform(pixels, n);
    case 'kmeans': return kmeans(pixels, n);
    case 'dominant': return dominant(pixels, n);
    case 'median':
    default: return medianCut(pixels, n);
  }
}

module.exports = { run, assignLabels, dist2, dist2Weighted, redmeanDist, medianCut };
