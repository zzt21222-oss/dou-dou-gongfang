// utils/render.js
// 统一的拼豆图纸绘制：在任意 2D ctx 上把 grid 画成「真实拼豆摆放」效果。
// - pixel 模式：带 1-2px 间隙的色块 + 深色描边（模拟豆子间的缝隙）
// - bead  模式：圆/方凸起，外圈加深，中间高光（最像实物）
// - symbol 模式：用字母/符号代替颜色（方便黑白打印）
// 每个像素格固定为正方形（调用方保证 cell 为整数且 x/y 同值）。

function drawBeadCell(ctx, cx, cy, r, col) {
  // 外圈描边（豆子侧壁阴影）：旧版 ×0.55 太暗，会把颜色压灰；改为 ×0.8，
  // 既保留豆子的立体感/颗粒感，又让颜色更接近色板原色。
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${(col[0] * 0.8) | 0},${(col[1] * 0.8) | 0},${(col[2] * 0.8) | 0})`;
  ctx.fill();
  // 主体（色板原色，不动）
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
  ctx.fill();
  // 高光（左上角反光）：减弱不透明度，避免白高光冲淡颜色
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fill();
}

// 在 ctx 上绘制整张图纸网格
// opts: { grid, w, h, cell, offX, offY, colorMeta, mode, symbolMap,
//         showSymbol, showCode, labelMinCell }
//   grid: Int32Array/Array，值 < 0 表示「形状外/不拼」
//   colorMeta: { [id]: { rgb:[r,g,b], hex, code, name } }
//   mode: 'pixel' | 'bead' | 'symbol'
//   symbolMap: { [id]: 'A' }（仅 symbol 模式需要）
//   showCode: pixel 模式下在格子中央印「品牌色号」文本（如 C07）——图纸效果的核心
//   showSymbol: 同上，但印字母符号（旧版打印图行为，保留兼容）
//             两者都为真时 showCode 优先
//   labelMinCell: 格子小于该像素数就不印标签（默认 色号 10 / 符号 14）。
//              格子太小时文字会糊成一坨，反而更难读，所以宁可省略。
// 格内标签的实际字号。**全工程只有这一处定义**，因为打印版面要靠它反推
// "格宽至少多大才不违反最小字号"，两处各算一遍必然会偏（复核 S4 就是这么来的：
// 版面按 0.5×格宽 反推 34px，而这里四字符会走第二项降到 13px = 6.24pt）。
//   上限一：不超过格子一半（太高会顶到上下格）
//   上限二：整串宽度 ≤ 格子 92%。sans-serif 数字/大写字母平均字宽约 0.6×字号，
//           即整串宽度 ≈ 字号 × 0.6 × 字符数 ⇒ 字号 ≤ 格宽 × 1.53 / 字符数
function labelFontPx(cell, text) {
  const n = String(text == null ? '' : text).length;
  if (!n) return 0;
  return Math.max(5, Math.floor(Math.min(cell * 0.5, cell * 1.53 / n)));
}

// 反推：要让 labelFontPx(cell, text) ≥ fsNeed（像素），格子至少要多宽。
// 用逐像素试而不是把公式解出来 —— 这样上面 labelFontPx 一旦改了，
// 这里自动跟着对，不会再出现"版面按一套算、绘制按另一套算"。
function minCellForLabel(text, fsNeed) {
  const LIMIT = 4096;   // 兜底，避免算法写错时死循环
  let cell = 1;
  while (cell < LIMIT && labelFontPx(cell, text) < fsNeed) cell++;
  return cell;
}

function drawGrid(ctx, opts) {
  const { grid, w, h, cell, offX, offY, colorMeta, mode, symbolMap, showSymbol, showCode } = opts;

  if (mode === 'symbol') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(offX, offY, cell * w, cell * h);
    ctx.fillStyle = '#000';
    ctx.font = `${Math.max(8, Math.round(cell * 0.6))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const id = grid[y * w + x];
        if (id < 0) continue;
        const s = symbolMap ? (symbolMap[id] || '') : '';
        ctx.fillText(s, offX + x * cell + cell / 2, offY + y * cell + cell / 2);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    return;
  }

  // 像素间距：固定 1px 缝隙（cell>=4 时），保留豆子颗粒感。
  // 注意：缝隙透出的是「白色」画布背景（editor/preview 已改为白底），不再透灰，颜色更干净。
  // cell<4 时仍填满整格，避免小屏预览时色块被压缩到看不见。
  const gap = cell < 4 ? 0 : 1;

  // 格内标签：色号（C07）优先，其次字母符号（A/B/C，兼容旧打印图）。
  // 格子小于阈值时一律不印——文字会糊成一坨，反而更难读。
  // 优先用 short（短码）：Perler 这类品牌的官方色号是 80-15179 的长 SKU，
  // 直接印进格子会溢出；short 已在生成数据时保证品牌内唯一且 ≤5 字符。
  const labelOf = showCode
    ? (id) => (colorMeta[id] && (colorMeta[id].short || colorMeta[id].code)) || ''
    : (showSymbol && symbolMap ? (id) => symbolMap[id] || '' : null);
  const useLabel = !!labelOf && cell >= (opts.labelMinCell || (showCode ? 10 : 14));
  let lastFont = 0;   // 只有 font 能安全缓存：画底色不会改 font，但会改 fillStyle
  if (useLabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = grid[y * w + x];
      const x0 = offX + x * cell;
      const y0 = offY + y * cell;
      if (id < 0) {
        // 形状外：浅灰底，提示「此处不拼」
        ctx.fillStyle = 'rgb(230,230,230)';
        ctx.fillRect(x0, y0, cell, cell);
        continue;
      }
      const col = colorMeta[id].rgb;
      if (mode === 'bead') {
        drawBeadCell(ctx, x0 + cell / 2, y0 + cell / 2, cell * 0.48, col);
      } else {
        // pixel：实心填满色板原色 + 极浅中性细边。
        // 旧版用 rgb-45 深色描边，会把鲜艳颜色压暗；改为 rgba(0,0,0,0.10) 浅灰细边，
        // 白/浅色块仍有边界可见，彩色块则几乎看不出描边，颜色更贴近原图。
        const ix = x0 + gap, iy = y0 + gap, isz = cell - gap * 2;
        ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        ctx.fillRect(ix, iy, isz, isz);
        ctx.strokeStyle = 'rgba(0,0,0,0.10)';
        ctx.lineWidth = 1;
        ctx.strokeRect(ix + 0.5, iy + 0.5, isz - 1, isz - 1);
        // 格内标签（色号/符号）：默认不画，只有调用方显式开启才生效，
        // 因此编辑器与屏幕预览的观感不受影响。
        if (useLabel) {
          const text = labelOf(id);
          if (text) {
            const lum = 0.299 * col[0] + 0.587 * col[1] + 0.114 * col[2];
            // 字号由 labelFontPx 统一给（打印版面反推格宽用的是同一个函数）
            const fs = labelFontPx(cell, text);
            if (fs !== lastFont) { ctx.font = `${fs}px sans-serif`; lastFont = fs; }
            // 浅底黑字 / 深底白字，任何底色上都看得清
            const fill = lum > 150 ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)';
            // 必须每格直接赋值：上面画底色时已经改过 ctx.fillStyle，
            // 用 lastFill 做缓存会与真实画笔状态脱节 —— 连续同明暗的格子
            // 会用底色去写文字，整片色号"消失"（2026-09-19 审查 F02：
            // MARD 385/400 格、Hama 393/400 格的文字颜色都是错的）。
            ctx.fillStyle = fill;
            ctx.fillText(text, x0 + cell / 2, y0 + cell / 2 + 0.5);
          }
        }
      }
    }
  }
  if (useLabel) { ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; }
}

