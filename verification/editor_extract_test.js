/**
 * 关键验证：从 editor.js 提取移植后的真实 _moduleDetectCore 方法体，
 * 配合 480 缩放路径跑全量回归 —— 确认改动后的真实代码可用。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// 读取 editor.js，截取 _moduleDetectCore 方法体
const src = fs.readFileSync(path.join(__dirname, '..', 'pages/editor/editor.js'), 'utf8');
const m = src.match(/_moduleDetectCore\s*\(lum,\s*RW,\s*RH\)\s*\{/);
if (!m) { console.error('未找到 _moduleDetectCore'); process.exit(1); }
const start = src.indexOf('{', m.index) + 1;
// 花括号配对找结束
let depth = 1, i = start;
for (; i < src.length && depth > 0; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; }
const body = src.slice(start, i - 1);
// eslint-disable-next-line no-new-func
const moduleDetectCore = new Function('lum', 'RW', 'RH', '"use strict";\n' + body + '\nreturn __r;');
// 注意：方法体用的是 return 直接返回。用 new Function 需把内部 return 作为函数返回。改写：包装
// 直接构造：把 body 放进一个返回表达式较复杂。改用 eval 提取闭包形式：
const fnBody = `return (function(lum,RW,RH){ ${body} });`;
// 但 body 内部有 return N / return 0，作为该匿名函数体 OK。
// eslint-disable-next-line no-new-func
const extracted = new Function(fnBody)();

// ---- 工具：双线性缩放到 RW=480（模拟 editor _detectModulePeriod 的 offscreen 缩放）----
function bilinear(lum, W, H, RW) {
  const RH = Math.max(1, Math.round(RW * H / W)); const xr = W / RW, yr = H / RH; const out = [];
  for (let dy = 0; dy < RH; dy++) { const sy = dy * yr, y0 = Math.floor(sy), fy = sy - y0, y1 = Math.min(H - 1, y0 + 1);
    const rowA = lum[y0], rowB = lum[y1]; const o = new Float32Array(RW);
    for (let dx = 0; dx < RW; dx++) { const sx = dx * xr, x0 = Math.floor(sx), fx = sx - x0, x1 = Math.min(W - 1, x0 + 1);
      const a = rowA[x0] * (1 - fx) + rowA[x1] * fx, b = rowB[x0] * (1 - fx) + rowB[x1] * fx; o[dx] = a * (1 - fy) + b * fy; }
    out.push(o); }
  return { lum: out, RW, RH };
}
function prep(lum, W, H, RW = 480) { const d = bilinear(lum, W, H, RW); return extracted(d.lum, d.RW, d.RH); }

// ---- 测试图生成（复用）----
function sm(modN, scale, o = {}) { const { whiteBorder = 0, jitter = 0 } = o;
  const px = modN * scale, W = px, H = px; const mm = [];
  for (let i = 0; i < modN * modN; i++) { const r = ((i * 2654435761) >>> 0) / 4294967296; mm.push(r < 0.5 ? 20 : 235); }
  const lum = [];
  for (let y = 0; y < H; y++) { const row = new Float32Array(W);
    for (let x = 0; x < W; x++) { let val; const mx = Math.floor(x / scale), my = Math.floor(y / scale);
      if (whiteBorder > 0) { const b = whiteBorder * scale; val = (x < b || y < b || x >= px + b || y >= px + b) ? 250 : mm[Math.min(modN - 1, my) * modN + Math.min(modN - 1, mx)]; }
      else val = mm[Math.min(modN - 1, my) * modN + Math.min(modN - 1, mx)];
      if (jitter > 0) { const n = ((x * 73856093) ^ (y * 19349663)) % 1000 / 1000 - 0.5; val = Math.max(0, Math.min(255, val + n * jitter * 2)); }
      row[x] = val; } lum.push(row); }
  return { lum, W, H }; }
function ph(Wpx, Hpx, g = 0) { const lum = [];
  for (let y = 0; y < Hpx; y++) { const row = new Float32Array(Wpx);
    for (let x = 0; x < Wpx; x++) { const gd = (x / Wpx) * 0.6 + (y / Hpx) * 0.4, wv = 0.15 * Math.sin(x * 0.05) * Math.cos(y * 0.04); let v = Math.max(0, Math.min(255, 40 + gd * 180 + wv * 180));
      if (g > 0) v += (((x * 1103515245 + y * 12345) % 100000) / 100000 - 0.5) * g; row[x] = v; } lum.push(row); }
  return { lum, W: Wpx, H: Hpx }; }
function solid(Wpx, Hpx, v = 128) { const lum = []; for (let y = 0; y < Hpx; y++) lum.push(new Float32Array(Wpx).fill(v)); return { lum, W: Wpx, H: Hpx }; }

function run(name, exp, lum, W, H) { const n = prep(lum, W, H); const ok = (exp === 0) ? n === 0 : n === exp;
  console.log(`${ok ? '✅' : '❌'} 期望N=${exp} → N=${n || '拒'}  ${name}`); return ok; }
function e2e(file, realN) { const buf = fs.readFileSync(path.join(__dirname, file)); const png = PNG.sync.read(buf);
  const { width: W, height: H } = png; const lum = [];
  for (let y = 0; y < H; y++) { const row = new Float32Array(W); const i0 = y * W * 4;
    for (let x = 0; x < W; x++) { const i = i0 + x * 4; row[x] = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2]; } lum.push(row); }
  const n = prep(lum, W, H); const ok = n === realN;
  console.log(`${ok ? '✅' : '❌'} 期望N=${realN} → N=${n || '拒'}  [真实PNG] ${file}`); return ok; }

let f = 0, t = 0; const ck = r => { t++; if (!r) f++; };
[21, 25, 29, 33, 37, 41, 45, 49, 57, 65].forEach(N => { const s = sm(N, 14); ck(run('像素画N=' + N, N, s.lum, s.W, s.H)); });
let s = sm(41, 14, { jitter: 0.15 }); ck(run('N41+噪点', 41, s.lum, s.W, s.H));
s = sm(37, 14, { whiteBorder: 2 }); ck(run('N37+白边', 37, s.lum, s.W, s.H));
s = ph(820, 820); ck(run('照片渐变(拒)', 0, s.lum, s.W, s.H));
s = ph(820, 820, 30); ck(run('照片高斯(拒)', 0, s.lum, s.W, s.H));
s = solid(820, 820, 128); ck(run('纯色(拒)', 0, s.lum, s.W, s.H));
s = sm(100, 8); ck(run('N100', 100, s.lum, s.W, s.H));
s = sm(80, 8); ck(run('N80', 80, s.lum, s.W, s.H));
ck(e2e('qr_v1_21mod.png', 21));
ck(e2e('qr_v3_29mod.png', 29));
ck(e2e('qr_high_49mod.png', 49));
console.log('-'.repeat(64));
console.log('【editor.js 实际移植代码】通过 ' + (t - f) + '/' + t + '，失败 ' + f);
