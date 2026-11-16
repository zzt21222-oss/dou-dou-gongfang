/**
 * 算法 v10 完整回归：合成用例 + 真实二维码PNG（含静区）
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { PNG } = require('pngjs');
const { detect } = require('./alg_v10');

function synthMosaic(modN, scale, opts = {}) { const { whiteBorder = 0, blackFrame = 0, jitter = 0 } = opts;
  const px = modN * scale; const W = px + blackFrame * 2, H = px + blackFrame * 2; const modLum = [];
  for (let m = 0; m < modN * modN; m++) { const rnd = ((m * 2654435761) >>> 0) / 4294967296; modLum.push(rnd < 0.5 ? 20 : 235); }
  const lum = [];
  for (let y = 0; y < H; y++) { const row = new Float32Array(W);
    for (let x = 0; x < W; x++) { let val; const inF = x < blackFrame || y < blackFrame || x >= W - blackFrame || y >= H - blackFrame;
      if (blackFrame && inF) val = 235;
      else if (whiteBorder > 0) { const b = whiteBorder * scale; const mx = x - blackFrame, my = y - blackFrame;
        if (mx < b || my < b || mx >= px + b || my >= px + b) val = 250; else { const mx2 = Math.floor((mx - b) / scale), my2 = Math.floor((my - b) / scale); val = modLum[Math.min(modN - 1, my2) * modN + Math.min(modN - 1, mx2)]; } }
      else { const mx2 = Math.floor((x - blackFrame) / scale), my2 = Math.floor((y - blackFrame) / scale); val = modLum[Math.min(modN - 1, my2) * modN + Math.min(modN - 1, mx2)]; }
      if (jitter > 0) { const n = ((x * 73856093) ^ (y * 19349663) ^ (x * y * 83492791)) % 1000 / 1000 - 0.5; val = Math.max(0, Math.min(255, val + n * jitter * 2)); }
      row[x] = val; } lum.push(row); }
  return { lum, W, H }; }
function synthPhoto(Wpx, Hpx, opts = {}) { const { gauss = 0 } = opts; const lum = [];
  for (let y = 0; y < Hpx; y++) { const row = new Float32Array(Wpx);
    for (let x = 0; x < Wpx; x++) { const g = (x / Wpx) * 0.6 + (y / Hpx) * 0.4; const wave = 0.15 * Math.sin(x * 0.05) * Math.cos(y * 0.04); let val = Math.max(0, Math.min(255, 40 + g * 180 + wave * 180));
      if (gauss > 0) { const n = ((x * 1103515245 + y * 12345) % 100000) / 100000 - 0.5; val += n * gauss; } row[x] = val; } lum.push(row); }
  return { lum, W: Wpx, H: Hpx }; }
function synthSolid(Wpx, Hpx, val = 128) { const lum = []; for (let y = 0; y < Hpx; y++) lum.push(new Float32Array(Wpx).fill(val)); return { lum, W: Wpx, H: Hpx }; }

function run(name, exp, lum, W, H) { const got = detect(lum, W, H); const pass = exp === 0 ? got === 0 : got === exp;
  console.log(`${pass ? '✅' : '❌'} 期望N=${exp} → N=${got || '拒'}  ${name}`); return pass; }
function e2e(file, realN) { const buf = fs.readFileSync(path.join(__dirname, file)); const png = PNG.sync.read(buf);
  const { width: W, height: H } = png; const lum = []; for (let y = 0; y < H; y++) { const row = new Float32Array(W); const i0 = y * W * 4;
    for (let x = 0; x < W; x++) { const i = i0 + x * 4; row[x] = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; } lum.push(row); }
  const got = detect(lum, W, H); const pass = got === realN;
  console.log(`${pass ? '✅' : '❌'} 期望N=${realN} → N=${got || '拒'}  [真实PNG] ${file}`); return pass; }

let fails = 0, total = 0; const ck = (r) => { total++; if (!r) fails++; };
// A 命中组(无静区铺满)
[21, 25, 29, 33, 37, 41, 45, 49, 57, 65].forEach(N => { const s = synthMosaic(N, 14); ck(run('像素画 N=' + N, N, s.lum, s.W, s.H)); });
let s = synthMosaic(41, 14, { jitter: 0.15 }); ck(run('N=41+噪点0.15', 41, s.lum, s.W, s.H));
s = synthMosaic(33, 14, { jitter: 0.08 }); ck(run('N=33+噪点0.08', 33, s.lum, s.W, s.H));
s = synthMosaic(37, 14, { whiteBorder: 2 }); ck(run('N=37+白边2模块', 37, s.lum, s.W, s.H));
// B 照片/纯色拒绝
s = synthPhoto(820, 820); ck(run('照片渐变(应拒)', 0, s.lum, s.W, s.H));
s = synthPhoto(820, 820, { gauss: 30 }); ck(run('照片高斯(应拒)', 0, s.lum, s.W, s.H));
s = synthSolid(820, 820, 128); ck(run('纯色128(应拒)', 0, s.lum, s.W, s.H));
s = synthSolid(820, 820, 15); ck(run('纯黑15(应拒)', 0, s.lum, s.W, s.H));
// C 大模块
s = synthMosaic(100, 8); ck(run('N=100 scale8', 100, s.lum, s.W, s.H));
s = synthMosaic(80, 8); ck(run('N=80 scale8', 80, s.lum, s.W, s.H));
// D 真实二维码PNG(含静区)
ck(e2e('qr_v1_21mod.png', 21));
ck(e2e('qr_v3_29mod.png', 29));
ck(e2e('qr_high_49mod.png', 49));
console.log('-'.repeat(64));
console.log('通过 ' + (total - fails) + '/' + total + '，失败 ' + fails);