// 绘制坐标网格线，用于施工/打印图。
// 不传 emphasis 时保持原行为（每 10 格主线、其余细线），供屏幕预览使用；
// 传 emphasis:true 时增加「每 5 格」中间档并加深主线——导出/打印的图纸上数格子更快。
// startX / startY：本块网格左上角对应的**绝对**坐标。分页打印时必须传，
// 否则「每 10 格主线」会从每页的左上角重新计数，第 2 页起主线落在
// 45/55/65… 这种与真实坐标无关的假刻度上，用户按线数格子就会数错（审查 F09）。
function drawCoordLines(ctx, opts) {
  const { w, h, cell, offX, offY, emphasis } = opts;
  const startX = opts.startX || 0, startY = opts.startY || 0;
  const line = (x1, y1, x2, y2) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  const style = (i) => {
    if (i % 10 === 0) {
      ctx.strokeStyle = emphasis ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.35)';
      ctx.lineWidth = emphasis ? 1.5 : 1;
    } else if (emphasis && i % 5 === 0) {
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.lineWidth = 1;
    }
  };
  for (let x = 0; x <= w; x++) { style(startX + x); line(offX + x * cell, offY, offX + x * cell, offY + h * cell); }
  for (let y = 0; y <= h; y++) { style(startY + y); line(offX, offY + y * cell, offX + w * cell, offY + y * cell); }
}

