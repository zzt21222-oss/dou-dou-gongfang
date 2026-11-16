// pages/preview/preview.js
const app = getApp();
const storage = require('../../utils/storage.js');
const render = require('../../utils/render.js');
const paletteLoader = require('../../utils/paletteLoader.js');
const brandConvert = require('../../utils/brandConvert.js');

// 打印纸面规格（复核报告 R4，用户选定参数）
//   A4 横向 297×210mm · 四边 10mm 可打印边距 · 最小可读字号 8pt
// 由这三项反推每页像素尺寸与格宽，而不是"把整张网格塞进一张画布再缩放"。
const PRINT = {
  paperW: 297,   // mm
  paperH: 210,   // mm
  marginMM: 10,  // mm
  minPt: 8,      // 磅：纸面上低于这个字号就不可读
  dpi: 150       // 纸面栅格密度：150dpi ≈ 5.9055 px/mm
};

Page({
  data: {
    mode: 'pixel',
    w: 0, h: 0,
    totalCount: 0,
    palettePanel: [],
    showBuy: false,
    buyList: [],
    a11yClass: '',
    cvW: 300,   // 画布 CSS 宽(px)：按设备宽度 × 网格比例自适应
    cvH: 300,
    recId: '',  // 当前图纸对应的历史记录 id（来自历史则为原 id，新图纸为空）
    brandName: '', // 当前色号系统名（导出标题上标注）
    // 旧作品的色号系统无法识别（迁移层标记）时为 true。此时**一切导出都被拦下**：
    // 色号不可信，导出的图纸与采购清单会误导用户买错豆子（复核 R3）。
    brandUnknown: false,
    brandNames: []  // 供页面上的品牌选择器使用
  },

  project: null,
  colorMeta: {},
  grid: [],
  idSymbol: {},
  cell: 10,
  offX: 0,
  offY: 0,
  area: null,
  exportPath: '',

  onLoad() {
    const p = app.globalData.project;
    if (!p || !p.grid) {
      wx.showToast({ title: '无图纸数据', icon: 'none' });
      return;
    }
    this.project = p;
    this.colorMeta = p.colorMeta || {};
    // 与编辑器同理：早期数据可能把 Int32Array 写成了普通对象，这里统一归一化
    this.grid = storage.toGridArray(p.grid);
    this.buildPanel();
    this.buildSymbols();
    this.brandUnknown = !!p.brandUnknown;
    this.setData({
      brandUnknown: this.brandUnknown,
      brandNames: paletteLoader.getBrandList().map(function (b) { return b.name; })
    });
    // recId 有值 = 这张图来自历史里的某条记录，保存时应更新它而不是新增
    // 色号系统名：取自记录的 brand；老图纸没有 brand 就留空（标题不标品牌）
    let brandName = '';
    if (p.brand) {
      const bi = paletteLoader.getPaletteInfo(p.brand);
      brandName = bi.brandName || '';
    }
    this.setData({ w: p.w, h: p.h, recId: p.recId || '', brandName: brandName });
  },

  onShow() {
    const acc = (app.globalData.prefs && app.globalData.prefs.accessibility) || {};
    const cls = (acc.largeFont ? ' a11y-lg' : '') + (acc.highContrast ? ' a11y-hc' : '');
    this.setData({ a11yClass: cls.trim() });
  },

  noop() {},

  onReady() {
    this.ensureCanvas().then(() => {
      this.computeCell();
      this.renderPreview();
    });
  },

  buildPanel() {
    const counts = {};
    for (const id of this.grid) { if (id < 0) continue; counts[id] = (counts[id] || 0) + 1; }
    let total = 0;
    const panel = Object.keys(this.colorMeta).map(id => {
      const m = this.colorMeta[id];
      const cnt = counts[id] || 0; total += cnt;
      // 带上 rgb：存进历史后，编辑器/缩略图可直接用，不必再靠 hex 反解（旧数据缺 rgb 会走兜底）
      return { id: +id, rgb: m.rgb, code: m.code, name: m.name, hex: m.hex, short: m.short || m.code, count: cnt, suggest: Math.ceil(cnt * 1.05) };
    }).filter(c => c.count > 0).sort((a, b) => b.count - a.count);
    this.setData({ palettePanel: panel, totalCount: total });
  },

  buildSymbols() {
    const map = {};
    this.data.palettePanel.forEach((c, i) => { map[c.id] = String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''); });
    this.idSymbol = map;
  },

  ensureCanvas() {
    if (this.canvas) return Promise.resolve();
    return new Promise((resolve) => {
      const q = wx.createSelectorQuery();
      q.select('#wrap').boundingClientRect().select('#cv').fields({ node: true }).exec((res) => {
        const rect = res[0];
        const node = res[1].node;
        const win = wx.getWindowInfo();
        this._wrapW = rect.width;
        this._winH = win.windowHeight || 600;
        this._dpr = win.pixelRatio || 2;
        this.canvas = node;
        this._refitCanvas();
        this.ctx.imageSmoothingEnabled = false;
        resolve();
      });
    });
  },

  // 画布自适应：宽 = 容器可用宽（各端独立），高 = 宽 × 网格高宽比；超高按窗口高 62% 封顶并等比收宽。
  // 网格铺满画布、不拉伸不变形，cell 取该设备最大值。
  _refitCanvas() {
    if (!this.canvas || !this._wrapW) return;
    const maxH = Math.max(240, Math.floor(this._winH * 0.62));
    const w = this.data.w || 1, h = this.data.h || 1;
    let cvW = Math.floor(this._wrapW);
    let cvH = Math.round(cvW * h / w);
    if (cvH > maxH) { cvH = maxH; cvW = Math.round(cvH * w / h); }
    cvW = Math.max(50, cvW); cvH = Math.max(50, cvH);
    if (cvW === this.data.cvW && cvH === this.data.cvH && this.area) return;
    this.canvas.width = cvW * this._dpr;
    this.canvas.height = cvH * this._dpr;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.scale(this._dpr, this._dpr);
    this.area = { width: cvW, height: cvH };
    this.setData({ cvW, cvH });
  },

  computeCell() {
    if (!this.area) return;
    const cell = Math.floor(Math.min(this.area.width / this.data.w, this.area.height / this.data.h));
    this.cell = Math.max(1, cell);
  },

  setMode(e) { this.setData({ mode: e.currentTarget.dataset.mode }); this.renderPreview(); },

  renderPreview() {
    if (!this.ctx) return;
    this._refitCanvas();   // 画布尺寸跟随网格比例，铺满无留白
    this.computeCell();    // refit 后 area 变了，cell 必须重算
    const { ctx, area } = this;
    const w = this.data.w, h = this.data.h, mode = this.data.mode;
    ctx.clearRect(0, 0, area.width, area.height);
    // 白底：格子缝隙透出白色而不是透明/灰，颜色更干净鲜艳（去暗优化）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, area.width, area.height);
    const cell = this.cell;
    const offX = Math.floor((area.width - cell * w) / 2);
    const offY = Math.floor((area.height - cell * h) / 2);
    this.offX = offX; this.offY = offY;

    // 像素 / 豆子 / 符号 三模式统一绘制（正方形格 + 间隙 + 高光）
    render.drawGrid(ctx, {
      grid: this.grid, w, h, cell, offX, offY,
      colorMeta: this.colorMeta, mode, symbolMap: this.idSymbol
    });

    // 网格线：像素模式下显示坐标辅助线（每 10 格加粗）
    if (this.data.mode === 'pixel') {
      render.drawCoordLines(ctx, { w, h, cell, offX, offY });
    }

    if (this.project.boards) {
      ctx.strokeStyle = 'rgba(255,122,69,0.9)';
      ctx.lineWidth = 2;
      this.project.boards.boards.forEach(b => {
        ctx.strokeRect(offX + b.x * cell, offY + b.y * cell, b.w * cell, b.h * cell);
        ctx.fillStyle = '#ff7a45';
        ctx.font = '14px sans-serif';
        ctx.fillText(String(b.seq), offX + b.x * cell + 4, offY + b.y * cell + 18);
      });
    }
  },

  _today() {
    const d = new Date(), p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  },

  // 导出图纸。withCode=true 时在每格印色号，false 为纯图纸。
  //
  // 这里有两个关键改动：
  // 1) 导出改用 pixel 平面色块，不再用 bead 立体模式——bead 的外圈压暗(×0.8)和中心
  //    28% 白高光会明显压低饱和度，导出的图纸颜色发灰、小格子上显得脏。
  // 2) cell 不再写死 16px，而是让长边落在 ~1500px，小图格子更大更清楚。
  _exportGrid(withCode) {
    const w = this.data.w, h = this.data.h, panel = this.data.palettePanel;
    const margin = 40, titleH = 76, coord = 34;

    let cell = Math.floor(1500 / Math.max(w, h));
    cell = Math.max(10, Math.min(40, cell));
    // 画布边长安全上限（微信 canvas 上限约 4096，留足余量）
    while ((cell * w > 3200 || cell * h > 3200) && cell > 4) cell--;

    const gridW = cell * w, gridH = cell * h;
    // 图例布局必须先算、再定画布（复核 S5）。
    // 旧版反过来：先用写死的 300px 列宽算画布宽度，再让 drawLegend 自己去排，
    // 而 drawLegend 现在会按**实测文本**把列撑宽（长名称 / Toasted Marshmallow 之类），
    // 于是右列的数量文本被排到画布外裁掉 —— 组件内部改了布局，外层容器没跟着变。
    const legendColsWanted = panel.length > 6 ? 3 : (panel.length > 3 ? 2 : 1);
    const legendRowH = 34;
    const baseW = gridW + coord + margin * 2;       // 网格本身需要的宽度
    // 图例可用宽度：不能小于一个合理下限，也不能把画布顶过微信的 canvas 上限
    const legendAvail = Math.max(300, Math.min(3200, Math.max(baseW, 900)) - margin * 2);
    const legendSelect = render.legendLayout(this._measureCtx(), {
      panel: panel, cols: legendColsWanted, maxWidth: legendAvail, fontPx: 15, rowH: legendRowH
    });
    const legendW = legendSelect.cols * legendSelect.colWidth;
    const legendH = 26 + legendSelect.rows * legendRowH;
    // 标题行也要参与尺寸计算：色数少的时候画布宽度由网格决定，
    // 而"共 N 粒 · …品牌色号…"这行字幕会比网格还宽，同样会被裁（复核 S5 同族）。
    const subtitle = '共 ' + this.data.totalCount + ' 粒 · ' + panel.length + ' 色 · ' +
      (this.data.brandName ? this.data.brandName + ' 色号 · ' : '') +
      (withCode ? '每格标注色号' : '纯图纸（无标注）') + ' · ' + this._today();
    const meas = this._measure();
    const headNeed = margin * 2 + 8 + Math.max(
      meas('拼豆图纸 ' + w + '×' + h, 30),
      meas(subtitle, 17)
    );
    const cw = Math.max(baseW, legendW + margin * 2, headNeed);
    const ch = margin + titleH + coord + gridH + 46 + legendH + margin;

    const off = wx.createOffscreenCanvas({ type: '2d', width: cw, height: ch });
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    // 整张图纸加一圈极浅边框，成品看起来更完整
    ctx.strokeStyle = '#e6e6e6';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, cw - 2, ch - 2);

    ctx.fillStyle = '#222';
    ctx.font = '600 30px sans-serif';
    ctx.fillText('拼豆图纸 ' + w + '×' + h, margin, margin + 30);
    ctx.fillStyle = '#777';
    ctx.font = '17px sans-serif';
    // 这行字符串在算画布宽度时已经量过（headNeed），此处直接画
    ctx.fillText(subtitle, margin, margin + 58);

    const gx = Math.round((cw - gridW) / 2);
    const gy = margin + titleH + coord;

    // 坐标数字：格子小的时候抽稀标（每 2 格 / 每 5 格一次），否则数字会糊成一片
    const step = cell >= 14 ? 1 : (cell >= 8 ? 2 : 5);
    ctx.fillStyle = '#444';
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let x = 0; x < w; x++) {
      if (x === 0 || (x + 1) % step === 0) ctx.fillText(String(x + 1), gx + x * cell + cell / 2, gy - 16);
    }
    for (let y = 0; y < h; y++) {
      if (y === 0 || (y + 1) % step === 0) ctx.fillText(String(y + 1), gx - 16, gy + y * cell + cell / 2);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    render.drawGrid(ctx, {
      grid: this.grid, w, h, cell, offX: gx, offY: gy,
      colorMeta: this.colorMeta, mode: 'pixel',
      showCode: withCode, labelMinCell: 10
    });
    render.drawCoordLines(ctx, { w, h, cell, offX: gx, offY: gy, emphasis: true });

    if (this.project.boards) {
      ctx.strokeStyle = 'rgba(255,122,69,0.9)';
      ctx.lineWidth = 2;
      this.project.boards.boards.forEach(b => {
        ctx.strokeRect(gx + b.x * cell, gy + b.y * cell, b.w * cell, b.h * cell);
        ctx.fillStyle = '#ff7a45';
        ctx.font = '14px sans-serif';
        ctx.fillText(String(b.seq), gx + b.x * cell + 3, gy + b.y * cell + 16);
      });
    }

    // 用**刚才那套**布局参数画图例：画布是按 legendSelect 定的尺寸，
    // 这里必须给出同样的输入，否则又会各排一套、再次裁到画布外。
    render.drawLegend(ctx, {
      panel, startX: margin, startY: gy + gridH + 46, rowH: legendRowH,
      title: '色卡 / 用量 · 建议购买（+5% 备用）',
      cols: legendSelect.cols, colWidth: legendSelect.colWidth,
      fontPx: legendSelect.fontPx, maxWidth: legendAvail
    });

    const that = this;
    // 生成 + 存相册是秒级重操作，全程挂 loading（收尾在 _saveToAlbum 的 success/fail 里）
    wx.showLoading({ title: '正在生成图纸…', mask: true });
    wx.canvasToTempFilePath({
      canvas: off,
      success: (res) => {
        that.exportPath = res.tempFilePath;
        that._saveToAlbum(res.tempFilePath, withCode ? '带色号图纸已保存' : '纯图纸已保存');
      },
      fail: (err) => {
        wx.hideLoading();
        wx.showModal({
          title: '图纸生成失败',
          content: String((err && err.errMsg) || '未知原因') + '\n图纸过大时可能失败，可尝试减少颜色数或尺寸后重试。',
          showCancel: false
        });
      }
    });
  },

  // 带色号图纸：每格印色号，照着拼不用再查图例
  exportImage() { if (this._brandBlocked()) return; this._exportGrid(true); },
  // 纯图纸：只有色块，适合当底稿或自己再标注
  exportPlain() { if (this._brandBlocked()) return; this._exportGrid(false); },

  // 保存到系统相册。官方接口是 wx.saveImageToPhotosAlbum（旧代码误写成 saveImageToAlbum，
  // 该接口不存在，导致导出必然失败）。失败时要分清原因，否则用户只看到「失败」不知道怎么办：
  //   1) 权限被拒 → 引导去设置页重新打开授权
  //   2) 用户取消 → 不打扰
  //   3) 其他 → 展示原始错误，便于排查
  // onDone：多页打印时，这一页存完继续下一页
  // okTitle 传空串 = 本次不弹成功 toast（打印序列逐页保存时进度由 loading 文案承担，
  // 全部完成再统一提示；否则 51 张会连弹 51 个 toast）。
  // onDone 收到 'cancel' 表示用户中途取消存图——调用方必须停下序列，否则 loading 会挂死。
  _saveToAlbum(filePath, okTitle, onDone) {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => {
        if (okTitle) { wx.hideLoading(); wx.showToast({ title: okTitle }); }
        if (onDone) onDone();
      },
      fail: (err) => {
        wx.hideLoading();
        const msg = String((err && err.errMsg) || '');
        if (msg.indexOf('cancel') >= 0) { if (onDone) onDone('cancel'); return; }
        if (msg.indexOf('auth') >= 0 || msg.indexOf('authorize') >= 0) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存到相册需要你的授权。点「去设置」打开「保存到相册」后重试。',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting({}); }
          });
          return;
        }
        wx.showModal({
          title: '保存失败',
          content: (msg || '未知原因') + '\n可检查手机存储空间后重试。',
          showCancel: false
        });
      }
    });
  },

  copyBOM() {
    if (this._brandBlocked()) return;
    const lines = ['色号,名称,数量,建议购买(+5%)'];
    this.data.palettePanel.forEach(c => lines.push(`${c.code},${c.name},${c.count},${c.suggest}`));
    lines.push(`合计,${this.data.totalCount}粒`);
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '清单已复制' }) });
  },

  // 组装要落库的图纸数据。字段一次存全，历史回看时才能完整还原（原图/形状/缩印方式等），
  // 旧版漏存 src/shape/fitMode，导致「从历史打开」丢原图、切形状基于已掩膜的图再掩一次。
  _snapshot(extra) {
    const p = this.project;
    const snap = {
      note: '',
      w: p.w, h: p.h,
      algorithm: p.algorithm, colorCount: p.colorCount,
      brand: p.brand, lockBrand: p.lockBrand,
      // 色号系统未知时必须把标记一起存下来：否则下次打开这条记录，
      // 迁移层会把它当成"品牌已知"去改写色号，错误就此固化成"可信"数据（复核 R3）
      brandUnknown: !!this.brandUnknown,
      shape: p.shape || 'rect',
      fitMode: p.fitMode || 'contain',
      src: p.src || '',
      grid: this.grid,
      colors: this.data.palettePanel,
      // colorMeta 必须**全量**存：palettePanel 只含当前可见的颜色，
      // 只存它的话，形状藏起来的格子重开再切矩形就没有颜色元数据，
      // 绘图会直接报 reading 'rgb'（审查 F06c）。
      colorMeta: this.colorMeta,
      boards: p.boards,
      locked: p.locked
    };
    // fullGrid（权威网格，未做形状掩膜）只在非矩形时存：矩形的掩膜是全 1，
    // grid 与 fullGrid 完全等价，没有额外信息。切形状要以它为底，
    // 否则会拿已经掩过一次的网格再掩一次。
    if (p.fullGrid && (p.shape && p.shape !== 'rect')) snap.fullGrid = p.fullGrid;
    return Object.assign(snap, extra || {});
  },

  // 保存到历史：来自已有记录 → 原地更新；新图纸 → 新增一条。
  // 旧版每次都 addProject，导致同一张图改几次就在列表里堆几个副本。
  saveHistory() {
    const id = this.project && this.project.recId;
    if (id && storage.getProject(id)) {
      const r = storage.updateProject(id, this._snapshot());
      if (!r) return this._saveFail();
      storage.clearDraft(); // 已进历史，草稿使命完成
      wx.showToast({ title: '已更新原作品' });
      return;
    }
    this._createHistory('已存入历史');
  },

  // 另存为新的一份：保留原作品不动，适合在原图上试了另一版方案
  saveAsNew() {
    this._createHistory('已另存为新图纸');
  },

  _createHistory(okTitle) {
    const rec = storage.addProject(this._snapshot({ name: `图纸 ${this.data.w}×${this.data.h}` }));
    if (!rec) return this._saveFail();
    // 记住新 id：之后再点保存就是更新这一条，而不是又建一条
    this.project.recId = rec.id;
    this.setData({ recId: rec.id });
    storage.clearDraft();
    wx.showToast({ title: okTitle });
  },

  _saveFail() {
    wx.showModal({
      title: '保存失败',
      content: '本机存储空间已满（单类数据上限 1MB）。请到「历史」页删除一些不再需要的图纸后重试。',
      showCancel: false
    });
  },

  // ===== 打印图纸：固定 A4 横向纸面（复核 R4 重做）=====
  //
  // 旧版（组 C）虽然不再把网格画出画布外，但仍不是能施工的图纸：
  //   ① 页面尺寸随内容变 —— 第一排 1240×3388、下一排 1240×2524，各自"适应页面"
  //      后格子的物理尺寸不一样，按比例拼接连不上；
  //   ② 格宽只有 24px，换算到 A4 横向约 1.49mm/格、三字符色号约 2.11pt，
  //      实体打出来看不清（几何换算，不是打印测量，但量级差得太远）；
  //   ③ 图例列宽写死、用量列写死 x+240，`2000/2100` 会压在下一列色块上。
  //
  // 现在改成"纸面优先"：
  //   1) 先按纸张定死每页像素尺寸（A4 横向、四边 10mm 边距、150dpi →
  //      1754×1240），**所有页（含末页）尺寸与缩放完全一致**，可直接拼接；
  //   2) 由目标最小字号 8pt 反推最小格宽：render.drawGrid 里格内色号字号
  //      约为 0.5×格宽，所以 8pt 需要格宽 ≥ 2×8×150/72 = 34px
  //      （合 5.76mm/格、字号 8.16pt）。再由格宽算出每页放多少列/行；
  //   3) 格内色号一律印出：labelMinCell 就取最小格宽，不会再被"格子太小"关掉；
  //   4) 完整色卡 / 采购清单单独出页，长数量文本只在那一页出现，
  //      列宽按实测文本宽度自适应（utils/render.js legendLayout）；
  //   5) 导出前先算总页数告诉用户 —— 可读字号必然增加页数，那是真实的
  //      纸张与墨水成本，不能让用户存完 40 多张才发现。

  // 每页纸面几何。所有页共用同一套值，这是"能拼接"的前提。
  _printMetrics() {
    const pxPerMM = PRINT.dpi / 25.4;
    // 最小字号换算成像素：8pt @150dpi ⇒ 16.67px，而字号取整是向下取整，
    // 所以要向上取到 17px，实际印出来才是 8.16pt。
    const fsNeed = Math.ceil(PRINT.minPt * PRINT.dpi / 72);
    // 格宽要同时满足两条（复核报告 S4）：
    //   ① 字号不超过格子一半          ⇒ cell ≥ 2 × fsNeed
    //   ② 整串色号宽度放得下          ⇒ 由 render.labelFontPx 反推
    // 旧版只算了 ①，于是四字符色号（Artkal C100 / Hama H101 / Perler 5179）
    // 会走②的宽度限制降到 13px = 6.24pt，跌破用户定的 8pt 下限。
    // 反推用的是**绘制时同一个函数**，避免版面与绘制再次各算一套。
    let minCell = Math.ceil(2 * fsNeed);
    const meta = this.colorMeta || {};
    Object.keys(meta).forEach((k) => {
      const m = meta[k] || {};
      const label = m.short || m.code || '';
      if (!label) return;
      const need = render.minCellForLabel(label, fsNeed);
      if (need > minCell) minCell = need;
    });
    return {
      pxPerMM: pxPerMM,
      PW: Math.round(PRINT.paperW * pxPerMM),
      PH: Math.round(PRINT.paperH * pxPerMM),
      M: Math.round(PRINT.marginMM * pxPerMM),
      FS_NEED: fsNeed,
      MIN_CELL: minCell
    };
  },

  // 排版用的离屏画布（只量文本，不画画）。_measure 与 legendLayout 共用一张：
  // legendLayout 要量文本才能算出最终列宽，而画布尺寸又取决于那个列宽 ——
  // 必须先量、后建画布，不能反过来（复核 S5）。
  _measureCtx() {
    if (!this._mctx) {
      const off = wx.createOffscreenCanvas({ type: '2d', width: 8, height: 8 });
      this._mctx = off.getContext('2d');
    }
    return this._mctx;
  },

  // 文本测宽：借上面那张 8×8 离屏画布，只用于排版计算
  _measure() {
    const c = this._measureCtx();
    return function (text, fontPx) {
      c.font = (fontPx || 15) + 'px sans-serif';
      try {
        const m = c.measureText(String(text));
        if (m && typeof m.width === 'number') return m.width;
      } catch (e) { /* 落到估算 */ }
      return String(text).length * (fontPx || 15) * 0.6;
    };
  },

  // 版面：先把纸面定死，再算每页行列与页脚高度
  _printLayout() {
    const w = this.data.w, h = this.data.h, panel = this.data.palettePanel;
    const mm = this._printMetrics();
    const tw = this._measure();
    const HEADER_H = 78;   // 标题 + 副标题 + 页码行
    const GUTTER = 36;     // 左侧行号 / 顶部列号的占位
    const cell = mm.MIN_CELL;

    // ---- 页脚（每页同样高度，页页等高；底边对齐，不随网格行数漂移）----
    const chipRowH = 26, chipPadRight = 14, chipTextX = 34, chipSwatch = 18;
    let chipW = 0;
    panel.forEach(c => {
      const t = (c.code || '') + (c.name && c.name !== c.code ? ' ' + c.name : '');
      // 字号同样按最小字号（17px）实测，与实际绘制保持一致
      const cw = chipTextX + tw(t, 17) + chipPadRight;
      if (cw > chipW) chipW = cw;
    });
    chipW = Math.max(90, chipW);
    const chipCols = Math.max(1, Math.floor((mm.PW - mm.M * 2) / chipW));
    const chipRows = Math.max(1, Math.ceil(panel.length / chipCols));
    const chipsH = chipRows * chipRowH;
    const MAP_H = 170;      // 拼接位置示意图
    const PAGE_LINE_H = 30; // 底部说明行
    const MAP_GAP = 10, CHIP_GAP = 12;
    const FOOTER_H = CHIP_GAP + chipsH + MAP_GAP + MAP_H + PAGE_LINE_H;

    // ---- 每页放多少格 ----
    const availW = mm.PW - mm.M * 2 - GUTTER;
    const availH = mm.PH - mm.M * 2 - HEADER_H - GUTTER - FOOTER_H;
    const cols = Math.max(1, Math.floor(availW / cell));
    const rows = Math.max(1, Math.floor(availH / cell));
    const pagesX = Math.ceil(w / cols);
    const pagesY = Math.ceil(h / rows);
    const pageCount = Math.max(1, pagesX * pagesY);

    const bom = this._bomLayout(mm, tw, panel);

    return {
      mm: mm, tw: tw, cell: cell,
      cols: cols, rows: rows, pagesX: pagesX, pagesY: pagesY, pageCount: pageCount,
      single: pageCount === 1,
      HEADER_H: HEADER_H, GUTTER: GUTTER, FOOTER_H: FOOTER_H,
      chipsH: chipsH, chipRowH: chipRowH, chipW: chipW, chipCols: chipCols,
      chipTextX: chipTextX, chipSwatch: chipSwatch,
      MAP_H: MAP_H, MAP_GAP: MAP_GAP, CHIP_GAP: CHIP_GAP, PAGE_LINE_H: PAGE_LINE_H,
      bom: bom, bomPages: bom.pages,
      totalPages: pageCount + bom.pages
    };
  },

  // 采购清单页的列宽与每页行数。列宽全部按实测文本宽度算 ——
  // 这是"长数量不遮挡"的根治办法（复核 R4）：不再有写死的 240/300。
  _bomLayout(mm, tw, panel) {
    const maxOf = function (arr, init) {
      let m = init;
      for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
      return m;
    };
    const PAD = 18, BOM_SWATCH = 20;
    // 测宽用的字号必须**等于实际绘制用的字号**（都是 17px，即 8.16pt），
    // 否则列宽会按小一号的字算出来，正文一印就压到下一列（复核 S4）。
    const BODY_PX = 17;
    const w1 = BOM_SWATCH + 12 + Math.max(tw('色号', BODY_PX), maxOf(panel.map(c => tw(c.code || '', BODY_PX)), 0)) + PAD;
    const w2 = Math.max(tw('名称', BODY_PX), maxOf(panel.map(c => tw(c.name || '', BODY_PX)), 0)) + PAD;
    const w3 = Math.max(tw('实际用量', BODY_PX), maxOf(panel.map(c => tw(String(c.count || 0), BODY_PX)), 0)) + PAD;
    const w4 = Math.max(tw('建议购买(+5%)', BODY_PX), maxOf(panel.map(c => tw(String(c.suggest || 0), BODY_PX)), 0)) + PAD;
    const w5 = Math.max(tw('色值', BODY_PX), maxOf(panel.map(c => tw(c.hex || '', BODY_PX)), 0)) + PAD;
    let colW = [w1, w2, w3, w4, w5];
    let total = w1 + w2 + w3 + w4 + w5;
    const availTotal = mm.PW - mm.M * 2;
    // 先按实测宽度定底线，再把表格撑满纸面宽度：只占纸面四分之一宽的清单
    // 既难看也浪费纸。超宽（名称特别长）则按比例收窄。
    const k = availTotal / total;
    colW = colW.map(v => Math.floor(v * k));
    total = colW.reduce((a, b) => a + b, 0);
    const rowH = 34, headH = 44, titleH = 96, footH = 70;
    const top = mm.M + titleH + headH;
    const bottom = mm.PH - mm.M - footH;
    const perPage = Math.max(4, Math.floor((bottom - top) / rowH));
    const pages = Math.max(1, Math.ceil(panel.length / perPage));
    return { colW: colW, rowH: rowH, headH: headH, titleH: titleH, footH: footH, perPage: perPage, pages: pages };
  },

  // 拼接位置示意图：画在页脚固定位置，标出当前是第几页
  _drawPageMap(ctx, lay, px, py, top) {
    const mm = lay.mm;
    const availW = 260;
    const availH = lay.MAP_H;
    const gap = 3;
    let sq = Math.floor(Math.min(
      (availW - (lay.pagesX - 1) * gap) / lay.pagesX,
      (availH - 16 - (lay.pagesY - 1) * gap) / lay.pagesY
    ));
    sq = Math.max(6, Math.min(24, sq));
    const x0 = mm.PW - mm.M - (lay.pagesX * (sq + gap) - gap);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    // 纸面上所有文字都不得低于最小字号（复核 S4：旧版这里 15px = 7.2pt）
    ctx.fillStyle = '#333'; ctx.font = '600 17px sans-serif';
    ctx.fillText('拼接位置', x0, top);
    for (let r = 0; r < lay.pagesY; r++) {
      for (let c = 0; c < lay.pagesX; c++) {
        const x = x0 + c * (sq + gap), y = top + 12 + r * (sq + gap);
        const cur = (r === py && c === px);
        ctx.fillStyle = cur ? '#ff7a45' : '#f4f4f4';
        ctx.fillRect(x, y, sq, sq);
        ctx.strokeStyle = cur ? '#c0392b' : '#ccc'; ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, sq - 1, sq - 1);
      }
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  },

  // 只生成第 px/py 个区块的画布。纸面尺寸固定，一次只持有一张。
  _buildPrintPage(lay, px, py) {
    const w = this.data.w, h = this.data.h, panel = this.data.palettePanel;
    const mm = lay.mm, M = mm.M, cell = lay.cell;
    const index = py * lay.pagesX + px;
    const colStart = px * lay.cols, colEnd = Math.min(w, colStart + lay.cols);
    const rowStart = py * lay.rows, rowEnd = Math.min(h, rowStart + lay.rows);
    const tw = colEnd - colStart, th = rowEnd - rowStart;
    // 左对齐（不居中）：同一列的页在横向位置一致，拼起来才对得齐
    const gx = M + lay.GUTTER;
    const gy = M + lay.HEADER_H + lay.GUTTER;

    const off = wx.createOffscreenCanvas({ type: '2d', width: mm.PW, height: mm.PH });
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, mm.PW, mm.PH);
    ctx.strokeStyle = '#e6e6e6'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, mm.PW - 2, mm.PH - 2);

    // ---- 页眉 ----
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#222'; ctx.font = '600 30px sans-serif';
    ctx.fillText('拼豆施工图纸 ' + w + '×' + h, M, M + 30);
    ctx.fillStyle = '#777'; ctx.font = '17px sans-serif';
    ctx.fillText('共 ' + this.data.totalCount + ' 粒 · ' + panel.length + ' 色 · ' +
      (this.data.brandName ? this.data.brandName + ' 色号 · ' : '') +
      '每格 ' + (cell / mm.pxPerMM).toFixed(1) + 'mm · 格内为品牌色号 · ' + this._today(),
      M, M + 58);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#c0392b'; ctx.font = '600 20px sans-serif';
    ctx.fillText('第 ' + (index + 1) + '/' + lay.pageCount + ' 页 · 列 ' +
      (colStart + 1) + '-' + colEnd + ' · 行 ' + (rowStart + 1) + '-' + rowEnd,
      mm.PW - M, M + 58);
    ctx.textAlign = 'left';

    // 坐标数字：用**绝对**坐标，且按格子大小抽稀，避免大图数字糊成一条
    // 字号同样受最小字号约束（旧版 16px = 7.68pt）
    const step = cell >= 14 ? 1 : (cell >= 8 ? 2 : 5);
    ctx.fillStyle = '#444'; ctx.font = '17px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let x = 0; x < tw; x++) {
      const ax = colStart + x;
      if (ax === 0 || (ax + 1) % step === 0) ctx.fillText(String(ax + 1), gx + x * cell + cell / 2, gy - 14);
    }
    for (let y = 0; y < th; y++) {
      const ay = rowStart + y;
      if (ay === 0 || (ay + 1) % step === 0) ctx.fillText(String(ay + 1), gx - 16, gy + y * cell + cell / 2);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';

    // 只取本页那一片网格：drawGrid 按传入的 w（=本页列数）索引
    const tile = new Array(tw * th);
    const used = {};
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const v = this.grid[(rowStart + y) * w + colStart + x];
        tile[y * tw + x] = v;
        if (v >= 0) used[v] = (used[v] || 0) + 1;
      }
    }
    // 格内直接印「色号」：拼的时候一眼对上豆子，不用回查图例。
    // labelMinCell 取最小格宽 —— 我们已经保证 cell ≥ 最小格宽，所以色号必定印出。
    render.drawGrid(ctx, {
      grid: tile, w: tw, h: th, cell: cell, offX: gx, offY: gy,
      colorMeta: this.colorMeta, mode: 'pixel',
      showCode: true, labelMinCell: cell
    });
    render.drawCoordLines(ctx, {
      w: tw, h: th, cell: cell, offX: gx, offY: gy, emphasis: true,
      startX: colStart, startY: rowStart
    });

    // 分板框：按本页做算术裁剪，跨页的板只画落在本页的那一段
    const boards = this.project.boards && this.project.boards.boards;
    if (boards) {
      ctx.strokeStyle = 'rgba(255,122,69,0.9)'; ctx.lineWidth = 3;
      ctx.fillStyle = '#ff7a45'; ctx.font = '18px sans-serif'; ctx.textAlign = 'left';
      boards.forEach(b => {
        const bx0 = Math.max(b.x, colStart), bx1 = Math.min(b.x + b.w, colEnd);
        const by0 = Math.max(b.y, rowStart), by1 = Math.min(b.y + b.h, rowEnd);
        if (bx1 <= bx0 || by1 <= by0) return;   // 本页没有这块板
        ctx.strokeRect(gx + (bx0 - colStart) * cell, gy + (by0 - rowStart) * cell,
          (bx1 - bx0) * cell, (by1 - by0) * cell);
        // 序号只画在板的原始左上角（且该角正好落在本页内），避免被裁到角落后指错板
        if (b.x >= colStart && b.x < colEnd && b.y >= rowStart && b.y < rowEnd) {
          ctx.fillText(String(b.seq), gx + (b.x - colStart) * cell + 4, gy + (b.y - rowStart) * cell + 20);
        }
      });
    }

    // ---- 页脚（底边对齐，所有页位置一致）----
    const pageLineY = mm.PH - M - 8;
    const mapTop = pageLineY - lay.PAGE_LINE_H - lay.MAP_H;
    const chipsTop = mapTop - lay.MAP_GAP - lay.chipsH;
    const pageCols = panel.filter(c => used[c.id]);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    pageCols.forEach((c, i) => {
      const col = i % lay.chipCols, row = Math.floor(i / lay.chipCols);
      const x = M + col * lay.chipW;
      const y = chipsTop + row * lay.chipRowH;
      ctx.fillStyle = c.hex;
      ctx.fillRect(x, y + 2, lay.chipSwatch, lay.chipSwatch);
      ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 2.5, lay.chipSwatch - 1, lay.chipSwatch - 1);
      ctx.fillStyle = '#222'; ctx.font = '17px sans-serif';
      ctx.fillText(String(c.code || ''), x + lay.chipTextX, y + 17);
    });
    if (lay.pageCount > 1) this._drawPageMap(ctx, lay, px, py, mapTop + 14);
    ctx.fillStyle = '#999'; ctx.font = '17px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('第 ' + (index + 1) + ' / ' + lay.pageCount + ' 页 · 本页 ' +
      Object.keys(used).reduce((a, k) => a + used[k], 0) + ' 粒 · 格内数字为品牌色号，' +
      '完整色卡与采购清单见最后一页' +
      (lay.pageCount > 1 ? ' · 按页码顺序拼接（左上为第 1 页）' : ''),
      mm.PW / 2, pageLineY);
    ctx.textAlign = 'left';
    return off;
  },

  // 采购清单页（单独出页）：色号 / 名称 / 实际用量 / 建议购买 / 色值
  _buildBomPage(lay, index) {
    const mm = lay.mm, M = mm.M, panel = this.data.palettePanel, bom = lay.bom;
    const off = wx.createOffscreenCanvas({ type: '2d', width: mm.PW, height: mm.PH });
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, mm.PW, mm.PH);
    ctx.strokeStyle = '#e6e6e6'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, mm.PW - 2, mm.PH - 2);

    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#222'; ctx.font = '600 30px sans-serif';
    ctx.fillText('拼豆采购清单 ' + this.data.w + '×' + this.data.h, M, M + 34);
    ctx.fillStyle = '#777'; ctx.font = '17px sans-serif';
    ctx.fillText('共 ' + this.data.totalCount + ' 粒 · ' + panel.length + ' 色 · ' +
      (this.data.brandName ? this.data.brandName + ' 色号 · ' : '') + this._today() +
      ' · 建议购买量 = 实际用量 +5% 备用', M, M + 62);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#c0392b'; ctx.font = '600 20px sans-serif';
    ctx.fillText('清单 ' + (index + 1) + '/' + bom.pages + ' 页', mm.PW - M, M + 62);
    ctx.textAlign = 'left';

    const start = index * bom.perPage;
    const end = Math.min(panel.length, start + bom.perPage);
    const top = M + bom.titleH;
    const heads = ['色号', '名称', '实际用量', '建议购买(+5%)', '色值'];
    const xs = [];
    let cx = M;
    for (let c = 0; c < bom.colW.length; c++) { xs.push(cx); cx += bom.colW[c]; }

    // 表头
    ctx.fillStyle = '#fafafa';
    ctx.fillRect(M, top, bom.colW.reduce((a, b) => a + b, 0), bom.headH - 10);
    ctx.font = '600 17px sans-serif'; ctx.fillStyle = '#333';
    for (let c = 0; c < heads.length; c++) ctx.fillText(heads[c], xs[c] + (c === 0 ? 32 : 4), top + 22);

    // 数据行
    ctx.font = '17px sans-serif';
    for (let r = start; r < end; r++) {
      const c = panel[r];
      const y = top + bom.headH + (r - start) * bom.rowH;
      ctx.fillStyle = c.hex;
      ctx.fillRect(M, y + 4, 20, 20);
      ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1;
      ctx.strokeRect(M + 0.5, y + 4.5, 19, 19);
      ctx.fillStyle = '#222';
      ctx.fillText(String(c.code || ''), xs[0] + 32, y + 22);
      ctx.fillText(String(c.name || ''), xs[1] + 4, y + 22);
      ctx.fillText(String(c.count || 0), xs[2] + 4, y + 22);
      ctx.fillStyle = (c.suggest && c.suggest > c.count) ? '#c0392b' : '#222';
      ctx.fillText(String(c.suggest || c.count || 0), xs[3] + 4, y + 22);
      ctx.fillStyle = '#777';
      ctx.fillText(String(c.hex || ''), xs[4] + 4, y + 22);
      ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(M, y + bom.rowH - 0.5); ctx.lineTo(M + bom.colW.reduce((a, b) => a + b, 0), y + bom.rowH - 0.5); ctx.stroke();
    }

    const footY = mm.PH - M - 24;
    ctx.fillStyle = '#333'; ctx.font = '600 20px sans-serif';
    ctx.fillText('合计 ' + this.data.totalCount + ' 粒（建议购买 ' +
      panel.reduce((a, c) => a + (c.suggest || c.count || 0), 0) + ' 粒）', M, footY);
    ctx.fillStyle = '#999'; ctx.font = '17px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('第 ' + (lay.pageCount + index + 1) + ' / ' + lay.totalPages + ' 页 · 采购清单' +
      (panel.length > end ? '（余下 ' + (panel.length - end) + ' 色见下一页）' : ''),
      mm.PW / 2, mm.PH - M - 2);
    ctx.textAlign = 'left';
    return off;
  },

  // 入口：先如实报出总页数，用户确认后再逐页生成
  generatePrint() {
    if (this._brandBlocked()) return;
    if (!this.grid || !this.grid.length) { wx.showToast({ title: '暂无图纸数据', icon: 'none' }); return; }
    const lay = this._printLayout();
    const mm = lay.mm;
    wx.showModal({
      title: '将生成 ' + lay.totalPages + ' 张图纸',
      content: 'A4 横向、四周 ' + PRINT.marginMM + 'mm 边距、最小字号 ' + PRINT.minPt + 'pt：\n' +
        '· 施工图 ' + lay.pagesX + '×' + lay.pagesY + ' = ' + lay.pageCount + ' 张（每格 ' +
        (lay.cell / mm.pxPerMM).toFixed(1) + 'mm）\n' +
        '· 采购清单 ' + lay.bomPages + ' 张\n' +
        '全部按第 1 张开始的顺序保存到相册，是否继续？',
      confirmText: '继续生成',
      success: (r) => { if (r.confirm) this._renderPrintPage(lay, 0); }
    });
  },

  // 逐页生成 → 存相册 → 再生成下一页。一次只持有一张画布。
  // 前 pageCount 张是施工图，之后是采购清单页；所有页纸面尺寸相同。
  _renderPrintPage(lay, index) {
    if (index >= lay.totalPages) {
      wx.hideLoading();
      wx.showToast({ title: '全部 ' + lay.totalPages + ' 张已保存', icon: 'none' });
      return;
    }
    // 每页刷新一次 loading 文案当进度条用（showLoading 重复调用会原地更新文字与遮罩）
    wx.showLoading({ title: '正在生成 ' + (index + 1) + '/' + lay.totalPages + ' 张…', mask: true });
    const isBom = index >= lay.pageCount;
    const off = isBom
      ? this._buildBomPage(lay, index - lay.pageCount)
      : this._buildPrintPage(lay, index % lay.pagesX, Math.floor(index / lay.pagesX));
    wx.canvasToTempFilePath({
      canvas: off,
      success: (r) => {
        if (index === 0) this.exportPath = r.tempFilePath;
        this._saveToAlbum(
          r.tempFilePath,
          '',
          (cancelled) => {
            if (cancelled === 'cancel') {
              wx.showToast({ title: '已取消，还剩 ' + (lay.totalPages - index) + ' 张未保存', icon: 'none' });
              return;
            }
            this._renderPrintPage(lay, index + 1);
          }
        );
      },
      fail: (err) => {
        wx.hideLoading();
        wx.showModal({
          title: '打印图生成失败',
          content: String((err && err.errMsg) || '未知原因') + '\n可减少颜色数或尺寸后重试。',
          showCancel: false
        });
      }
    });
  },

  // ===== 未知色号系统的作品：拦住一切导出，引导用户先手选品牌 =====
  // 旧作品只有色值（hex/rgb）可信，色号（如 C1）在哪个品牌下都不成立。
  // 直接按当前默认品牌导出，用户会照着错的色号下单（复核 R3）。
  // 取舍：允许进来**看**预览，但图纸、打印图、采购清单一律不出。
  _brandBlocked() {
    if (!this.brandUnknown) return false;
    wx.showModal({
      title: '请先选择色号系统',
      content: '这张图纸是旧版本保存的，无法识别它用的是哪个品牌的色号。\n' +
        '请在上方「色号系统」里选择正确的品牌，再导出 —— 否则图纸与采购清单上的色号可能买不到对应的豆子。',
      showCancel: false
    });
    return true;
  },

  // 手选品牌：把每种颜色按色值映射到目标品牌色卡（品牌转换器就是这么做的），
  // 成功后色号才可信，解除拦截。
  onPickBrand(e) {
    const list = paletteLoader.getBrandList();
    const b = list[+e.detail.value];
    if (!b) return;
    const p = this.project;
    // 必须换算**整件作品**，输入取权威网格 fullGrid（复核报告 S1）：
    // 只传可见的 this.grid 时，形状外那些格子既进不了新的 colorMeta、
    // 也不在 remap 里，但存进历史的 fullGrid 还是旧下标 —— 重新打开切回矩形，
    // 那些下标取不到颜色项，绘图直接抛 reading 'rgb'。
    // 编辑器早先踩过同一个坑，所以两边现在共用 brandConvert.convertWork。
    const r = brandConvert.convertWork({
      fullGrid: p.fullGrid, grid: this.grid, colorMeta: this.colorMeta,
      locked: p.locked, toBrand: b.key
    });
    if (!r.ok) {
      wx.showToast({ title: '转换失败：' + (r.reason || ''), icon: 'none' });
      return;
    }
    this.grid = r.grid;
    this.colorMeta = r.colorMeta;
    this.brandUnknown = false;
    // 网格 / 色元数据 / 权威网格 / 锁定色 四样必须一起换。
    // 落下任何一样，"保存 → 重开 → 切形状"就会拿到对不上的下标。
    p.brand = r.brand;
    p.brandUnknown = false;
    p.grid = r.grid;
    p.colorMeta = r.colorMeta;
    p.locked = r.locked;
    if (p.fullGrid && p.fullGrid.length) p.fullGrid = r.fullGrid;
    this.buildPanel();
    this.buildSymbols();
    this.setData({
      brandUnknown: false,
      brandName: paletteLoader.getPaletteInfo(r.brand).brandName
    });
    this.renderPreview();
    const extra = r.merged ? '，' + r.merged + ' 种相近色已合并' : '';
    wx.showToast({ title: '已按 ' + r.brandName + ' 色号重新标注' + extra, icon: 'none' });
  },

  // 采购助手弹窗
  openBuy() {
    if (this._brandBlocked()) return;
    this.setData({ showBuy: true, buyList: this.data.palettePanel });
  },
  closeBuy() { this.setData({ showBuy: false }); },
  copyBuy(e) {
    if (this._brandBlocked()) return;
    const c = e.currentTarget.dataset.item;
    // 购买词必须带品牌与真实粒径：旧版硬编码 "2.6mm mini"，
    // 连 Hama / Perler / Artkal S 这些 5mm 大豆也被复制成 2.6mm，
    // 买回来插不进底板（审查 F10）。
    const info = paletteLoader.getPaletteInfo(this.project && this.project.brand);
    const parts = [c.name, '拼豆', c.code];
    if (info && info.brandName) parts.push(info.brandName);
    if (info && info.size) parts.push(info.size);
    wx.setClipboardData({
      data: parts.join(' '),
      success: () => wx.showToast({ title: '已复制购买词' })
    });
  },

  onShareAppMessage() {
    return {
      title: `拼豆图纸 ${this.data.w}×${this.data.h}（${this.data.totalCount}粒）`,
      path: '/pages/index/index',
      imageUrl: this.exportPath || ''
    };
  }
});
