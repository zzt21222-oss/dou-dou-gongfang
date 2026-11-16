// verification/static_check.js
// 改完小程序代码后的静态自检，不需要开发者工具、不需要真机：
//   1) WXML 标签是否配对（含 <canvas></canvas> 这类写了闭合标签的空元素）
//   2) WXML 里绑定的事件处理器在对应 js 中是否真的存在（防「点了没反应」）
//   3) 各 js 文件语法是否通过
// 用法：node verification/static_check.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['index/index', 'adjust/adjust', 'editor/editor', 'preview/preview', 'history/history', 'guide/guide', 'colorpicker/colorpicker'];

// WXML 中允许不写闭合标签的空元素（当它们没有显式闭合标签时）
const VOID_TAGS = new Set(['image', 'input', 'icon', 'progress', 'slider', 'switch', 'textarea', 'audio', 'video', 'canvas', 'camera', 'live-player', 'live-pusher', 'open-data', 'web-view', 'import', 'include', 'wxs']);
const EVENT_ATTRS = 'tap|longpress|error|load|change|input|confirm|submit|scroll|touchstart|touchmove|touchend|animationend|transitionend';

let problems = 0;
const report = (ok, msg) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + msg); if (!ok) problems++; };

console.log('\n=== 1/2. WXML 标签配对 + 事件处理器 ===');
PAGES.forEach(p => {
  const wxmlPath = path.join(ROOT, 'pages', p + '.wxml');
  const jsPath = path.join(ROOT, 'pages', p + '.js');
  if (!fs.existsSync(wxmlPath)) { report(false, p + '.wxml 不存在'); return; }
  const wxml = fs.readFileSync(wxmlPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');

  // 1) 标签配对
  // 先记下写了显式闭合标签的标签名：<canvas></canvas> 合法，不能当空元素跳过
  const closers = new Set();
  [...wxml.matchAll(/<\/([a-zA-Z][\w-]*)>/g)].forEach(m => closers.add(m[1]));

  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m, mismatch = null;
  while ((m = tagRe.exec(wxml))) {
    const [, closing, tag, , selfClose] = m;
    if (closing) {
      const top = stack.pop();
      if (top !== tag) { mismatch = mismatch || `</${tag}> 对应 <${top}>`; }
    } else if (!selfClose && (!VOID_TAGS.has(tag) || closers.has(tag))) {
      stack.push(tag);
    }
  }
  if (mismatch) report(false, `${p}.wxml 标签不匹配：${mismatch}`);
  else if (stack.length) report(false, `${p}.wxml 未闭合标签：${stack.join(', ')}`);
  else report(true, `${p}.wxml 标签配对正常`);

  // 2) 事件处理器存在性
  const handlers = new Set();
  const hRe = new RegExp(`\\b(?:bind|catch)(?:${EVENT_ATTRS})\\s*=\\s*"([A-Za-z_$][\\w$]*)"`, 'g');
  let h;
  while ((h = hRe.exec(wxml))) handlers.add(h[1]);
  const missing = [...handlers].filter(fn => !new RegExp('(^|[\\s,{])' + fn + '\\s*[(:]').test(js));
  report(missing.length === 0, missing.length
    ? `${p}.js 缺少事件处理器：${missing.join(', ')}`
    : `${p}.js 事件处理器齐备（${handlers.size} 个）`);
});

console.log('\n=== 3/3. 语法检查 ===');
const jsFiles = [
  ...PAGES.map(p => 'pages/' + p + '.js').filter(f => fs.existsSync(path.join(ROOT, f))),
  ...fs.readdirSync(path.join(ROOT, 'utils')).filter(f => f.endsWith('.js')).map(f => 'utils/' + f),
];
jsFiles.forEach(f => {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); report(true, f); }
  catch (e) { report(false, f + ' → ' + String(e.stderr || e.message).split('\n')[0]); }
});

console.log(problems ? `\n共 ${problems} 个问题，请修复后再提交\n` : '\n全部通过\n');
process.exit(problems ? 1 : 0);