// 文本宽度：真机 canvas 有 measureText；离线测试桩可能没有，
// 退化成「字符数 × 字号 × 0.6」（sans-serif 数字/大写字母平均字宽约 0.6em）。
function textWidth(ctx, text, fontPx) {
  if (ctx && typeof ctx.measureText === 'function') {
    try {
      const m = ctx.measureText(String(text));
      if (m && typeof m.width === 'number') return m.width;
    } catch (e) { /* 落到估算 */ }
  }
  return String(text).length * fontPx * 0.6;
}

// 图例「用量」那一栏的文本：建议购买量大于实际用量时印 a/b（审查 F11）。
function legendBuyText(c) {
  const cnt = (c && c.count != null) ? c.count : 0;
  return (c && c.suggest && c.suggest > cnt) ? (cnt + '/' + c.suggest) : String(cnt);
}

const LEG_SWATCH = 24;   // 色块边长
const LEG_TEXT_X = 36;   // 名称文本相对列起点的偏移（色块 24 + 间距 12）
const LEG_MID = 14;      // 名称与用量之间的间距
const LEG_PAD_R = 16;    // 用量右侧留白：贴着下一列色块也等于遮挡

// 图例排版：先量出「色块 + 色号名称 + 用量」真正需要多宽，再决定列宽/列数/字号。
//
// 旧版列宽写死（调用方传 300）、用量列写死（countX 传 240）：
// F11 把用量改成 `实际/建议购买`（如 2000/2100）之后，这段文本从 x+240 一直
// 画到 x+300 之外，直接压在下一列的色块上（复核报告 R4）。
// 这里改成**按实测宽度定列宽**，并保证用量右侧还留 LEG_PAD_R 的空白：
// 列宽不够时先缩字号（不低于 11px），仍不够就减列，绝不靠"画出去"解决。
//
// opts: { ctx, panel, cols, colWidth, fontPx, maxWidth, rowH, title, startY }
// 返回 { cols, colWidth, fontPx, nameW, rows, rowH, titleH, countX, bottom }
function legendLayout(ctx, opts) {
  const panel = (opts && opts.panel) || [];
  const maxWidth = (opts && opts.maxWidth) || 0;
  const given = (opts && opts.colWidth) || 0;
  let fontPx = (opts && opts.fontPx) || 15;
  let cols = Math.max(1, (opts && opts.cols) || 1);

  const measure = function (fp) {
    // textWidth 是"量当前画布字体"，并不认识 fp。所以必须先按 fp 把字体设上再量 ——
    // 否则不管 fp 传多少，量出来永远是调用方残留的那个字号：下面按字号收缩的重试
    // 会一次次量到同一个宽度（形同虚设），列宽也就跟着算错（复核报告 R4 复检）。
    const prevFont = ctx ? ctx.font : null;
    if (ctx) { try { ctx.font = fp + 'px sans-serif'; } catch (e) { /* 量不了就用估算 */ } }
    let nameW = 0, buyW = 0;
    panel.forEach(function (c) {
      const label = (c.sym ? c.sym + '  ' : '') + (c.code || '') + (c.name ? ' ' + c.name : '');
      const w = textWidth(ctx, label, fp);
      if (w > nameW) nameW = w;
      const b = textWidth(ctx, legendBuyText(c), fp);
      if (b > buyW) buyW = b;
    });
    if (ctx && prevFont != null) { try { ctx.font = prevFont; } catch (e) { /* 忽略 */ } }
    return { nameW: nameW, buyW: buyW, total: LEG_TEXT_X + nameW + LEG_MID + buyW + LEG_PAD_R };
  };

  let m = measure(fontPx);
  let colWidth = Math.max(given, m.total);
  if (maxWidth > 0) {
    // 先把列数减到放得下：减一列等于把每列可用宽度翻倍，比缩字号有效得多，
    // 而且不牺牲可读性。旧顺序是先缩字号、缩到 11px 才发现还是放不下再减列 ——
    // 那次字号牺牲纯属白费（复核 S5 复检：普通导出正是这样变成"2 列 + 11px"的）。
    while (cols > 1 && cols * colWidth > maxWidth) cols--;
    // 只剩一列还放不下，才动字号；下限 11px，再小就该由调用方加大画布了
    while (cols === 1 && colWidth > maxWidth && fontPx > 11) {
      fontPx -= 1;
      m = measure(fontPx);
      colWidth = Math.max(given, m.total);
    }
  }
  const rows = Math.max(1, Math.ceil(panel.length / cols));
  const rowH = (opts && opts.rowH) || 34;
  const titleH = (opts && opts.title) ? 26 : 0;
  const startY = (opts && opts.startY) || 0;
  return {
    cols: cols, colWidth: colWidth, fontPx: fontPx, nameW: m.nameW,
    rows: rows, rowH: rowH, titleH: titleH,
    countX: LEG_TEXT_X + m.nameW + LEG_MID,
    bottom: startY + titleH + rows * rowH
  };
}

