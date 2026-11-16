/**
 * v10 完整检测：二值化 → 视需要裁白静区 → 内容区投影差分测N + 规律闸门拒照片
 * 统一入口 detect(lum, W, H, RW=240) → N (0=拒)
 */
'use strict';
const { otsuPeaks, bilinearDown } = require('./alg_v3_draft');

/** 投影差分测模块宽。返回 {mod,res} 或 null（残差大/过密视为非规则） */
function modByProjection(bin, x0, x1, y0, y1) {
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const prow = []; for (let y = y0; y <= y1; y++) { let c = 0; for (let x = x0; x <= x1; x++) if (!bin[y][x]) c++; prow.push(c); }
  const pcol = new Array(cw).fill(0); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!bin[y][x]) pcol[x - x0]++;
  function peaks(sig) { const dr = []; for (let i = 0; i + 1 < sig.length; i++) dr.push(Math.abs(sig[i] - sig[i + 1]));
    const pk = []; const dm = dr.reduce((a, b) => a + b, 0) / dr.length;
    for (let i = 1; i + 1 < dr.length; i++) if (dr[i] > dm * 1.3 && dr[i] >= dr[i - 1] && dr[i] >= dr[i + 1]) pk.push(i + 0.5); return pk; }
  const pkR = peaks(prow), pkC = peaks(pcol);
  const allPk = pkR.concat(pkC);
  if (allPk.length < 6) return null;
  const gaps = []; for (let i = 0; i + 1 < pkR.length; i++) gaps.push(pkR[i + 1] - pkR[i]);
  for (let i = 0; i + 1 < pkC.length; i++) gaps.push(pkC[i + 1] - pkC[i]);
  const hist = new Map(); for (const g of gaps) { const k = Math.round(g * 2) / 2; if (k >= 1) hist.set(k, (hist.get(k) || 0) + 1); }
  let best = 0, bc = 0; for (const [g, c] of hist) if (c > bc) { bc = c; best = g; }
  if (!best) return null;
  function cost(mod) { let s = 0; for (const p of allPk) { const k = Math.round(p / mod); s += Math.abs(p - k * mod); } return s / allPk.length; }
  let bm = best, bres = cost(best);
  for (let m = best * 0.6; m <= best * 1.4; m += 0.02) { const c = cost(m); if (c < bres) { bres = c; bm = m; } }
  // 规律性闸门：模块宽≥2.5px 且 残差小（峰真落在均匀栅格上）
  if (bm < 2.5 || bres > 0.65) return null;
  return { mod: bm, res: bres };
}

function detect(rawLum, W, H, RW = 240) {
  const RH = Math.max(1, Math.round(RW * H / W));
  const sm = bilinearDown(rawLum, W, H, RW, RH);
  const thr = otsuPeaks(sm, RW, RH);
  const bin = []; for (let y = 0; y < RH; y++) { const b = new Uint8Array(RW); for (let x = 0; x < RW; x++) b[x] = sm[y][x] <= thr ? 0 : 1; bin.push(b); }
  // 黑占比
  const colDark = new Array(RW).fill(0); const rowDark = new Array(RH).fill(0);
  for (let y = 0; y < RH; y++) { let rc = 0; for (let x = 0; x < RW; x++) if (!bin[y][x]) { colDark[x]++; rc++; } rowDark[y] = rc; }
  let td = 0; for (let x = 0; x < RW; x++) td += colDark[x];
  const br = td / (RW * RH);
  if (br < 0.04 || br > 0.96) return 0; // 近纯色

  // 判定并计算内容 bbox：外圈是否白(有静区)。检查最外 2px 的“非黑”占比(静区通常白→bin=1)
  let x0 = 0, x1 = RW - 1, y0 = 0, y1 = RH - 1;
  const ring2 = (y, x) => { if (x < 0 || y < 0 || x >= RW || y >= RH) return 1; return bin[y][x]; };
  let outerNonDark = 0, outerTotal = 0;
  for (let x = 0; x < RW; x++) for (const yy of [0, 1, RH - 2, RH - 1]) { outerTotal++; if (ring2(yy, x)) outerNonDark++; }
  for (let y = 0; y < RH; y++) for (const xx of [0, 1, RW - 2, RW - 1]) { outerTotal++; if (ring2(y, xx)) outerNonDark++; }
  const outerLightRatio = outerNonDark / outerTotal;
  const hasMargin = outerLightRatio > 0.85; // 外圈绝大多数是亮(白静区)
  if (hasMargin && br < 0.5) {
    // 从四边向内找“内容”边界：该列/行黑像素 > 5% 高度 视为进入内容
    const th = Math.max(2, RH * 0.04);
    let nx0 = -1, nx1 = -1, ny0 = -1, ny1 = -1;
    for (let x = 0; x < RW; x++) if (colDark[x] > th) { nx0 = x; break; }
    for (let x = RW - 1; x >= 0; x--) if (colDark[x] > th) { nx1 = x; break; }
    for (let y = 0; y < RH; y++) if (rowDark[y] > th) { ny0 = y; break; }
    for (let y = RH - 1; y >= 0; y--) if (rowDark[y] > th) { ny1 = y; break; }
    if (nx0 >= 0 && nx1 > nx0 && ny0 >= 0 && ny1 > ny0) { x0 = nx0; x1 = nx1; y0 = ny0; y1 = ny1; }
  }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const r = modByProjection(bin, x0, x1, y0, y1);
  if (!r) return 0;
  const Nw = Math.round(cw / r.mod), Nh = Math.round(ch / r.mod);
  const big = Math.max(Nw, Nh), small = Math.min(Nw, Nh);
  let N;
  if (big - small <= Math.max(1, Math.round(big * 0.12))) N = Math.round((Nw + Nh) / 2);
  else return 0;
  if (N < 6 || N > 200) return 0;
  return N;
}

module.exports = { detect };