// 绘制自动图例：色块 + 色号 + 名称 + 用量/建议购买
// opts: { ctx, panel, startX, startY, rowH, title, cols, colWidth, maxWidth, fontPx }
//   panel: [{ hex, code, name, count, sym?, suggest? }]，带 sym（字母）时在图例里
//          一并显示，与打印图格子上叠加的符号对应，方便按符号找色
//   cols/colWidth: 建议值；实际列宽取「建议值」与「实测需要值」的较大者，
//                  所以长文本不会被截断、也不会越到下一列（见 legendLayout）
//   maxWidth: 可用总宽（0=不限）。给定时超宽会先缩字号、再减列
//   返回图例底部的 y 坐标，便于调用方计算画布高度
function drawLegend(ctx, opts) {
  const { panel, startX, startY, title } = opts;
  const lay = legendLayout(ctx, opts);
  let ly = startY;
  if (title) {
    ctx.fillStyle = '#333';
    ctx.font = '600 18px sans-serif';
    ctx.fillText(title, startX, ly);
    ly += 26;
  }
  const top = ly;
  ctx.font = lay.fontPx + 'px sans-serif';
  panel.forEach((c, i) => {
    const col = lay.cols > 1 ? i % lay.cols : 0;
    const row = lay.cols > 1 ? Math.floor(i / lay.cols) : i;
    const x = startX + col * lay.colWidth;
    const y = top + row * lay.rowH;
    ctx.fillStyle = c.hex;
    ctx.fillRect(x, y, LEG_SWATCH, LEG_SWATCH);
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, LEG_SWATCH, LEG_SWATCH);
    ctx.fillStyle = '#222';
    ctx.fillText(`${c.sym ? c.sym + '  ' : ''}${c.code}${c.name ? ' ' + c.name : ''}`, x + LEG_TEXT_X, y + 18);
    // 用量 / 建议购买 一起印：标题承诺"含备用"，就必须给出建议购买量，
    // 只印实际用量等于让用户照实数买，缺口没有兜底（审查 F11）。
    // 位置由 legendLayout 按实测名称宽度算出，不再写死（复核 R4）。
    ctx.fillText(legendBuyText(c), x + lay.countX, y + 18);
  });
  return top + lay.rows * lay.rowH;
}

module.exports = {
  drawGrid, drawBeadCell, drawCoordLines, drawLegend, legendLayout, textWidth,
  legendBuyText, labelFontPx, minCellForLabel
};
