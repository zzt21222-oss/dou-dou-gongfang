// pages/editor/editor.js
const app = getApp();
const quantize = require('../../utils/quantize.js');
const bead = require('../../utils/bead.js');
const palette = require('../../utils/palette.js');
const paletteLoader = require('../../utils/paletteLoader.js');
const brandConvert = require('../../utils/brandConvert.js');
const render = require('../../utils/render.js');
const storage = require('../../utils/storage.js');
const templates = require('../../utils/templates.js');

// ===== 诊断开关（排查「真机无颜色/无形状」用；定位问题后请全部置 false）=====
const DIAG = {
  hardcodeTestImage: false, // true: 跳过图片加载，直接用写死的 3x3 红/绿/蓝图验证 Canvas 绘制逻辑（第2步）
  redFillProbe: false,      // true: 绘制前先整张填红，确认 Canvas 能画（第3步）
};

// ===== 最简验证总开关（按用户要求逐层剥离，每层用真机数据确认）=====
// 改成 true 后编译，进编辑器页面会跳过一切复杂逻辑，依次画：
//   第1步 200x200 死红色方块 → 第2步 3x3 红色矩阵 → 第3步 5x5 白底黑十字
// 看到哪个就说明哪一层没问题；哪一项看不到，问题就在那一层。定位后改回 false。
const MIN_VERIFY = false;


Page({
  onShow() {
    const acc = (app.globalData.prefs && app.globalData.prefs.accessibility) || {};
    this.setData({ a11yClass: (acc.largeFont ? ' a11y-lg' : '') + (acc.highContrast ? ' a11y-hc' : '') });
  },

  data: {
    w: 50, h: 50,
    lockRatio: true,          // 锁定宽高比例，改宽自动算高，每格都是正方形
    srcAspect: 1,              // 原图宽高比（w/h），用于联动换算
    colorCount: 12,            // 最多颜色数（上限）：超过则合并最少用的色；默认 12 更省料，滑块可调 2~30
    fitMode: 'contain',        // 缩放置信：contain 等比留边 | cover 等比裁切
    fitModes: ['等比留边', '等比裁切'],
    fitModeIndex: 0,
    showGrid: true,
    showBoardLines: true,
    shape: 'rect',
    shapeNames: ['矩形', '圆形', '六边形'],
    shapeKeys: ['rect', 'circle', 'hexagon'],
    shapeIndex: 0,
    presets: [
      { label: '小方 29×29', w: 29, h: 29, shape: 'rect' },
      { label: '中方 40×40', w: 40, h: 40, shape: 'rect' },
      { label: '大方 58×58', w: 58, h: 58, shape: 'rect' },
      { label: '圆形 40×40', w: 40, h: 40, shape: 'circle' },
      { label: '六边形 40×46', w: 40, h: 46, shape: 'hexagon' },
      { label: '超清 100×100', w: 100, h: 100, shape: 'rect' }
    ],
    showTemplate: false,
    templateList: [],
    paletteInfo: { count: 0, brandName: '', size: '' },
    brandList: [],   // 可选色号系统（品牌）
    brandNames: [],  // 供 picker 显示的品牌名
    brandIndex: 0,   // 当前品牌在列表中的下标
    brandUnknown: false, // 旧作品色号系统无法识别（迁移层标记）：未确认前不放行预览导出
    activeTool: 'recolor',
    activeColorId: null,
    activeColor: { hex: '#fff', code: '-', name: '背景' },
    palettePanel: [],
    totalCount: 0,
    boards: null,
    a11yClass: '',
    lastError: '',   // 加载/提取失败时把错误直接显示在页面上，方便截图排查
    showDiag: false, // 诊断面板是否显示（默认关闭）
    diagInfo: '',    // 像素提取/颜色映射诊断信息，方便用户截图发我
    previewSrc: '',  // 原图预览 URL，确认图片真的加载进来了
    moduleCount: '', // 方案C：原图模块数（如二维码 41），留空=不启用对齐
    gridMultiple: 2, // 方案C：网格倍数（1x/2x/3x）
    multipleOptions: ['1x', '2x', '3x'],
    multipleIndex: 1,
    alignedW: 0,     // 方案C：对齐后网格宽（实时显示）
    alignedH: 0,     // 方案C：对齐后网格高
    alignedWarn: '', // 方案C：cell<6px 等提示
    cvW: 300,        // 画布 CSS 宽(px)：按设备宽度 × 网格比例自适应，网格铺满画布
    cvH: 300,        // 画布 CSS 高(px)
    canUndo: false,  // 撤销/重做按钮可用态（灰显控制）
    canRedo: false
  },

  src: '',
  grid: [],
  colorMeta: {},
  locked: {},
  cell: 10,
  offX: 0,
  offY: 0,
  area: null,

  onLoad(options) {
    console.error('=== EDITOR LOADED ===');
    this.locked = {};
    this._moduleAutoTried = false;   // 方案C自动对齐：每张图只在导入时尝试自动检测一次
    this._autoTrimmed = false;       // 自动裁剪白边：每张图只在导入时尝试一次
    this._srcCrop = null;            // 内容裁剪框 {sx,sy,sw,sh}，null=用整图
    this._undoStack = [];            // 撤销栈：每项为一笔的差异 [{i,from,to},...]
    this._redoStack = [];            // 重做栈
    this._stroke = null;             // 当前正在画的笔画（touchstart 到 touchend 之间）
    this._recId = '';                // 当前图纸对应的历史记录 id（来自历史才有）
    this._dirty = false;             // 本次进来有没有改动过（决定要不要存草稿）
    this.brandUnknown = false;       // 色号系统未知（旧作品）：需用户手选后才放行
    const prefs = app.globalData.prefs;
    // 色号系统跟随用户偏好（默认 MARD），并让加载器立即生效
    const brandKey = paletteLoader.setCurrentBrand(prefs.brand || paletteLoader.getCurrentBrand());
    const brandList = paletteLoader.getBrandList();
    const brandNames = brandList.map(function (b) { return b.name; });
    let brandIndex = 0;
    for (let i = 0; i < brandList.length; i++) { if (brandList[i].key === brandKey) { brandIndex = i; break; } }
    this.setData({
      paletteInfo: paletteLoader.getPaletteInfo(),
      brandList: brandList,
      brandNames: brandNames,
      brandIndex: brandIndex,
      w: prefs.boardSize.w, h: prefs.boardSize.h,
      colorCount: prefs.colorCount,
      shape: prefs.shape || 'rect',
      shapeIndex: Math.max(0, ['rect', 'circle', 'hexagon'].indexOf(prefs.shape || 'rect')),
      showBoardLines: prefs.showBoardLines !== false,
      templateList: templates.getTemplateList()
    });

    if (options.id) {
      const rec = storage.getProject(options.id);
      if (rec) { this.loadFromRecord(rec); return; }
    }
    // 草稿恢复：被系统回收后重新进入编辑器，或首页点「继续上次编辑」进来。
    // 注意要在「新选了图片(options.src)」之前判断——那时用户是有意开始新作品，不该弹旧草稿。
    if (options.draft === '1' || !options.src) {
      const d = storage.getDraft();
      if (d) { this.loadFromDraft(d); return; }
    }
    let p = app.globalData.project;
    // URL 参数作为兜底：globalData 可能被回收，但 URL 里的 src 不会丢
    if (options.src) {
      p = {
        src: decodeURIComponent(options.src),
        origSrc: options.origSrc ? decodeURIComponent(options.origSrc) : ((p && p.origSrc) || ''),
        cropW: Number(options.cropW) || (p && p.cropW),
        cropH: Number(options.cropH) || (p && p.cropH)
      };
      app.globalData.project = p;
    }
    this.origSrc = (p && p.origSrc) || '';
    if (p && p.grid) { this.loadFromRecord(p); return; }
    if (p && p.src) {
      this.src = p.src;
      // 自适应比例：导入图片后，按原图宽高比分配网格，且「总豆数守恒」。
      // 不用「短边固定」——宽图会把宽度撑到 120+，手机上 cell 只剩 2px 看不清。
      // 面积守恒后：方图 80×80，横竖图清晰度和豆数都稳定。
      // AREA=6400：保证刀刃/刃口等锐利细节有足够分辨率（刀刃宽度≥10粒），
      // 太低（如2500=50×50）会把刀刃抹平成圆润色块，丢失锋利感。
      if (p.cropW && p.cropH) {
        const aspect = p.cropW / p.cropH;
        this.srcAspect = aspect;
        const AREA = 6400;
        let nw = Math.round(Math.sqrt(AREA * aspect));
        let nh = Math.round(nw / aspect);
        nw = Math.max(10, Math.min(200, nw));
        nh = Math.max(10, Math.min(200, nh));
        this.setData({ w: nw, h: nh, srcAspect: aspect });
        prefs.boardSize = { w: nw, h: nh };
        app.savePrefs();
      }
    }
  },

  onReady() {
    this.ensureCanvas().then(() => {
      this.computeCell();
      if (MIN_VERIFY) { this._minVerify(); return; }   // 最简验证：跳过一切正常流程
      if (DIAG.hardcodeTestImage) { this.renderHardcodedTest(); return; }
      if (this.grid && this.grid.length) this.renderGrid();
      else if (this.src) this.processImage();
    });
  },

  // 最简逐层验证（不经过任何图片加载/色板/映射/降色逻辑，纯手写 Canvas 绘制）
  _minVerify() {
    const ctx = this.ctx;
    const W = this.area.width, H = this.area.height;
    console.error('=== MIN_VERIFY START === area=' + W + 'x' + H);

    // 第1步：清屏后画一个死红色的 100x100 方块（确认 canvas 能画即可，压缩尺寸给后面留空间）
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#FF0000';
    ctx.fillRect(0, 0, 100, 100);
    console.error('[1] 已 draw 死红色 100x100 方块 (fillStyle=#FF0000)');

    // 第2步：手写 3x3 红色矩阵，每格 20px、间距 2px，用共用绘制函数
    const m = [['#FF0000','#FF0000','#FF0000'],['#FF0000','#FF0000','#FF0000'],['#FF0000','#FF0000','#FF0000']];
    this._drawCellGrid(m, 0, 110, 20, 2);
    console.error('[2] 已 draw 3x3 红色矩阵 (每格20 间距2)');

    // 第3步：硬编码 5x5 白底黑十字图案，用与第2步完全相同的绘制循环
    // 矩阵定义：5 行 5 列，第 3 行(row=2)整行黑、第 3 列(col=2)整列黑，其余白
    const cross = [];
    for (let y = 0; y < 5; y++) { const row = [];
      for (let x = 0; x < 5; x++) row.push((y === 2 || x === 2) ? '#000000' : '#FFFFFF');
      cross.push(row);
    }
    // 打印矩阵内容，确认是 5x5 且中间十字为黑色 #000000
    console.error('[3] cross 维度 = ' + cross.length + '行 x ' + cross[0].length + '列');
    console.error('[3] cross 内容 (W=白 #FFFFFF, B=黑 #000000):\n' + cross.map(r => r.map(c => c === '#000000' ? 'B' : 'W').join(' ')).join('\n'));
    // 绘制循环：外层 y=行(纵向)，内层 x=列(横向)，未交换；与第2/4步共用 _drawCellGrid
    this._drawCellGrid(cross, 0, 185, 18, 2, '#DDDDDD');
    console.error('[3] 已 draw 5x5 白底黑十字 (黑色=#000000, 含浅灰描边便于在白底上辨认)');

    // 第4步：不加载任何外部图片，直接画一张 50x50 离屏测试图（上半红、下半蓝）
    // 用 getImageData 取像素 -> mapToPalette -> limitPaletteColors，再交给同一绘制函数
    // 完全跳过：wx.chooseImage / 文件/网络路径 / 图片解码 / 外部加载
    try {
      const paletteColors = paletteLoader.getPaletteColors();
      const testW = 50, testH = 50;
      const off = wx.createOffscreenCanvas({ type: '2d', width: testW, height: testH });
      const octx = off.getContext('2d');
      octx.clearRect(0, 0, testW, testH);
      octx.fillStyle = '#FF0000';
      octx.fillRect(0, 0, testW, testH / 2);        // 上半红
      octx.fillStyle = '#0000FF';
      octx.fillRect(0, testH / 2, testW, testH / 2); // 下半蓝
      const rgba = octx.getImageData(0, 0, testW, testH).data;
      // getImageData 是 RGBA(每像素4字节)，mapToPalette 期望 RGB(每像素3字节)，转换一下
      const px3 = new Uint8ClampedArray(testW * testH * 3);
      for (let i = 0; i < testW * testH; i++) {
        px3[i * 3] = rgba[i * 4]; px3[i * 3 + 1] = rgba[i * 4 + 1]; px3[i * 3 + 2] = rgba[i * 4 + 2];
      }
      const labelsRaw = bead.mapToPalette(px3, paletteColors);
      const labelsLim = bead.limitPaletteColors(labelsRaw, paletteColors, 20);
      // 标签数组(Int32Array) -> 二维 hex 网格（和绘制函数期待的格式完全一致）
      const grid4 = [];
      for (let y = 0; y < testH; y++) { const row = [];
        for (let x = 0; x < testW; x++) row.push(paletteColors[labelsLim[y * testW + x]].hex);
        grid4.push(row);
      }
      console.error('[4] 离屏图映射完成：上排色=' + grid4[2][2] + ' 下排色=' + grid4[testH - 3][2] + ' 色板总数=' + paletteColors.length);
      this._drawCellGrid(grid4, 110, 5, 5, 0);
      console.error('[4] 已 draw 50x50 离屏测试图（上红下蓝 -> 经 mapToPalette/limitPaletteColors）');
    } catch (e4) {
      console.error('[4] 离屏测试图失败：' + (e4 && e4.message ? e4.message : e4));
    }
    console.error('=== MIN_VERIFY END === 请看真机：①红方块 ②3x3红矩阵 ③白底黑十字 ④上红下蓝离屏图 是否逐一出现');
  },

  // 共用绘制函数：把一个「二维 hex 颜色数组」逐格画到主画布（第2/3/4步都用它，确保绘制逻辑一致）
  _drawCellGrid(grid, startX, startY, cell, gap, border) {
    const ctx = this.ctx;
    for (let y = 0; y < grid.length; y++) for (let x = 0; x < grid[y].length; x++) {
      const px = startX + x * (cell + gap), py = startY + y * (cell + gap);
      ctx.fillStyle = grid[y][x];
      ctx.fillRect(px, py, cell, cell);
      if (border) {  // 可选描边：白格在白底上不可见时用浅灰描边显示网格结构
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);
      }
    }
  },

  // 第2步探针：绕过图片加载，用写死的 3x3 红/绿/蓝图渲染，隔离「图片加载/缩放」与「Canvas 绘制」
  renderHardcodedTest() {
    const pal = paletteLoader.getPaletteColors();
    const W = 3, H = 3;
    const idxRed = pal.findIndex(c => c.id === 'C07');
    const idxGreen = pal.findIndex(c => c.id === 'C22');
    const idxBlue = pal.findIndex(c => c.id === 'C17');
    const labels = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) labels.push(r === 0 ? idxRed : r === 1 ? idxGreen : idxBlue);
    const fin = bead.finalize(Int32Array.from(labels), pal);
    this.colorMeta = {};
    fin.colors.forEach(c => { this.colorMeta[c.id] = { rgb: c.rgb, code: c.code, name: c.name, hex: c.hex, short: c.short || c.code }; });
    this.data.w = W; this.data.h = H; this.w = W; this.h = H;
    this.grid = Array.from(fin.labels);
    this.recomputeColors();
    this.renderGrid();
    console.log('[诊断-硬编码图] 已用写死 3x3 红/绿/蓝 渲染；若能看到红绿蓝色块 => Canvas绘制逻辑正常，问题在图片加载/提取环节');
  },

  ensureCanvas() {
    if (this.canvas) return Promise.resolve();
    return new Promise((resolve) => {
      const q = wx.createSelectorQuery();
      q.select('#wrap').boundingClientRect().select('#cv').fields({ node: true }).exec((res) => {
        const rect = res[0];
        const node = res[1].node;
        const win = wx.getWindowInfo();
        // 缓存设备相关参数，供 _refitCanvas 同步重算画布尺寸
        this._wrapW = rect.width;                       // 可用宽度（随设备/窗口不同：手机≈350px，电脑端更宽）
        this._winH = win.windowHeight || 600;
        this._dpr = win.pixelRatio || 2;
        this.canvas = node;
        this._refitCanvas();                            // 按当前网格比例算 cvW/cvH 并重设 buffer
        this.ctx.imageSmoothingEnabled = false;         // 最近邻缩放，不产生混合色
        resolve();
      });
    });
  },

  // 画布自适应：宽 = 容器可用宽（各端独立），高 = 宽 × 网格高宽比；超高网格按窗口高 62% 封顶并等比收宽。
  // 结果：网格永远铺满整个画布、无上下留白带、不拉伸不变形，cell 取到该设备能给的最大值。
  _refitCanvas() {
    if (!this.canvas || !this._wrapW) return;
    const maxH = Math.max(240, Math.floor(this._winH * 0.62));
    const w = this.data.w || 1, h = this.data.h || 1;
    let cvW = Math.floor(this._wrapW);
    let cvH = Math.round(cvW * h / w);
    if (cvH > maxH) { cvH = maxH; cvW = Math.round(cvH * w / h); }
    cvW = Math.max(50, cvW); cvH = Math.max(50, cvH);
    if (cvW === this.data.cvW && cvH === this.data.cvH && this.area) return;
    // 重设 buffer 会重置上下文状态，需重新 scale + 关平滑
    this.canvas.width = cvW * this._dpr;
    this.canvas.height = cvH * this._dpr;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.scale(this._dpr, this._dpr);
    this.area = { width: cvW, height: cvH };
    this.setData({ cvW, cvH });   // CSS 尺寸跟随，保证 1CSS px = 1 逻辑像素，不缩放变形
  },

  // 尝试加载单个 src；失败返回错误信息字符串
  _tryLoadOne(src) {
    return new Promise((resolve) => {
      let img;
      try {
        img = this.canvas.createImage();
      } catch (e) {
        try { img = wx.createImage(); } catch (e2) { resolve({ ok: false, err: 'createImage 不可用', src }); return; }
      }
      if (!img) { resolve({ ok: false, err: 'createImage 返回 null', src }); return; }
      let done = false;
      const finish = (ok, err) => { if (done) return; done = true; resolve({ ok, err, src, img }); };
      img.onload = () => finish(true, '');
      img.onerror = (err) => finish(false, (err && err.errMsg) || 'onerror');
      // 部分基础库不会触发 onerror，用超时兜底
      setTimeout(() => finish(false, 'timeout(5s)'), 5000);
      img.src = src;
    });
  },

  async loadImage(primarySrc) {
    const candidates = [primarySrc];
    if (this.origSrc && this.origSrc !== primarySrc) candidates.push(this.origSrc);
    const errors = [];
    for (const src of candidates) {
      const r = await this._tryLoadOne(src);
      if (r.ok && r.img && r.img.width > 0 && r.img.height > 0) return r.img;
      errors.push(src + ' -> ' + (r.err || 'invalid img'));
    }
    throw new Error(errors.join(' | '));
  },

  // ===== 像素提取（双保险）：离屏 canvas 优先，失败/全白则回退主画布 =====
  // mode: 'contain' 等比缩放居中（默认）；'cover' 等比填充满目标区域，会裁剪但无白边。
  _extractViaOffscreen(img, iw, ih, w, h, mode) {
    mode = mode || 'contain';
    const off = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
    off.width = w; off.height = h;   // 部分基础库会忽略 create 的 width/height，这里强制设置
    const octx = off.getContext('2d');
    octx.imageSmoothingEnabled = false;
    // 不预填白底，保留源图 alpha，让"抠掉的背景"能一路传到遮罩（审查 F03）
    octx.clearRect(0, 0, w, h);
    const scale = mode === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
    const dw = Math.max(1, Math.round(iw * scale));
    const dh = Math.max(1, Math.round(ih * scale));
    const dx = Math.floor((w - dw) / 2);
    const dy = Math.floor((h - dh) / 2);
    octx.drawImage(img, dx, dy, dw, dh);
    const data = octx.getImageData(0, 0, w, h).data;
    // [步骤1-设备验证] 打印真实导入图经离屏读取后的前5行×前5列 RGB，确认黑≈(0,0,0) 白≈(255,255,255)
    console.log('[步骤1] 离屏读取前5x5 RGB (w=' + w + ' h=' + h + ', mode=' + mode + '):');
    for (let yy = 0; yy < Math.min(5, h); yy++) {
      const row = [];
      for (let xx = 0; xx < Math.min(5, w); xx++) {
        const di = (yy * w + xx) * 4;
        row.push('(' + data[di] + ',' + data[di + 1] + ',' + data[di + 2] + ')');
      }
      console.log('   ' + row.join(' '));
    }
    return this._toPixels(data, w, h);
  },

  // ===== 方案A：区域众数采样（Area Mode Sampling）=====
  // 旧逻辑：每个网格格 = 源图上「一个采样点」→ 缩小时整块模块会被跳过（丢黑），
  //         抗锯齿灰边点也会原样变成一颗杂色豆。
  // 新逻辑：先把图渲染到 ss 倍超采样离屏画布，每个网格格覆盖源图一个 ss×ss 矩形区域，
  //         区域内每个像素各自 mapToPalette，然后「投票取众数」决定这一格的颜色。
  //   → 黑模块只要占该格 >50% 就必定是黑（不丢）；抗锯齿灰边永远是少数派（被投票吞掉）。
  // 不改任何参数：colorCount / ratioThreshold / denoise / consolidateColors 全部保持原样，
  // 本函数只是把「点采样」换成「区域投票」，产出同样格式的 labels + pixels。
  _extractRegionMode(img, iw, ih, w, h, mode, paletteColors) {
    mode = mode || 'contain';
    // 自动裁剪白边：若有内容裁剪框，则只对内容区采样（logo 铺满网格，文字/细线更清晰、颜色更实）
    const crop = this._srcCrop;   // { sx, sy, sw, sh } 或 null
    const cw = crop ? crop.sw : iw;
    const ch = crop ? crop.sh : ih;
    // 1) 决定超采样倍数：让每格至少覆盖源图若干像素，同时限制总像素数（性能/内存）
    let ss = Math.floor(Math.min(cw / w, ch / h));
    if (!isFinite(ss) || ss < 1) ss = 1;
    ss = Math.min(8, ss);
    while (ss > 1 && w * ss * h * ss > 400000) ss--;
    const W2 = w * ss, H2 = h * ss;

    // 2) 渲染到超采样离屏画布（最近邻）
    //    这里**不能**预填白底：填了之后 alpha 恒为 255，"透明区不拼"就永远不成立，
    //    用户明明抠掉了背景，还是会拿到一张用白豆铺满的矩形图纸（审查 F03）。
    //    留透明，下面的采样才能识别出「这一格不该有豆子」。
    const off = wx.createOffscreenCanvas({ type: '2d', width: W2, height: H2 });
    off.width = W2; off.height = H2;
    const octx = off.getContext('2d');
    const scale = mode === 'cover' ? Math.max(W2 / cw, H2 / ch) : Math.min(W2 / cw, H2 / ch);
    // 只在**真的在缩小**（scale<1）时开平滑做面积平均：
    //   · ss>1（源图比网格大很多）：最近邻，保像素画/二维码的锐边，格内细节交给区域投票；
    //   · ss=1 且在缩小（如 295px 证件照 → 200 格）：最近邻等价于"每 1.5 个源像素抽 1 个"，
    //     眼睛/细笔画会被抽样相位直接抽没（用户证件照五官消失的元凶），必须面积平均；
    //   · ss=1 但 1:1（scale=1）：必须最近邻——实测平滑开启时 @napi drawImage 会在
    //     色块边界列产生半像素混色，凭空多出一列杂色（F01b 红/白图回归抓到）。
    octx.imageSmoothingEnabled = scale < 0.999;
    if (octx.imageSmoothingEnabled) { try { octx.imageSmoothingQuality = 'high'; } catch (e) { /* 旧基础库无此属性 */ } }
    octx.clearRect(0, 0, W2, H2);
    const dw = Math.max(1, Math.round(cw * scale));
    const dh = Math.max(1, Math.round(ch * scale));
    const dx = Math.floor((W2 - dw) / 2);
    const dy = Math.floor((H2 - dh) / 2);
    if (crop) octx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, dx, dy, dw, dh);
    else octx.drawImage(img, dx, dy, dw, dh);
    const data = octx.getImageData(0, 0, W2, H2).data;

    // 低对比自动拉伸（只在 ss=1 缩小场景 = 照片类，2026-10-12 第二版）：
    // 只统计**内容像素**（与背景色差距大的），背景（白底/蓝底）不参与分位——
    // 第一版用全图分位，白底把 hi 锚在 245+，皮肤反而被推得更白（实测肤色 #edc49f→#FBF8C9）。
    // 只拉"内容确实发灰"的图（跨度 60~150 → 目标 210）；正常对比图与近平图都不动。
    if (ss === 1) {
      const bgC = this._srcBgColor || null;
      const isBgPx = (r, g, b) => bgC && (Math.abs(r - bgC[0]) + Math.abs(g - bgC[1]) + Math.abs(b - bgC[2])) < 90;
      const lums = [];
      for (let i = 0; i < W2 * H2; i += 3) {
        const di = i * 4;
        if (data[di + 3] < 10) continue;
        if (isBgPx(data[di], data[di + 1], data[di + 2])) continue;
        lums.push(0.299 * data[di] + 0.587 * data[di + 1] + 0.114 * data[di + 2]);
      }
      if (lums.length > 100) {
        lums.sort((a, b) => a - b);
        const lo = lums[Math.floor(lums.length * 0.02)];
        const hi = lums[Math.floor(lums.length * 0.98)];
        const span = hi - lo;
        if (span >= 60 && span <= 150) {
          const s = 210 / span, off = 25 - lo * s;
          for (let i = 0; i < W2 * H2 * 4; i += 4) {
            data[i]     = data[i] * s + off;
            data[i + 1] = data[i + 1] * s + off;
            data[i + 2] = data[i + 2] * s + off;
          }
          console.log('[方案A] 低对比拉伸（按内容像素）：内容亮度跨度 ' + span.toFixed(0) + ' → 210');
        }
      }
    }

    // 3) 逐像素映射到色板（用 bead.mapToPalette 权威函数；相同 RGB 走缓存避免重复计算）
    const cache = new Map();
    const CACHE_MAX = 20000;
    const mapOne = (r, g, b) => {
      const key = (r << 16) | (g << 8) | b;
      let v = cache.get(key);
      if (v === undefined) {
        v = bead.mapToPalette([r, g, b], paletteColors)[0];
        if (cache.size < CACHE_MAX) cache.set(key, v);
      }
      return v;
    };
    const bigLabels = new Int32Array(W2 * H2);
    for (let i = 0; i < W2 * H2; i++) {
      const di = i * 4;
      let r = data[di], g = data[di + 1], b = data[di + 2];
      if (data[di + 3] < 10) { r = 255; g = 255; b = 255; } // 透明区视作白底
      bigLabels[i] = mapOne(r, g, b);
    }
    const uniqBig = new Set(bigLabels).size;

    // 4) 每格投票取众数（平票时优先取该格中心像素的颜色，避免偏向左上角）
    //    彩色加权：明显彩色的像素一票顶 CHROMA_WEIGHT 票。
    //    原因：原图的紫条纹/红蓝绿等特征色在格子内占比常低于银灰/白色，众数投票会被多数派
    //    中性色吞掉，导致转化图丢失标志性颜色。加权后少数派彩色能胜出，不影响黑白灰映射。
    //    彩色判定门槛降到 sat>=22、亮度>50，让被采样拉暗的紫条纹(约79,82,109)也能拿到加权票。
    const CHROMA_WEIGHT = 5;
    const labels = new Int32Array(w * h);
    const pixels = new Uint8ClampedArray(w * h * 3);
    // mask=0 表示这一格透明（抠掉的背景 / 原图就是透明 PNG）→ 不拼（审查 F03）
    const mask = new Uint8Array(w * h).fill(1);
    const votes = new Map();
    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        votes.clear();
        const y0 = gy * ss, x0 = gx * ss;
        let transparent = 0;
        for (let sy = 0; sy < ss; sy++) {
          const rowBase = (y0 + sy) * W2 + x0;
          for (let sx = 0; sx < ss; sx++) {
            const v = bigLabels[rowBase + sx];
            // 取该像素的原始 RGB 判断是否明显彩色（用超采样画布的像素，不是映射后的色板色）
            const di = (rowBase + sx) * 4;
            const r = data[di], g = data[di + 1], b = data[di + 2];
            // 透明像素不参与投票：它不代表任何一颗豆子，
            // 让它按白色投票就等于把"不拼"变成"填白豆"。
            if (data[di + 3] < 10) { transparent++; continue; }
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const wt = ((mx - mn) >= 22 && mx > 50) ? CHROMA_WEIGHT : 1;
            votes.set(v, (votes.get(v) || 0) + wt);
          }
        }
        const gi = gy * w + gx;
        if (transparent > (ss * ss) / 2) {
          // 这一格过半是透明的 → 不拼（边缘半透明的格子仍按可见部分取色）
          mask[gi] = 0;
          labels[gi] = -1;
          pixels[gi * 3] = 255; pixels[gi * 3 + 1] = 255; pixels[gi * 3 + 2] = 255;
          continue;
        }
        let best = -1, bestC = -1;
        votes.forEach((c, v) => { if (c > bestC) { bestC = c; best = v; } });
        if (best < 0) best = bigLabels[(y0 + (ss >> 1)) * W2 + x0 + (ss >> 1)];
        // 平票裁决：中心像素若也是并列最高票之一，则用中心像素（更贴近原图形态）
        const centerLbl = bigLabels[(y0 + (ss >> 1)) * W2 + x0 + (ss >> 1)];
        if (centerLbl !== best && votes.get(centerLbl) === bestC) best = centerLbl;
        labels[gi] = best;
        const pc = paletteColors[best];
        pixels[gi * 3] = pc ? pc.r : 255;
        pixels[gi * 3 + 1] = pc ? pc.g : 255;
        pixels[gi * 3 + 2] = pc ? pc.b : 255;
      }
    }
    const uniqCell = new Set(labels).size;

    // [方案A 探针] 只打印，不影响结果
    console.log('[方案A] 区域众数采样：超采样 ss=' + ss + ' 离屏=' + W2 + 'x' + H2 +
      ' → 网格=' + w + 'x' + h + ' (每格覆盖 ' + ss + 'x' + ss + '=' + (ss * ss) + ' 个源像素)' +
      (ss === 1 ? '  ⚠ ss=1（源图分辨率不足），本次等同点采样' : ''));
    console.log('[方案A] 投票前(超采样逐像素)颜色种类=' + uniqBig + ' → 投票后(每格众数)颜色种类=' + uniqCell);
    console.log('[步骤1] 采样后前5x5 代表色 RGB (mode=' + mode + '):');
    for (let yy = 0; yy < Math.min(5, h); yy++) {
      const row = [];
      for (let xx = 0; xx < Math.min(5, w); xx++) {
        const pi = (yy * w + xx) * 3;
        row.push('(' + pixels[pi] + ',' + pixels[pi + 1] + ',' + pixels[pi + 2] + ')');
      }
      console.log('   ' + row.join(' '));
    }
    return { labels, pixels, ss, mask };
  },

  // 主画布（this.ctx）已被证明可正常绘制（网格线能显示即证明），用来兜底读取像素
  _extractViaMain(img, iw, ih, w, h) {
    const ctx = this.ctx;
    if (!ctx || !this.area) return null;
    const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 1;
    // ctx 已被 scale(dpr,dpr)，逻辑坐标单位是 CSS 像素，必须用 canvas CSS 尺寸来算居中
    const cssW = this.area.width, cssH = this.area.height;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const scale = Math.min(cssW / iw, cssH / ih);
    const dw = Math.max(1, Math.round(iw * scale));
    const dh = Math.max(1, Math.round(ih * scale));
    const dx = Math.floor((cssW - dw) / 2);
    const dy = Math.floor((cssH - dh) / 2);
    ctx.drawImage(img, dx, dy, dw, dh);
    const devW = Math.max(1, Math.round(cssW * dpr));
    const devH = Math.max(1, Math.round(cssH * dpr));
    const data = ctx.getImageData(0, 0, devW, devH).data;
    ctx.restore();
    const out = new Uint8ClampedArray(w * h * 3);
    const mask = new Uint8Array(w * h).fill(1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(devW - 1, Math.floor(x * (cssW / w) * dpr));
        const sy = Math.min(devH - 1, Math.floor(y * (cssH / h) * dpr));
        const si = (sy * devW + sx) * 4;
        const oi = (y * w + x) * 3;
        if (data[si + 3] < 10) mask[y * w + x] = 0;   // 透明 → 不拼
        out[oi] = data[si]; out[oi + 1] = data[si + 1]; out[oi + 2] = data[si + 2];
      }
    }
    return { pixels: out, mask: mask };
  },

  // 返回 { pixels, mask }：mask=0 表示该格透明（不拼）。
  // 旧版把透明像素当作白底，于是"已经抠掉背景"的图仍会生成一张要用白豆
  // 填满的矩形图纸（审查 F03）。现在把透明信息一路带到网格，标成 -1。
  _toPixels(data, w, h) {
    const out = new Uint8ClampedArray(w * h * 3);
    const mask = new Uint8Array(w * h).fill(1);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
      const clear = a < 10;
      if (clear) mask[i] = 0;
      // 像素值仍写白：让"非白像素占比"这类统计把透明区算作背景而不是内容
      out[i * 3] = clear ? 255 : r;
      out[i * 3 + 1] = clear ? 255 : g;
      out[i * 3 + 2] = clear ? 255 : b;
    }
    return { pixels: out, mask: mask };
  },

  // 判断"像素缓冲本身是否读取失败"—— 只看缓冲可用性，不再看明暗差。
  //
  // 旧实现用 (R+G+B)/3 的极差 < 8 判为"全是纯白/纯黑"，判据是错的：
  // 不同颜色可以有完全相同的平均值。实测 MARD A14 #FF6D40（橙）与
  // C15 #23C4C6（青）的平均值都≈143，极差 = 0，于是一张正常的双色图被拒，
  // 还提示"这通常是微信该版本对 canvas 的限制"——属于无依据归因（审查 F08）。
  // 纯色图本身是合法输入（结果就是一张单色图纸），不由这里拦截。
  _isDegenerate(pixels, w, h) {
    if (!pixels || !pixels.length) return true;
    if (pixels.length < w * h * 3) return true;
    return false;
  },

  // 根据当前比例和期望面积，计算一个更大的网格（用于原图主体很小时自动放大细节）
  _upscaleGrid(w, h, factor) {
    const aspect = this.srcAspect || (w / h);
    const currentArea = w * h;
    const targetArea = Math.min(150 * 150, Math.max(currentArea * factor, currentArea + 2000));
    let nw, nh;
    if (aspect >= 1) {
      nw = Math.min(150, Math.max(w, Math.round(Math.sqrt(targetArea * aspect))));
      nh = Math.min(150, Math.max(h, Math.round(nw / aspect)));
    } else {
      nh = Math.min(150, Math.max(h, Math.round(Math.sqrt(targetArea / aspect))));
      nw = Math.min(150, Math.max(w, Math.round(nh * aspect)));
    }
    return { w: nw, h: nh };
  },

  // 计算像素/颜色诊断统计，直接显示在页面上，方便用户截图
  _pixelStats(pixels, w, h) {
    let nonWhite = 0, min = 255, max = 0, sumR = 0, sumG = 0, sumB = 0;
    let singleColor = true, fr = -1, fg = -1, fb = -1;
    for (let i = 0; i < w * h; i++) {
      const r = pixels[i * 3], g = pixels[i * 3 + 1], b = pixels[i * 3 + 2];
      const lum = (r + g + b) / 3;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
      sumR += r; sumG += g; sumB += b;
      if (lum < 240) nonWhite++;
      if (fr < 0) { fr = r; fg = g; fb = b; }
      else if (singleColor && (r !== fr || g !== fg || b !== fb)) singleColor = false;
    }
    return {
      total: w * h,
      nonWhite,
      min: Math.round(min),
      max: Math.round(max),
      singleColor,
      avg: `rgb(${Math.round(sumR / (w * h))},${Math.round(sumG / (w * h))},${Math.round(sumB / (w * h))})`
    };
  },

  _gridStats(grid, colorMeta) {
    let holes = 0, total = 0;
    const counts = {};
    for (const id of grid) {
      total++;
      if (id < 0) { holes++; continue; }
      counts[id] = (counts[id] || 0) + 1;
    }
    const colors = Object.keys(counts).map(id => {
      const m = colorMeta[id] || {};
      return `${m.code || id}=${counts[id]}`;
    }).slice(0, 6);
    return { total, holes, colorCount: Object.keys(counts).length, colors };
  },

  computeCell() {
    if (!this.area) return;
    // 用 min 保证 x 与 y 用同一 cell → 每格都是正方形，图案不会变形
    const cell = Math.floor(Math.min(this.area.width / this.data.w, this.area.height / this.data.h));
    this.cell = Math.max(1, cell);
  },

  // processImage 的调用口很多（改宽高/色数/缩放方式/品牌/模块数/进入页面），
  // 每次都是「像素提取 + 降色映射 + 整图重绘」的秒级重操作。
  // loading 统一在这层包装（计数支持并发重入：改尺寸连点时多个任务共享同一个 loading），
  // 核心逻辑留在 _processImageCore 不动，里面原有的 toast / showModal 照常工作。
  async processImage() {
    this._procCount = (this._procCount || 0) + 1;
    if (this._procCount === 1) wx.showLoading({ title: '正在生成图纸…', mask: true });
    try {
      await this._processImageCore();
    } finally {
      this._procCount--;
      if (this._procCount <= 0) { this._procCount = 0; wx.hideLoading(); }
    }
  },

  async _processImageCore() {
    this._clearHistory(); // 整图重建后旧的逐格差异失效，撤销历史作废
    let w = this.data.w, h = this.data.h;
    // 方案C：若设置了原图模块数，用对齐后的正方形网格（N×倍数）覆盖 w/h
    if (this.data.moduleCount) {
      const N = parseInt(this.data.moduleCount, 10);
      if (N > 0) {
        const m = this.data.gridMultiple || 1;
        const size = Math.max(1, Math.min(200, N * m));
        w = size; h = size;
        this.data.w = w; this.data.h = h;   // 同步给 computeCell / 末尾 setData
      }
    }
    this.computeCell();
    this.setData({ lastError: '[1/4] 正在加载图片...' });
    let img;
    try { img = await this.loadImage(this.src); }
    catch (e) {
      const info = '图片加载失败\n主src: ' + (this.src || '空') + '\n原图src: ' + (this.origSrc || '无') + '\n错误: ' + e.message;
      this.setData({ lastError: info });
      wx.showModal({ title: '图片加载失败', content: info, showCancel: false });
      return;
    }

    const iw = img.width, ih = img.height;
    this.srcAspect = iw / ih;
    this.setData({ lastError: '[1/4] 图片加载成功：' + iw + '×' + ih + ' → 目标网格 ' + w + '×' + h, previewSrc: this.src });

    // 方案C 自动对齐：用户未手动设模块数、且这张图还没尝试过自动检测时，
    // 自动扫描模块周期。检测到（二维码/像素画/文字点阵等规则图）就自动启用对齐，
    // 让每个模块正好占整数格 → 细笔画/文字不再被区域投票吞掉，错位/不连续消失。
    if (!this.data.moduleCount && !this._moduleAutoTried) {
      this._moduleAutoTried = true;
      const autoN = this._detectModulePeriod(img);
      if (autoN > 0) {
        this.setData({ moduleCount: String(autoN) });   // setData 让输入框显示检测值、并锁定宽高输入
        const m = this.data.gridMultiple || 1;
        const size = Math.max(1, Math.min(200, autoN * m));
        w = size; h = size;
        this.data.w = w; this.data.h = h;
        this.computeCell();            // 用对齐后的尺寸重算 cell
        this.computeAlignedGrid();     // 更新「网格尺寸」显示
        console.log('[方案C] 自动检测模块数=' + autoN + '，已自动对齐 → 网格=' + size + 'x' + size);
        wx.showToast({ title: '已自动对齐模块数 ' + autoN, icon: 'none' });
      } else {
        console.log('[方案C] 自动检测：未发现规律周期（非规则像素画/二维码），保持默认网格');
      }
    }

    // 自动裁剪白边：内容若被大片纯色边包围（如 logo 四周留白），裁到内容区并重算网格，
    // 让图案铺满整个网格 → 文字行高翻倍、颜色更实更艳。方案C 对齐时跳过（对齐有自己的几何）。
    if (!this.data.moduleCount) {
      if (!this._autoTrimmed) {
        this._autoTrimmed = true;
        console.log('[裁剪] 尝试检测内容包围盒 moduleCount=' + (this.data.moduleCount || '空') + ' img=' + img.width + 'x' + img.height);
        const bb = this._detectContentBBox(img);
        if (bb) {
          const aspect = bb.sw / bb.sh;
          // 总豆数守恒：以用户当前 w×h 为面积基准按比例分配，宽图不会把宽度撑爆导致 cell 过小
          const AREA = Math.max(100, (w || 50) * (h || 50));
          let nw = Math.round(Math.sqrt(AREA * aspect));
          let nh = Math.round(nw / aspect);
          nw = Math.max(10, Math.min(200, nw));
          nh = Math.max(10, Math.min(200, nh));
          w = nw; h = nh; this.data.w = w; this.data.h = h;
          this._srcCrop = bb;
          this.srcAspect = aspect;
          this.computeCell();
          console.log('[裁剪] 已自动裁剪白边：内容区 ' + bb.sw + 'x' + bb.sh + ' → 网格 ' + w + 'x' + h);
          wx.showToast({ title: '已自动裁剪白边并铺满', icon: 'none' });
        }
      }
    } else {
      this._srcCrop = null;   // 方案C 对齐时不做内容裁剪
    }

    const paletteColors = paletteLoader.getPaletteColors();
    if (!paletteColors.length) {
      wx.showToast({ title: '色板为空，请检查 data/colorPalette.js', icon: 'none' });
      return;
    }

    // 1) 像素提取：按用户在「缩放方式」里选的模式（contain 等比留边 / cover 等比裁切）提取
    //    不再自动切换/自动放大网格——网格尺寸完全由用户设定的 w/h 决定，避免无脑放大导致字断
    const fitMode = this.data.fitMode || 'contain';
    let pixels;
    let buildMask = null;      // 1=拼，0=透明不拼（审查 F03）
    let regionLabels = null;   // 方案A 区域众数采样直接产出的 labels（非空则跳过点采样的 mapToPalette）
    let extractMethod = 'region-mode-' + fitMode;
    let useW = w, useH = h;
    try {
      // 方案A：区域众数采样（每格覆盖源图一块矩形区域，区域内像素各自映射后投票取众数）
      const rm = this._extractRegionMode(img, iw, ih, useW, useH, fitMode, paletteColors);
      pixels = rm.pixels;
      regionLabels = rm.labels;
      buildMask = rm.mask;
      extractMethod = 'region-mode-' + fitMode + '-ss' + rm.ss;
    } catch (e) {
      console.warn('[提取] 区域众数采样失败，回退点采样离屏 canvas：', e);
      try {
        const off = this._extractViaOffscreen(img, iw, ih, useW, useH, fitMode);
        pixels = off.pixels; buildMask = off.mask;
        extractMethod = 'offscreen-' + fitMode;
      } catch (e2) {
        console.warn('[提取] 离屏 canvas 也失败，回退主画布：', e2);
        const main = this._extractViaMain(img, iw, ih, useW, useH);
        if (main) {
          pixels = main.pixels; buildMask = main.mask;
          extractMethod = 'main';
        } else {
          // 三条路径都拿不到像素：留一张空白缓冲，交给下面的 _isDegenerate 统一提示并退出
          pixels = new Uint8ClampedArray(useW * useH * 3).fill(255);
          extractMethod = 'main-failed';
        }
      }
    }
    const pxStats = this._pixelStats(pixels, useW, useH);
    if (this._isDegenerate(pixels, useW, useH)) {
      const info = '像素提取失败：没有读到有效的像素数据（方式=' + extractMethod + '）。\n像素统计：非白像素 ' + pxStats.nonWhite + '/' + pxStats.total + '。\n请重试一次，或换一张图片。';
      this.setData({ lastError: info, diagInfo: '' });
      wx.showModal({ title: '图片像素提取失败', content: info, showCancel: false });
      return;
    } else {
      this.setData({ lastError: '' });
    }
    // 整张图只有一种颜色：可能是 Canvas 确实没画上东西，也可能用户就想做纯色图，
    // 所以只提示、不拦截（旧版把这类输入直接当"读取失败"拒绝，正常双色图也被误伤）。
    if (pxStats.singleColor) {
      wx.showToast({ title: '整张图只有一种颜色', icon: 'none' });
    }

    // 2) 颜色映射：方案A 已在采样阶段完成（每格区域投票取众数）；
    //    回退路径（点采样）仍走原来的逐像素 mapToPalette，行为完全不变。
    const labelsRaw = regionLabels || bead.mapToPalette(pixels, paletteColors);
    // 透明区 → -1（不拼）。放在降色之前：limitPaletteColors / denoise /
    // consolidateColors / finalize 都已按 <0 跳过，语义与形状掩膜完全一致，
    // 于是"抠掉的背景"既不进材料清单，也不会被填成一片白豆（审查 F03）。
    if (buildMask) {
      let holes = 0;
      for (let i = 0; i < labelsRaw.length; i++) {
        if (!buildMask[i] && labelsRaw[i] >= 0) { labelsRaw[i] = -1; holes++; }
      }
      if (holes) console.log('[透明] ' + holes + ' 格为透明区，标记为不拼');
    }
    const uniqRaw = new Set(labelsRaw).size;
    // 颜色数量上限：使用色数超过 colorCount 时，把使用频率最低的颜色合并到最近的保留色
    const limit = this.data.colorCount || 20;
    // 稀疏保护：原图主体占比越低，越要放宽合并阈值，避免内容色被当噪点吞掉。
    const nonWhiteRatio = pxStats.nonWhite / pxStats.total;
    let ratioThreshold;
    let sparseContent = false;
    // 照片类（非白占比 ≥30%，如证件照/满幅照片）：五官、眉毛、嘴唇这些特征色
    // 在整张图里占比天然很低，却承载全部细节——合并阈值必须远低于 logo 类，
    // 否则全部被并进皮肤主色，脸就"没了"（离线复现实测：12 色 + 0.6% 合并后整图只剩 5 色）。
    let photoLike = false;
    if (nonWhiteRatio < 0.02) { sparseContent = true; ratioThreshold = 0; }
    else if (nonWhiteRatio < 0.05) { ratioThreshold = 0.003; }
    else if (nonWhiteRatio < 0.10) { ratioThreshold = 0.006; }
    else { ratioThreshold = undefined; photoLike = nonWhiteRatio >= 0.30; } // 默认 1%
    if (photoLike) ratioThreshold = 0.003;
    const labelsLimited = bead.limitPaletteColors(labelsRaw, paletteColors, limit, ratioThreshold);
    const uniqLimited = new Set(labelsLimited).size;
    // 去孤立杂色点（保守）：画面更干净，满足「无大量孤立杂色点」标准，不破坏大色块
    // 稀疏图内容极少，denoise 会吞掉 1px 细线/小色块，直接跳过。
    const labelsDenoised = sparseContent ? labelsLimited : bead.denoise(labelsLimited, useW, useH);
    const uniqDenoised = new Set(labelsDenoised).size;
    // 合并「细小/近似背景」的杂色：源图自带的抗锯齿/JPEG 噪点会把简单图拆成十几色，
    // 这里把接近白/黑的背景噪点吸附回白/黑，并把低频小色并入最近主色，保证简单图只留真实少数主色。
    // 稀疏图把合并门槛降到最低（1 颗 / 0%），保住仅剩的内容色；
    // 照片类同理降到 minBeads 3 / 0.2%——0.6% 在 200×122 网格里 = 147 颗，
    // 眉毛/眼线这种关键特征整块都到不了这个数（2026-10-12）。
    const consOpts = sparseContent
      ? { minBeads: 1, minFrac: 0, whiteSnap: true, blackSnap: true }
      : (photoLike
        ? { minBeads: 3, minFrac: 0.002, whiteSnap: true, blackSnap: true }
        : { minBeads: 6, minFrac: 0.006, whiteSnap: true, blackSnap: true });
    const labels = bead.consolidateColors(labelsDenoised, paletteColors, consOpts);
    const uniqConsolidated = new Set(labels).size;

    // 严格按"缩放 → 逐像素 mapToPalette →（必要时合并低频色）→ 去噪 → 绘制"，不做其他后处理
    const fin = bead.finalize(labels, paletteColors);
    // 这次生成用的品牌就是本作品的品牌，钉住它，供预览/采购/再次打开使用
    this.brandKey = paletteLoader.getCurrentBrand();
    this.brandUnknown = false;   // 新生成的图纸色号来自当前品牌色卡，天然可信
    this.colorMeta = {};
    fin.colors.forEach(c => { this.colorMeta[c.id] = { rgb: c.rgb, code: c.code, brandKey: c.brandKey || this.brandKey, name: c.name, hex: c.hex, short: c.short || c.code }; });
    // grid 只是 fullGrid 在当前形状下的投影（形状外 = -1），
    // 权威数据永远是 fullGrid —— 这样切形状不会覆盖手工改动（审查 F06）。
    this.fullGrid = Array.from(fin.labels);
    this._applyShapeToGrid(useW, useH);
    const boards = bead.splitBoards(useW, useH);
    const gStats = this._gridStats(this.grid, this.colorMeta);
    // 最终颜色明细（按数量降序），方便一眼确认目标色是否被保留
    const finalColors = fin.colors.map(c => `${c.code || c.id} ${c.name || ''}(${c.hex}):${c.count}`);
    const diag = {
      extractMethod,
      finalGrid: `${useW}x${useH}`,
      pxStats,
      stageColors: { raw: uniqRaw, limited: uniqLimited, denoised: uniqDenoised, consolidated: uniqConsolidated, final: fin.colors.length },
      gridStats: gStats,
      finalColors,
      sparseWarning: sparseContent ? '非白像素<2%，已临时关闭占比阈值合并。若仍看不见内容，请检查首页是否误开「白底」，或换一张颜色更鲜明的图。' : ''
    };
    // ===== [步骤2~5 设备验证探针] 仅打印，不改任何参数/阈值/算法 =====
    (() => {
      const nameOf = (li) => {
        const p = paletteColors[li];
        return p ? ((p.id || '?') + ' ' + (p.name || '')) : ('idx' + li);
      };
      const countBy = (arr) => {
        const m = new Map();
        for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v < 0) continue; m.set(v, (m.get(v) || 0) + 1); }
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
      };
      // 步骤2：前 5x5 映射到的色板名
      console.log('[步骤2] 前5x5 mapToPalette 结果（黑应为 C02 Black，白应为 C01 White）：');
      for (let yy = 0; yy < Math.min(5, useH); yy++) {
        const row = [];
        for (let xx = 0; xx < Math.min(5, useW); xx++) row.push(nameOf(labelsRaw[yy * useW + xx]));
        console.log('   ' + row.join('  '));
      }
      // 步骤3：limitPaletteColors 前后各色像素数
      const before = countBy(labelsRaw), after = countBy(labelsLimited);
      console.log('[步骤3] limit=' + limit + ' ratioThreshold=' + (ratioThreshold === undefined ? '默认0.01' : ratioThreshold) + ' nonWhiteRatio=' + nonWhiteRatio.toFixed(4) + ' sparse=' + sparseContent);
      console.log('[步骤3] 限制前 ' + before.length + ' 色：' + before.slice(0, 8).map(([li, c]) => nameOf(li) + '=' + c).join(' | '));
      console.log('[步骤3] 限制后 ' + after.length + ' 色：' + after.slice(0, 8).map(([li, c]) => nameOf(li) + '=' + c).join(' | '));
      // 步骤4：denoise 前后（黑色像素数 + 前5x5）
      const blackIdx = paletteColors.findIndex(c => c.id === 'C02');
      const cnt = (arr, li) => { let n = 0; for (let i = 0; i < arr.length; i++) if (arr[i] === li) n++; return n; };
      let changed = 0;
      for (let i = 0; i < labelsLimited.length; i++) if (labelsLimited[i] !== labelsDenoised[i]) changed++;
      console.log('[步骤4] denoise 改动像素=' + changed + '/' + labelsLimited.length + '  黑色(C02) 去噪前=' + cnt(labelsLimited, blackIdx) + ' 去噪后=' + cnt(labelsDenoised, blackIdx));
      for (let yy = 0; yy < Math.min(5, useH); yy++) {
        const a = [], b = [];
        for (let xx = 0; xx < Math.min(5, useW); xx++) { a.push(labelsLimited[yy * useW + xx]); b.push(labelsDenoised[yy * useW + xx]); }
        console.log('   前' + a.join(' ') + '   后' + b.join(' '));
      }
      // 步骤5：绘制参数 + 最终矩阵前5x5
      console.log('[步骤5] 最终网格=' + useW + 'x' + useH + ' grid.length=' + this.grid.length + ' (匹配=' + (this.grid.length === useW * useH) + ')');
      console.log('[步骤5] cell=' + this.cell + 'px  Canvas可用=' + (this.area ? this.area.width + 'x' + this.area.height : '未知') + '  showGrid=' + this.data.showGrid);
      console.log('[步骤5] 最终颜色 ' + fin.colors.length + ' 种：' + fin.colors.map(c => (c.code || c.id) + '×' + c.count).join(' / '));
      for (let yy = 0; yy < Math.min(5, useH); yy++) {
        const row = [];
        for (let xx = 0; xx < Math.min(5, useW); xx++) row.push(this.grid[yy * useW + xx]);
        console.log('   grid行' + yy + ': ' + row.join(' '));
      }
    })();
    this.setData({ grid: this.grid, colors: fin.colors, boards, w: useW, h: useH, shape: this.data.shape, diagInfo: '' });
    this.recomputeColors();
    this.renderGrid();
  },

  loadFromRecord(rec) {
    this._clearHistory(); // 换了一份图纸，旧的逐格差异失效
    this._recId = rec.id || '';
    this.loadFromData(rec);
  },

  // 从草稿恢复（未保存到历史的进度）
  loadFromDraft(d) {
    this._clearHistory();
    this._recId = d.recId || '';
    this.origSrc = d.origSrc || '';
    this.loadFromData(d);
    wx.showToast({ title: '已恢复上次编辑', icon: 'none' });
  },

  // 历史记录与草稿结构基本一致，共用同一套还原逻辑
  loadFromData(rec) {
    this.src = rec.src || '';
    // 颜色元数据必须**全量**恢复。旧版从 rec.colors 建，而 colors 只含"当前可见"
    // 的颜色：圆形图纸里被形状藏起来的格子重开再切矩形，就取不到颜色元数据，
    // 绘图直接报 reading 'rgb'（审查 F06c）。所以优先用完整的 colorMeta。
    this.colorMeta = {};
    const putMeta = (key, m) => {
      if (!m || this.colorMeta[key]) return;
      this.colorMeta[key] = {
        rgb: m.rgb || palette.hexToRgb(m.hex),
        code: m.code,
        brandKey: m.brandKey || rec.brand || '',
        name: m.name,
        hex: m.hex,
        short: m.short || m.code
      };
    };
    if (rec.colorMeta) Object.keys(rec.colorMeta).forEach(id => putMeta(id, rec.colorMeta[id]));
    (rec.colors || []).forEach(c => putMeta(String(c.id), c));
    // 恢复作品自身的品牌（与"用户新作品的默认品牌"分开存）：
    // 拿 Hama 图纸进来却按全局 MARD 去预览，标题写 MARD、色号写 H01，
    // 用户照着买就买错（审查 F05）。老记录没有 brand 时留空，
    // 由 utils/migrate.js 按色号/色值推定。
    this.brandKey = rec.brand || '';
    // 迁移层判不出品牌时会打 brandUnknown 标记（utils/migrate.js）。
    // 这个标记必须一路带到界面：旧作品的色号（如 C1）在哪个品牌下都不成立，
    // 直接按当前默认品牌去预览/采购，用户会照着错的色号下单（复核 R3）。
    this.brandUnknown = !!rec.brandUnknown;
    if (this.brandKey && paletteLoader.getBrand(this.brandKey)) {
      paletteLoader.setCurrentBrand(this.brandKey);
      const bl = this.data.brandList || [];
      for (let bi = 0; bi < bl.length; bi++) {
        if (bl[bi].key === this.brandKey) {
          this.setData({ brandIndex: bi, paletteInfo: paletteLoader.getPaletteInfo(this.brandKey) });
          break;
        }
      }
    }
    // 用 toGridArray 兜底：早期版本把 Int32Array 直接写进 storage，JSON 序列化后
    // 变成 {"0":..,"1":..} 这种没有 length 的对象，rec.grid.slice() 会直接抛错。
    this.grid = storage.toGridArray(rec.grid);
    // fullGrid = 权威网格（未做形状掩膜）。老记录可能没存，退回用 grid ——
    // 这样非矩形老图纸再切形状也不会拿已掩膜的网格二次掩膜、边缘越切越小。
    this.fullGrid = rec.fullGrid ? storage.toGridArray(rec.fullGrid) : this.grid.slice();
    this.locked = rec.locked || {};
    const shape = rec.shape || 'rect';
    const fitMode = rec.fitMode || 'contain';
    this.setData({
      w: rec.w, h: rec.h,
      colorCount: rec.colorCount || this.data.colorCount,
      shape,
      shapeIndex: Math.max(0, ['rect', 'circle', 'hexagon'].indexOf(shape)),
      fitMode,
      fitModeIndex: fitMode === 'cover' ? 1 : 0,
      showGrid: true,
      boards: rec.boards || null,
      brandUnknown: !!this.brandUnknown
    });
    // 投影遮罩要跟记录里的形状一致，否则改动会写错格子
    this._shapeMask = bead.buildShapeMask(rec.w, rec.h, shape);
    this._dirty = false; // 刚载入，尚未改动
    this.recomputeColors();
  },

  // 退出或被切走时自动存档：进程被系统回收、崩溃、或用户直接返回，
  // 都不会丢掉「改了一半但还没保存到历史」的进度。
  // 只有真的改动过（_dirty）才写，避免「打开看看就退出」也攒出草稿。
  // 页面被销毁（直接返回、小程序被回收）时也要存档。
  // onHide 不覆盖所有退出路径，onUnload 是这道闸的最后一道（审查 F04）。
  onUnload() { this.onHide(); },

  onHide() {
    if (!this._dirty || !this.grid || !this.grid.length) return;
    const r = storage.saveDraft({
      recId: this._recId || '',
      src: this.src || '',
      origSrc: this.origSrc || '',
      w: this.data.w, h: this.data.h,
      colorCount: this.data.colorCount,
      shape: this.data.shape,
      fitMode: this.data.fitMode,
      // 作品自身的品牌要跟着草稿一起存，否则恢复后预览/采购会顶着全局默认品牌（审查 F05）
      // 品牌未知时**不能**回退成当前默认品牌：那等于把"未知"洗成"MARD"，
      // 下次打开迁移层会当成已知品牌去改写色号，错误就此固化成"可信"数据（复核 R3）。
      brand: this.brandUnknown ? '' : (this.brandKey || paletteLoader.getCurrentBrand()),
      brandUnknown: !!this.brandUnknown,
      // 权威网格一律存：形状只是投影，丢了 fullGrid 就等于丢掉形状外的改动（审查 F06）
      fullGrid: this.fullGrid,
      grid: this.grid,
      colorMeta: this.colorMeta,
      locked: this.locked,
      boards: this.data.boards
    });
    if (!r.ok) console.warn('[editor] 草稿未存档：', r.reason);
  },

  recomputeColors() {
    const counts = {};
    for (const id of this.grid) { if (id < 0) continue; counts[id] = (counts[id] || 0) + 1; }
    let total = 0;
    const panel = Object.keys(this.colorMeta).map(id => {
      const m = this.colorMeta[id];
      const cnt = counts[id] || 0; total += cnt;
      return { id: +id, rgb: m.rgb, code: m.code, name: m.name, hex: m.hex, count: cnt, locked: !!this.locked[id] };
    }).filter(c => c.count > 0).sort((a, b) => b.count - a.count);
    let activeId = this.data.activeColorId;
    if (activeId == null || !this.colorMeta[activeId] || counts[activeId] === 0) {
      activeId = panel.length ? panel[0].id : null;
    }
    const activeColor = activeId != null ? this.colorMeta[activeId] : { hex: '#fff', code: '-', name: '背景' };
    this.setData({ palettePanel: panel, totalCount: total, activeColorId: activeId, activeColor });
  },

  renderGrid() {
    if (!this.ctx) return;
    this._refitCanvas();          // 画布尺寸跟随网格比例（宽图/高图/对齐网格都铺满，无留白带）
    const { ctx, area } = this;
    this.computeCell();
    const w = this.data.w, h = this.data.h;
    // 尺寸校验：grid 长度必须与 w*h 一致，否则说明数据没跟着尺寸更新（改尺寸后未重算），
    // 直接跳过绘制避免 colorMeta[undefined].rgb 抛错把画布画崩（=「换尺寸后看不到」的根因）
    if (!this.grid || this.grid.length !== w * h) {
      console.error('[renderGrid] ⚠️ grid 尺寸与 w*h 不匹配（grid=' + (this.grid ? this.grid.length : 0) + ' vs ' + (w * h) + '），跳过本次绘制');
      return;
    }
    // 先铺背景：默认浅灰（让白/浅色块可见）；诊断时整张填红以确认 Canvas 可绘制（第3步）
    if (DIAG.redFillProbe) {
      ctx.fillStyle = 'red';
      ctx.fillRect(0, 0, area.width, area.height);
      console.log('[诊断-红填充] 整张填红成功 => Canvas 可绘制；接下来叠加色块');
    } else {
      // 白底：格子缝隙透出白色而不是浅灰，颜色更干净鲜艳（去暗优化）
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, area.width, area.height);
    }
    const cell = this.cell;
    const offX = Math.floor((area.width - cell * w) / 2);
    const offY = Math.floor((area.height - cell * h) / 2);
    this.offX = offX; this.offY = offY;

    // 像素模式（带间隙 + 深色描边），正方形格
    render.drawGrid(ctx, {
      grid: this.grid, w, h, cell, offX, offY,
      colorMeta: this.colorMeta, mode: 'pixel', symbolMap: null
    });

    // 网格线：像素模式下显示坐标辅助线（由 showGrid 开关控制）
    if (this.data.showGrid) {
      render.drawCoordLines(ctx, { w, h, cell, offX, offY });
    }

    if (this.data.showBoardLines && this.data.boards) {
      this._drawBoardLines();
    }
  },

  // 板线（分板框 + 板号）：renderGrid 整图与 renderCell 局部重绘共用，
  // 保证两个路径画出的板线逐像素一致
  _drawBoardLines() {
    const ctx = this.ctx, cell = this.cell, offX = this.offX, offY = this.offY;
    ctx.strokeStyle = 'rgba(255,122,69,0.9)';
    ctx.lineWidth = 2;
    this.data.boards.boards.forEach(b => {
      const bx = offX + b.x * cell, by = offY + b.y * cell;
      ctx.strokeRect(bx, by, b.w * cell, b.h * cell);
      ctx.fillStyle = '#ff7a45';
      ctx.font = `${Math.max(10, cell * 0.5)}px sans-serif`;
      ctx.fillText(String(b.seq), bx + 3, by + cell * 0.6);
    });
  },

  // 单格增量重绘：只重画 (x,y) 这一格，O(1) 代替整图 O(w*h)。
  // 旧版这里整图调 render.drawGrid——200x200 即 4 万次绘制调用，拖动画笔必卡；
  // 且旧版只画了格子层，会把穿过本格的坐标线/板线抹掉，直到下次整图重绘才恢复。
  // 分层顺序与 renderGrid 一致：白底(恢复1px缝隙) → 格内容 → 坐标格线 → 板线。
  renderCell(x, y) {
    const ctx = this.ctx;
    if (!ctx || !this.cell) return;
    const cell = this.cell, offX = this.offX, offY = this.offY;
    const px = offX + x * cell, py = offY + y * cell;

    // 1. 白底铺本格：恢复色块周围 1px 缝隙（灰→彩切换时不残留旧灰）
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px, py, cell, cell);

    // 2. 本格内容（与 render.drawGrid pixel 分支逐像素一致）
    const id = this.grid[y * this.data.w + x];
    if (id < 0) {
      // 形状外：浅灰底，提示「此处不拼」
      ctx.fillStyle = 'rgb(230,230,230)';
      ctx.fillRect(px, py, cell, cell);
    } else {
      const meta = this.colorMeta[id];
      if (meta && meta.rgb) {
        const col = meta.rgb;
        const gap = cell < 4 ? 0 : 1;
        const ix = px + gap, iy = py + gap, isz = cell - gap * 2;
        ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        ctx.fillRect(ix, iy, isz, isz);
        ctx.strokeStyle = 'rgba(0,0,0,0.10)';
        ctx.lineWidth = 1;
        ctx.strokeRect(ix + 0.5, iy + 0.5, isz - 1, isz - 1);
      }
    }

    // 3. 本格 4 条边界坐标线（沿 10 格加粗规则，与 drawCoordLines 一致；
    //    上下/左右各多画 1px 与相邻线段无缝衔接）
    if (this.data.showGrid) {
      const drawV = (gx) => {
        ctx.strokeStyle = gx % 10 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(offX + gx * cell, py - 1);
        ctx.lineTo(offX + gx * cell, py + cell + 1);
        ctx.stroke();
      };
      const drawH = (gy) => {
        ctx.strokeStyle = gy % 10 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px - 1, offY + gy * cell);
        ctx.lineTo(px + cell + 1, offY + gy * cell);
        ctx.stroke();
      };
      drawV(x); drawV(x + 1); drawH(y); drawH(y + 1);
    }

    // 4. 板线：clip 到本格 ±1px（2px 板线会越界 1px），板号文字也随 clip 裁剪
    if (this.data.showBoardLines && this.data.boards) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(px - 1, py - 1, cell + 2, cell + 2);
      ctx.clip();
      this._drawBoardLines();
      ctx.restore();
    }
  },

  onTouch(e) {
    // 收笔 / 取消必须先于一切坐标判断处理：手指划出画布、抬在工具栏上、
    // 被系统手势打断，都不能让这一笔"悬着" —— 旧版 WXML 只绑了 touchstart/
    // touchmove，_commitStroke() 永远不执行，于是撤销栈为空、草稿不写，
    // 画完一笔按撤销没反应（审查 F04）。
    if (e.type === 'touchend' || e.type === 'touchcancel') {
      this._commitStroke();
      this.recomputeColors();
      return;
    }
    if (!this.cell) return;
    const t = e.touches[0] || e.changedTouches[0];
    if (!t) return;
    const x = Math.floor((t.x - this.offX) / this.cell);
    const y = Math.floor((t.y - this.offY) / this.cell);
    if (x < 0 || y < 0 || x >= this.data.w || y >= this.data.h) return;
    // 区域填充 = 一次点击一个事务：自己开合笔画并当场提交
    if (this.data.activeTool === 'fill') {
      if (e.type !== 'touchstart') return;
      this._beginStroke();
      this.applyTool(x, y);
      this._commitStroke();
      return;
    }
    if (e.type === 'touchstart') this._beginStroke();
    this.applyTool(x, y);
  },

  applyTool(x, y) {
    const idx = y * this.data.w + x;
    const tool = this.data.activeTool;
    if (tool === 'recolor' || tool === 'brush') {
      this._recordCell(idx, this.data.activeColorId);
      this.renderCell(x, y);
    } else if (tool === 'eraser') {
      this._recordCell(idx, -1);
      this.renderCell(x, y);
    } else if (tool === 'fill') {
      this.floodFill(x, y, this.data.activeColorId);
      this.renderGrid();
    }
  },

  // 某格是否在「制作范围」（形状）之外。
  // 形状外的格子投影恒为 -1，与「用户擦除 / 透明导致的 -1」在投影上同值，
  // 只能靠形状遮罩区分；rect 的遮罩全是 1，所以矩形下恒为 false。
  _isOutside(idx) { return !!(this._shapeMask && this._shapeMask[idx] < 0); },

  floodFill(x, y, newId) {
    const w = this.data.w, h = this.data.h, grid = this.grid;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const start = y * w + x;
    // 起点在制作范围外：直接拒绝并给出可见反馈，不做任何写入
    if (this._isOutside(start)) { wx.showToast({ title: '超出制作范围', icon: 'none' }); return; }
    const old = grid[start];
    if (old === newId) return;
    if (old >= 0 && this.locked[old]) { wx.showToast({ title: '该颜色已锁定', icon: 'none' }); return; }
    // visited 必须与「投影颜色是否已变」解耦，这是终止性的唯一保证：
    // 形状外的格子经 _setCell 写过之后投影仍是 -1，靠 grid[i] !== old 判断
    // 永远为假，两个相邻外格会把彼此反复入栈直到卡死（复核报告 R1）。
    // 同时不能简单禁止填 -1 —— 形状内被擦除的格子投影也是 -1，应当允许补豆。
    const visited = new Uint8Array(w * h);
    const stack = [start];
    visited[start] = 1;
    let changed = false;
    while (stack.length) {
      const i = stack.pop();
      if (grid[i] !== old) continue;
      if (this._stroke) this._stroke.push({ i, from: old, to: newId });
      // 走 _setCell 而不是直接写 grid：grid 只是形状投影，
      // 只写它的话切一次形状，手工填的色就被 fullGrid 覆盖回去了（审查 F06a）
      this._setCell(i, newId);
      changed = true;
      const cx = i % w, cy = (i - cx) / w;
      // 只扩散到制作范围内、且没访问过的格子：填充不允许写到范围外
      if (cx > 0 && !visited[i - 1] && !this._isOutside(i - 1)) { visited[i - 1] = 1; stack.push(i - 1); }
      if (cx < w - 1 && !visited[i + 1] && !this._isOutside(i + 1)) { visited[i + 1] = 1; stack.push(i + 1); }
      if (cy > 0 && !visited[i - w] && !this._isOutside(i - w)) { visited[i - w] = 1; stack.push(i - w); }
      if (cy < h - 1 && !visited[i + w] && !this._isOutside(i + w)) { visited[i + w] = 1; stack.push(i + w); }
    }
    // 填充直接写 grid、不走 _recordCell，必须自己标脏：
    // 否则 _dirty 保持 false → onHide/onUnload 不写草稿 → 填完就退白干（审查 F04）。
    if (changed) this._markDirty();
  },

  // ===== 撤销/重做（基础版：画布手绘类按笔画撤销）=====
  _UNDO_LIMIT: 50,

  _beginStroke() {
    if (this._stroke) this._commitStroke(); // 上一笔没收住（如手指划出画布），先补收
    this._stroke = [];
  },

  // 标记「本次进来有改动」，供 onHide 判断是否要存草稿
  _markDirty() { this._dirty = true; },

  // 形状只是「显示 / 制作范围」，不是数据本身。
  // 权威网格永远是 fullGrid；grid 是它在当前形状下的投影（形状外 = -1）。
  // 旧版把 grid 当权威、fullGrid 当备份，于是切形状会用旧 fullGrid 覆盖手工改动
  // （审查 F06a），换品牌后 fullGrid 又留在旧品牌的下标空间（F06b）。
  _applyShapeToGrid(w, h) {
    const W = w || this.data.w, H = h || this.data.h;
    if (!this.fullGrid || !this.fullGrid.length) { this.grid = []; this._shapeMask = null; return this.grid; }
    this._shapeMask = bead.buildShapeMask(W, H, this.data.shape);
    this.grid = bead.applyShapeMask(this.fullGrid, W, H, this.data.shape);
    return this.grid;
  },

  // 写一格：权威网格与投影同时更新。形状外的格子投影保持 -1（不拼），
  // 但改动仍记在 fullGrid 上，切回矩形时会重新出现。
  _setCell(idx, newId) {
    if (this.fullGrid && idx < this.fullGrid.length) this.fullGrid[idx] = newId;
    if (this.grid && idx < this.grid.length) {
      this.grid[idx] = (this._shapeMask && this._shapeMask[idx] < 0) ? -1 : newId;
    }
  },

  // 记录一格改动；颜色没变则不记不画。返回是否真的改了
  //
  // 「旧值」必须与 _setCell 实际写入的数据同源：_setCell 写的是 fullGrid
  // （权威网格），grid 只是它的投影。形状外的格子投影恒为 -1，若从 grid 取旧值，
  // 撤销时就会把这个 -1 写回 fullGrid，抹掉隐藏层里的真实颜色 ——
  // 实测 0 → 1 → -1，切回矩形那格就没了（复核报告 R2）。
  _recordCell(idx, newId) {
    const src = (this.fullGrid && idx < this.fullGrid.length) ? this.fullGrid : this.grid;
    const old = src[idx];
    if (old === newId) return false;
    if (this._stroke) this._stroke.push({ i: idx, from: old, to: newId });
    this._setCell(idx, newId);
    this._markDirty();
    return true;
  },

  // 收笔：把这一笔压入撤销栈、清空重做栈
  _commitStroke() {
    const s = this._stroke;
    this._stroke = null;
    if (!s || !s.length) return;
    this._undoStack.push(s);
    if (this._undoStack.length > this._UNDO_LIMIT) this._undoStack.shift();
    this._redoStack = [];
    this._refreshUndoFlags();
  },

  // 整图重建（导入/重新生成/改尺寸/模板/换品牌）后，旧的逐格差异已失效，撤销历史作废。
  // 注意：切形状**不**走这里 —— 形状只换投影、格子下标没变，撤销历史依然有效。
  _clearHistory() {
    this._undoStack = [];
    this._redoStack = [];
    this._stroke = null;
    this._refreshUndoFlags();
  },

  _refreshUndoFlags() {
    this.setData({ canUndo: !!(this._undoStack && this._undoStack.length), canRedo: !!(this._redoStack && this._redoStack.length) });
  },

  undo() {
    if (this._stroke) this._commitStroke();
    const s = (this._undoStack || []).pop();
    if (!s) return;
    for (let k = s.length - 1; k >= 0; k--) this._setCell(s[k].i, s[k].from);
    this._markDirty();
    this._redoStack.push(s);
    this.renderGrid();
    this.recomputeColors();
    this._refreshUndoFlags();
  },

  redo() {
    const s = (this._redoStack || []).pop();
    if (!s) return;
    for (let k = 0; k < s.length; k++) this._setCell(s[k].i, s[k].to);
    this._markDirty();
    this._undoStack.push(s);
    this.renderGrid();
    this.recomputeColors();
    this._refreshUndoFlags();
  },

  setTool(e) { this.setData({ activeTool: e.currentTarget.dataset.tool }); },

  // 切换色号系统（品牌）：图案不变，只把每种颜色换算成目标品牌的就近色号。
  // 需要按新品牌重新配色时，再点「重新生成」即可。
  onBrand(e) {
    const i = +e.detail.value;
    const b = this.data.brandList[i];
    if (!b) return;
    app.setBrand(b.key);

    // 必须换算**整件作品**，输入取权威网格 fullGrid（没有才退回可见 grid）：
    // 只换可见部分的话，形状藏起来的格子还留在旧品牌的下标空间，
    // 再切一次形状就会取到不存在的颜色项（审查 F06b；预览页 2026-09-20 复核 S1 又踩了一次）。
    // 换算逻辑统一在 brandConvert.convertWork，两边共用，避免再次各写一遍。
    const r = brandConvert.convertWork({
      fullGrid: this.fullGrid, grid: this.grid, colorMeta: this.colorMeta,
      locked: this.locked, toBrand: b.key
    });
    if (r.ok) {
      this.fullGrid = r.fullGrid;
      this.colorMeta = r.colorMeta;
      this.locked = r.locked;     // 锁定色按下标存储，换算后下标变了，跟着重排
      this._applyShapeToGrid();
      this.brandKey = r.brand || b.key;   // 作品品牌跟着换
      this._clearHistory();   // 逐格撤销差异按下标记录，换算后失效
      this._dirty = true;     // 图纸已变，退出时应存草稿
      // 用户已手选品牌并真的换算成功 → 色号可信，解除未知状态、放行导出
      this.brandUnknown = false;
      this.setData({ brandIndex: i, paletteInfo: paletteLoader.getPaletteInfo(), brandUnknown: false });
      this.recomputeColors();
      this.renderGrid();
      const extra = r.merged ? '，' + r.merged + ' 种相近色已合并' : '';
      wx.showToast({ title: '已换成 ' + r.brandName + ' 色号' + extra, icon: 'none' });
      return;
    }
    // 没换算成功（例如没有网格）：色号仍然是不可信的，保持 brandUnknown，
    // 继续拦住下游导出 —— 宁可让用户重做一步，也不要输出看似可信的错误色号。
    this.setData({ brandIndex: i, paletteInfo: paletteLoader.getPaletteInfo() });
    wx.showToast({ title: '已切换到 ' + b.name + '，重新生成后生效', icon: 'none' });
  },

  selectColor(e) {
    const id = +e.currentTarget.dataset.id;
    this.setData({ activeColorId: id, activeTool: 'recolor', activeColor: this.colorMeta[id] });
  },

  toggleLock(e) {
    const id = +e.currentTarget.dataset.id;
    this.locked[id] = !this.locked[id];
    wx.vibrateShort({ type: 'light', fail: () => {} });   // 锁定/解锁给触觉确认（视觉上只有文字+描边变化）
    this._markDirty(); // 锁定状态也是作品的一部分，要跟着草稿一起存
    this.recomputeColors();
  },

  onW(e) {
    const w = Math.max(1, Math.min(200, parseInt(e.detail.value) || 1));
    let h = this.data.h;
    if (this.data.lockRatio && this.srcAspect) {
      h = Math.max(1, Math.min(200, Math.round(w / this.srcAspect)));
    }
    this.setData({ w, h }, () => { if (this.src) { this._markDirty(); this.processImage(); } });
  },
  onH(e) {
    const h = Math.max(1, Math.min(200, parseInt(e.detail.value) || 1));
    let w = this.data.w;
    if (this.data.lockRatio && this.srcAspect) {
      w = Math.max(1, Math.min(200, Math.round(h * this.srcAspect)));
    }
    this.setData({ w, h }, () => { if (this.src) { this._markDirty(); this.processImage(); } });
  },
  onColorCount(e) { this.setData({ colorCount: e.detail.value }); },
  onFitMode(e) {
    const i = +e.detail.value;
    this.setData({ fitModeIndex: i, fitMode: this.data.fitModes[i] === '等比裁切' ? 'cover' : 'contain' });
  },
  onShowGrid(e) { this.setData({ showGrid: e.detail.value }); this.renderGrid(); },
  onShowBoardLines(e) {
    const showBoardLines = e.detail.value;
    this.setData({ showBoardLines });
    app.globalData.prefs.showBoardLines = showBoardLines;
    app.savePrefs();
    this.renderGrid();
  },
  onLockRatio(e) {
    const lockRatio = e.detail.value;
    const patch = { lockRatio };
    // 重新锁定时，按当前宽度 + 图片比例把高度纠正回来（避免之前解锁拉伸造成的变形残留）
    if (lockRatio && this.srcAspect) {
      patch.h = Math.max(1, Math.min(200, Math.round(this.data.w / this.srcAspect)));
    }
    this.setData(patch, () => { if (this.src) { this._markDirty(); this.processImage(); } });
  },

  onShape(e) {
    const i = +e.detail.value;
    const shape = this.data.shapeKeys[i];
    this.setData({ shapeIndex: i, shape });
    // 形状只是换一层投影，不是重建整图：不动 fullGrid，也不清撤销历史
    // （格子下标没变，旧的撤销差异依然有效）。旧版这里用旧 fullGrid 覆盖
    // grid，手工改过的格子会被还原掉（审查 F06a）。
    if (!this.fullGrid || !this.fullGrid.length) return;
    this._markDirty();
    this._applyShapeToGrid();
    this.renderGrid();
    this.recomputeColors();
  },

  onPreset(e) {
    const p = this.data.presets[+e.currentTarget.dataset.i];
    this._clearHistory(); // 预设会改尺寸/形状，撤销历史作废
    this._markDirty();
    this.setData({
      w: p.w, h: p.h, shape: p.shape,
      shapeIndex: Math.max(0, this.data.shapeKeys.indexOf(p.shape))
    });
    this.computeCell();
    if (this.src) this.processImage();
    else {
      // 没有原图时（模板/手绘）当前 grid 就是权威数据，先落成 fullGrid 再投影
      this.fullGrid = this.grid.slice();
      this._applyShapeToGrid(p.w, p.h);
      this.renderGrid();
      this.recomputeColors();
    }
  },

  toggleTemplate() { this.setData({ showTemplate: !this.data.showTemplate }); },
  noop() {},

  applyTemplate(e) {
    const key = e.currentTarget.dataset.key;
    const t = templates.getTemplate(key);
    if (!t) return;
    this._clearHistory(); // 套模板整图替换，撤销历史作废
    this._markDirty();
    this.colorMeta = {};
    // 模板本身只有 hex，没有品牌色号。必须映射到当前品牌的色卡，
    // 否则会生成 code='T1' 这种既不是品牌色号、也买不到的编号（审查 F15）。
    const tplBrand = paletteLoader.getCurrentBrand();
    const tplPal = paletteLoader.getPaletteColors(tplBrand);
    this.brandKey = tplBrand;
    this.brandUnknown = false;   // 模板落到当前品牌色卡，色号可信
    t.colors.forEach((c, i) => {
      const srcRgb = palette.hexToRgb(c.hex);
      const pc = tplPal[bead.nearestPalette(srcRgb, tplPal)] || {};
      // 五个字段必须来自**同一颗豆子**：模板只提供 hex，一旦映射到当前品牌色卡，
      // 就以色卡为准。旧版 rgb 取模板原色、code/hex 取色卡色号，于是
      // 画布上涂的是 #E0301E、图例和采购清单上写的是 #DD422F 的 F13（复核 R7）。
      const meta = {
        rgb: pc.rgb || srcRgb,
        code: pc.code || String(i + 1),
        brandKey: tplBrand,
        name: pc.name || c.name,
        hex: pc.hex || c.hex,
        short: pc.short || pc.code || String(i + 1)
      };
      // 模板原色留档（不参与绘制与图例），日后要核对映射结果时还查得到
      if (pc.rgb && (pc.rgb[0] !== srcRgb[0] || pc.rgb[1] !== srcRgb[1] || pc.rgb[2] !== srcRgb[2])) {
        meta.sourceColor = { rgb: srcRgb, hex: c.hex };
      }
      this.colorMeta[i] = meta;
    });
    this.fullGrid = t.grid.slice();
    this.src = '';
    this.setData({
      w: t.w, h: t.h,
      colors: Object.keys(this.colorMeta).map(id => ({ id: +id, ...this.colorMeta[id], count: 0 })),
      showTemplate: false
    });
    // 先 setData 再投影：形状遮罩要用新的 w/h 算
    this._applyShapeToGrid(t.w, t.h);
    this.computeCell();
    this.recomputeColors();
    this.renderGrid();
    wx.showToast({ title: '已套用：' + (e.currentTarget.dataset.name || ''), icon: 'none' });
  },

  regenerate() {
    this._markDirty(); // 重新生成 = 用户主动改了图纸
    const prefs = app.globalData.prefs;
    prefs.boardSize = { w: this.data.w, h: this.data.h };
    prefs.colorCount = this.data.colorCount;
    prefs.shape = this.data.shape;
    prefs.showBoardLines = this.data.showBoardLines;
    app.savePrefs();
    this.computeCell();
    this.processImage();
  },

  // ===== 方案C：网格对齐模块数 =====
  // 计算对齐后的正方形网格尺寸 N×倍数，并做 cell≥6px 的可用性提示
  computeAlignedGrid() {
    const N = parseInt(this.data.moduleCount, 10);
    if (!N || N <= 0) {
      this.setData({ alignedW: 0, alignedH: 0, alignedWarn: '' });
      return null;
    }
    const m = this.data.gridMultiple || 1;
    let size = N * m;
    let warn = '';
    if (size > 200) {
      size = 200;
      warn = '网格超过 200 上限，已限制为 200（等效倍数约 ' + (200 / N).toFixed(1) + 'x）';
    }
    if (this.area) {
      const cellEst = Math.floor(Math.min(this.area.width, this.area.height) / size);
      if (cellEst < 6) {
        warn = '当前倍数下 cell≈' + cellEst + 'px（<6px），建议降低倍数或减小模块数，否则会偏糊';
      }
    }
    this.setData({ alignedW: size, alignedH: size, alignedWarn: warn });
    console.log('[方案C] 对齐网格=' + size + 'x' + size + ' 倍数=' + m + (warn ? ' 提示=' + warn : ''));
    return { w: size, h: size, warn };
  },

  onModuleCount(e) {
    const cleaned = (e.detail.value || '').replace(/[^0-9]/g, '');
    const patch = { moduleCount: cleaned };
    if (!cleaned) {
      // 清空对齐：恢复为已保存的底板尺寸
      const bs = app.globalData.prefs.boardSize || { w: 50, h: 50 };
      patch.w = bs.w;
      patch.h = bs.h;
    }
    this.setData(patch, () => {
      this.computeAlignedGrid();
      if (this.src) this.processImage();
    });
  },

  onMultiple(e) {
    const i = +e.detail.value;
    const m = +(this.data.multipleOptions[i].replace('x', '')) || 1;
    this.setData({ multipleIndex: i, gridMultiple: m }, () => {
      this.computeAlignedGrid();
      if (this.src && this.data.moduleCount) this.processImage();
    });
  },

  async onAutoDetect() {
    if (!this.src) { wx.showToast({ title: '请先导入图片', icon: 'none' }); return; }
    this.setData({ lastError: '[方案C] 正在扫描模块周期...' });
    try {
      const img = await this.loadImage(this.src);
      const N = this._detectModulePeriod(img);
      if (N && N > 0) {
        this.setData({ moduleCount: String(N) }, () => {
          this.computeAlignedGrid();
          if (this.src) this.processImage();
        });
        wx.showToast({ title: '检测到模块数 ' + N, icon: 'none' });
      } else {
        this.setData({ lastError: '未检测到规律周期（可能不是标准像素画/二维码），请手动输入模块数。' });
        wx.showToast({ title: '未检测到，请手动输入', icon: 'none' });
      }
    } catch (err) {
      this.setData({ lastError: '自动检测失败：' + (err && err.message || err) });
    }
  },

  // 扫描图片的水平投影，找黑白交替的最小稳定周期 → 模块数 N
  _detectModulePeriod(img) {
    try {
      const iw = img.width, ih = img.height;
      // 检测分辨率用 RW=480（而非 240）：模块数越多缩得越小越难测准，
      // 480 下每模块像素数翻倍，可稳定测到 N≈100 的像素画/二维码。
      const RW = 480;
      const RH = Math.max(1, Math.round(RW * ih / iw));
      const off = wx.createOffscreenCanvas({ type: '2d', width: RW, height: RH });
      const octx = off.getContext('2d');
      octx.clearRect(0, 0, RW, RH);
      octx.drawImage(img, 0, 0, RW, RH);
      const data = octx.getImageData(0, 0, RW, RH).data;
      // 亮度矩阵
      const lum = new Array(RH);
      for (let y = 0; y < RH; y++) {
        const row = new Float32Array(RW);
        for (let x = 0; x < RW; x++) {
          const i = (y * RW + x) * 4;
          row[x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        lum[y] = row;
      }
      const N = this._moduleDetectCore(lum, RW, RH);
      if (N > 0) console.log('[方案C] 自动检测：判定为规则像素画 → N=' + N);
      else console.log('[方案C] 自动检测：有机图/照片（无规则模块结构），不启用对齐');
      return N;
    } catch (e) {
      console.warn('[方案C] 自动检测失败', e);
      return 0;
    }
  },

  // ===== 方案C · 自动检测模块数（v2：投影差分法）=====
  // 2026-09-03 重写：旧版「模块内均匀性 σW/σB + 相邻差异 adjRatio」启发式对真实二维码
  // 失效（详见 verification/ 报告），本质是测"马赛克锐利度"而非"模块周期"。
  // 新原理（已在 Node 离线批量验证 20+/22，含真实二维码 21/29/49 模块）：
  //   1. Otsu「双峰」阈值二值化（自适应底/前景）
  //   2. 视需要剔除四周白色静区/白边 → 得到内容矩形（内容=黑白马赛克）
  //   3. 对内容区做 行/列投影，取相邻投影差分的峰值位置（模块行/列边界）
  //   4. 峰值应落在均匀栅格上 → 用「连续 mod 精扫最小化残差」求真实模块宽（非整数精度）
  //   5. N = round(内容宽/mod) ≈ round(内容高/mod)，两侧须一致
  // 规律闸门（拒照片/渐变/纯色）：模块宽≥2.5px 且 峰值对栅格的平均残差≤0.65。
  // 输入 lum: Float32Array[]（RH×RW，0..255 亮度），由 _detectModulePeriod 先缩到 RW=480。
  // 返回 N（模块数）；非规则图/检测失败返回 0。
  _moduleDetectCore(lum, RW, RH) {
    try {
      // ---- 1. Otsu 双峰阈值 ----
      const hist = new Int32Array(256);
      for (let y = 0; y < RH; y++) { const row = lum[y]; for (let x = 0; x < RW; x++) { hist[Math.max(0, Math.min(255, Math.round(row[x])))]++; } }
      // 平滑直方图 [1,2,1] 后找两主峰，阈值取两峰中点（对纯黑白双峰更稳，Otsu 会在极值间漂移）
      const sm = new Float32Array(256);
      for (let i = 0; i < 256; i++) { sm[i] = hist[i]; if (i > 0) sm[i] += hist[i - 1] * 2; if (i < 255) sm[i] += hist[i + 1] * 2; }
      let p1 = 0; for (let i = 1; i < 256; i++) if (sm[i] > sm[p1]) p1 = i;
      let p2 = -1, bv = sm[p1] * 0.04;
      for (let i = 0; i < 256; i++) { if (Math.abs(i - p1) < 20) continue; if (sm[i] >= bv) { bv = sm[i]; p2 = i; } }
      let thr;
      if (p2 >= 0) thr = Math.round((Math.min(p1, p2) + Math.max(p1, p2)) / 2);
      else { // 单峰（近纯色/渐变）兜底 Otsu
        let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
        let sumB = 0, wB = 0, mx = -1; thr = 128;
        for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = RW * RH - wB; if (!wF) break; sumB += t * hist[t];
          const mb = sumB / wB, mf = (sum - sumB) / wF, v = wB * wF * (mb - mf) * (mb - mf); if (v > mx) { mx = v; thr = t; } }
      }
      // ---- 2. 二值化 + 黑占比 ----
      const bin = [];
      const colDark = new Int32Array(RW), rowDark = new Int32Array(RH);
      let td = 0;
      for (let y = 0; y < RH; y++) { const row = lum[y]; const b = new Uint8Array(RW);
        for (let x = 0; x < RW; x++) { const v = row[x] <= thr ? 0 : 1; b[x] = v; if (!v) { colDark[x]++; rowDark[y]++; td++; } }
        bin.push(b); }
      const blackRatio = td / (RW * RH);
      if (blackRatio < 0.04 || blackRatio > 0.96) return 0; // 近纯色

      // ---- 3. 视需要裁白静区，得内容矩形 ----
      let x0 = 0, x1 = RW - 1, y0 = 0, y1 = RH - 1;
      const hasMargin = blackRatio < 0.5; // 内容若占满则黑比会更高；白静区时黑比偏低
      if (hasMargin) {
        // 判断外圈是否绝大多数是白（静区）。静区白 → bin=1（亮）。
        let outerLight = 0, outerN = 0;
        for (let x = 0; x < RW; x++) { for (const yy of [0, 1, RH - 2, RH - 1]) { outerN++; if (bin[yy][x]) outerLight++; } }
        for (let y = 0; y < RH; y++) { for (const xx of [0, 1, RW - 2, RW - 1]) { outerN++; if (bin[y][xx]) outerLight++; } }
        if (outerLight / outerN > 0.85) {
          const th = Math.max(2, RH * 0.04);
          let nx0 = -1, nx1 = -1, ny0 = -1, ny1 = -1;
          for (let x = 0; x < RW; x++) if (colDark[x] > th) { nx0 = x; break; }
          for (let x = RW - 1; x >= 0; x--) if (colDark[x] > th) { nx1 = x; break; }
          for (let y = 0; y < RH; y++) if (rowDark[y] > th) { ny0 = y; break; }
          for (let y = RH - 1; y >= 0; y--) if (rowDark[y] > th) { ny1 = y; break; }
          if (nx0 >= 0 && nx1 > nx0 && ny0 >= 0 && ny1 > ny0) { x0 = nx0; x1 = nx1; y0 = ny0; y1 = ny1; }
        }
      }

      // ---- 4. 内容区投影差分 + 求模块宽 ----
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      const peaksOf = (sig, len) => {
        const dr = []; for (let i = 0; i + 1 < len; i++) dr.push(Math.abs(sig[i] - sig[i + 1]));
        const pk = []; const dm = dr.reduce((a, b) => a + b, 0) / dr.length;
        for (let i = 1; i + 1 < dr.length; i++) if (dr[i] > dm * 1.3 && dr[i] >= dr[i - 1] && dr[i] >= dr[i + 1]) pk.push(i + 0.5);
        return pk;
      };
      // 行投影（每行黑像素数）+ 列投影
      const prow = []; for (let y = y0; y <= y1; y++) prow.push(rowDark[y]);
      const pcol = []; for (let x = x0; x <= x1; x++) pcol.push(colDark[x]);
      const pkR = peaksOf(prow, prow.length), pkC = peaksOf(pcol, pcol.length);
      const allPk = pkR.concat(pkC);
      if (allPk.length < 6) return 0;
      // 相邻峰间距众数 → 初始模块宽
      const gaps = [];
      for (let i = 0; i + 1 < pkR.length; i++) gaps.push(pkR[i + 1] - pkR[i]);
      for (let i = 0; i + 1 < pkC.length; i++) gaps.push(pkC[i + 1] - pkC[i]);
      const ghist = new Map(); for (const g of gaps) { const k = Math.round(g * 2) / 2; if (k >= 1) ghist.set(k, (ghist.get(k) || 0) + 1); }
      let best = 0, bcnt = 0; for (const [g, c] of ghist) if (c > bcnt) { bcnt = c; best = g; }
      if (!best) return 0;
      // 连续 mod 精扫：让所有峰值都落在均匀栅格上（最小化平均残差）
      const cost = (mod) => { let s = 0; for (let i = 0; i < allPk.length; i++) { const k = Math.round(allPk[i] / mod); s += Math.abs(allPk[i] - k * mod); } return s / allPk.length; };
      let bm = best, bres = cost(best);
      for (let m = best * 0.6; m <= best * 1.4; m += 0.02) { const c = cost(m); if (c < bres) { bres = c; bm = m; } }
      // 规律闸门：过密(<2.5px/模块) 或 峰不对齐(残差>0.65) → 照片/渐变/噪声
      if (bm < 2.5 || bres > 0.65) return 0;

      // ---- 5. N = 内容宽/mod，两侧一致 ----
      const Nw = Math.round(cw / bm), Nh = Math.round(ch / bm);
      const big = Math.max(Nw, Nh), small = Math.min(Nw, Nh);
      if (big - small > Math.max(1, Math.round(big * 0.12))) return 0;
      const N = Math.round((Nw + Nh) / 2);
      if (N < 6 || N > 200) return 0;
      console.log('[方案C] 检测详情：模块宽=' + bm.toFixed(2) + 'px 残差=' + bres.toFixed(2) +
        ' 内容区=' + cw + 'x' + ch + ' → N=' + N);
      return N;
    } catch (e) {
      console.warn('[方案C] 模块检测异常', e);
      return 0;
    }
  },

  // 检测「内容包围盒」：图被浅色边（通常是白边/浅渐变背景）包围时，返回内容的源图矩形 {sx,sy,sw,sh}。
  // 用于自动裁剪白边，让图案铺满网格。边缘颜色太杂乱、背景非浅色、或内容本就撑满整图时返回 null。
  // 内容识别用「滑动中值法」抗低频渐变，实拍灯光不均的背景也能正确排除。
  _detectContentBBox(img) {
    try {
      const iw = img.width, ih = img.height;
      const SW = Math.min(160, iw);
      const SH = Math.max(1, Math.round(SW * ih / iw));
      const off = wx.createOffscreenCanvas({ type: '2d', width: SW, height: SH });
      const octx = off.getContext('2d');
      octx.clearRect(0, 0, SW, SH);
      octx.drawImage(img, 0, 0, SW, SH);
      const data = octx.getImageData(0, 0, SW, SH).data;
      // 背景色估计：采样四条边的色带，取中位数当背景。
      // 关键改进：不能只采最外圈——若图带黑色相框/截图黑边，最外圈会误判成黑底。
      // 改为「多圈探测」：从外到内采 6 圈，取**亮度最高**那一圈的中位色当背景。
      // 这样能穿透黑框找到真正的白色背景；若整图真无浅色背景，最亮圈也偏暗，bgLum 关卡会兜底。
      const push = (arr, x, y) => { const i = (y * SW + x) * 4; arr.push([data[i], data[i + 1], data[i + 2]]); };
      const lumOf = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
      const median3 = (arr) => {
        const rs = arr.map(p => p[0]).sort((a, b) => a - b);
        const gs = arr.map(p => p[1]).sort((a, b) => a - b);
        const bs = arr.map(p => p[2]).sort((a, b) => a - b);
        const m = Math.floor(arr.length / 2);
        return [rs[m], gs[m], bs[m]];
      };
      let bg = null, bgLumBest = -1, meanDev = 0, bestRing = 0;
      const maxRing = 6;
      for (let ring = 0; ring < maxRing; ring++) {
        const yT = ring, yB = SH - 1 - ring, xL = ring, xR = SW - 1 - ring;
        if (yT > yB || xL > xR) break;
        const ringPx = [];
        for (let x = xL; x <= xR; x++) { push(ringPx, x, yT); push(ringPx, x, yB); }
        for (let y = yT; y <= yB; y++) { push(ringPx, xL, y); push(ringPx, xR, y); }
        const med = median3(ringPx);
        const lum = lumOf(med);
        if (lum > bgLumBest) {
          bgLumBest = lum; bg = med; bestRing = ring;
          let dev = 0; ringPx.forEach(p => { dev += Math.abs(p[0] - med[0]) + Math.abs(p[1] - med[1]) + Math.abs(p[2] - med[2]); });
          meanDev = dev / ringPx.length;
        }
        // 一旦某圈已经是明显浅色（接近白），不用再往里找——白底找到了
        if (lum >= 200) break;
      }
      // 背景色存到页面：供 _extractRegionMode 的低对比拉伸做"内容像素"过滤
      // （即使最后放弃裁剪，背景估计也是有用的）
      this._srcBgColor = bg;
      // meanDev 高不代表没有可裁白边（内容贴边会飙高），只记录，交给滑动中值法判定
      if (meanDev > 60) console.log('[裁剪] 提示：背景圈较杂 meanDev=' + meanDev.toFixed(1) + '（取第' + bestRing + '圈），继续滑动中值法');
      // 背景是否"可裁"——三道门槛（2026-10-12 第二版）：
      //   亮度 ≥170（照片白/浅灰底约 170~230 可裁；蓝色证件照底 lum≈125 拒）
      //   饱和度 rng≤40（彩色底拒）
      //   背景圈内部均匀 meanDev≤50（杂乱实景拒——均匀度不够说明那不是真背景）
      // 上一版把亮度卡到 200：照片里带阴影的灰白底（约 180~199）全被拒，
      // logo 没裁边 → 内容只占网格一半，字母只剩几个格子高，必然糊。
      const bgLum = lumOf(bg);
      const bgRng = Math.max(bg[0], bg[1], bg[2]) - Math.min(bg[0], bg[1], bg[2]);
      if (bgLum < 170 || bgRng > 40 || meanDev > 50) {
        console.log('[裁剪] 放弃：背景不像均匀浅色 bg=[' + bg.join(',') + '] lum=' + bgLum.toFixed(0) +
          ' rng=' + bgRng + ' meanDev=' + meanDev.toFixed(0));
        return null;
      }
      // 相框涂白：若真正的浅色背景不在最外圈（bestRing>0），说明最外几圈是黑框/杂色相框。
      // 这些相框和白色背景差异极大，会被滑动中值法误判为"内容"导致包围盒撑满整图。
      // 把第 0~bestRing-1 圈（相框圈）的像素强制涂成背景色，相当于先拆掉相框再检测内容。
      if (bestRing > 0) {
        console.log('[裁剪] 检测到' + bestRing + '圈相框（外圈非浅色），已按背景色涂除');
        for (let ring = 0; ring < bestRing; ring++) {
          const yT = ring, yB = SH - 1 - ring, xL = ring, xR = SW - 1 - ring;
          if (yT > yB || xL > xR) break;
          const paint = (x, y) => { const i = (y * SW + x) * 4; data[i] = bg[0]; data[i + 1] = bg[1]; data[i + 2] = bg[2]; };
          for (let x = xL; x <= xR; x++) { paint(x, yT); paint(x, yB); }
          for (let y = yT; y <= yB; y++) { paint(xL, y); paint(xR, y); }
        }
      }
      // 内容掩码：滑动中值法。每行/列用「滑动窗口中位数」当**局部**背景基准，
      // 再逐像素和它比较。低频渐变（灯光不均、径向渐变）在窗口内被中位数吸收，
      // 不会误判为内容；只有和局部背景明显不同的主体才被圈进包围盒。
      // 实测比"四角采样/边缘单点参照"稳得多——实拍渐变背景下能正确裁出横长刀身。
      const THR = 45;
      const isContent = new Uint8Array(SW * SH);
      // 滑动中值窗口：约 1/5 宽（取奇数），足够盖过渐变又小于主体尺寸
      const K = Math.max(15, ((SW / 5) | 0) | 1);
      const half = K >> 1;
      // 一维滑动中值：对一条 RGB 像素线（长度 n，每点 [r,g,b]）返回每点的局部中位色
      const medLine = (line) => {
        const n = line.length, out = new Array(n);
        for (let i = 0; i < n; i++) {
          const lo = Math.max(0, i - half), hi = Math.min(n, i + half + 1);
          const rs = [], gs = [], bs = [];
          for (let j = lo; j < hi; j++) { rs.push(line[j][0]); gs.push(line[j][1]); bs.push(line[j][2]); }
          rs.sort((a, b) => a - b); gs.sort((a, b) => a - b); bs.sort((a, b) => a - b);
          const m = rs.length >> 1;
          out[i] = [rs[m], gs[m], bs[m]];
        }
        return out;
      };
      // 行扫描：每行沿 x 做滑动中值 → 局部背景
      for (let y = 0; y < SH; y++) {
        const line = new Array(SW);
        for (let x = 0; x < SW; x++) {
          const i = (y * SW + x) * 4;
          line[x] = [data[i], data[i + 1], data[i + 2]];
        }
        const bgLine = medLine(line);
        for (let x = 0; x < SW; x++) {
          const i = (y * SW + x) * 4, b = bgLine[x];
          const d = Math.abs(data[i] - b[0]) + Math.abs(data[i + 1] - b[1]) + Math.abs(data[i + 2] - b[2]);
          if (d > THR) isContent[y * SW + x] = 1;
        }
      }
      // 列扫描：每列沿 y 做滑动中值，与行扫描取并集
      for (let x = 0; x < SW; x++) {
        const line = new Array(SH);
        for (let y = 0; y < SH; y++) {
          const i = (y * SW + x) * 4;
          line[y] = [data[i], data[i + 1], data[i + 2]];
        }
        const bgLine = medLine(line);
        for (let y = 0; y < SH; y++) {
          if (isContent[y * SW + x]) continue;
          const i = (y * SW + x) * 4, b = bgLine[y];
          const d = Math.abs(data[i] - b[0]) + Math.abs(data[i + 1] - b[1]) + Math.abs(data[i + 2] - b[2]);
          if (d > THR) isContent[y * SW + x] = 1;
        }
      }
      // 只保留「最大连通块」：刀身主体是一整块连通区域，而截图噪点、反光碎屑、
      // 以及那种稀疏连成一条细"尾巴"的孤立像素，都是和主体不连通的小块。
      // 用洪泛填充(BFS)找出所有连通块，只保留面积最大的那块当内容，其余全部丢弃。
      // 这样包围盒由主体决定，不会被稀疏尾巴拖到图底导致下半屏空白。
      // 连通块过滤前的全量内容掩码：供后面的「裁剪框外圈检查」用
      // （过滤会把小碎块清零，但外圈检查需要看到被丢掉的内容）
      const bandAll = isContent.slice();
      const label = new Int32Array(SW * SH).fill(-1);
      const stack = [];
      const sizes = [];                 // 每个连通块的面积
      let bestSize = 0, curLabel = 0;
      for (let s = 0; s < SW * SH; s++) {
        if (!isContent[s] || label[s] >= 0) continue;
        // BFS 展开这一块
        let size = 0;
        stack.length = 0; stack.push(s); label[s] = curLabel;
        while (stack.length) {
          const p = stack.pop(); size++;
          const px = p % SW, py = (p / SW) | 0;
          // 4 邻域
          if (px > 0)      { const q = p - 1;  if (isContent[q] && label[q] < 0) { label[q] = curLabel; stack.push(q); } }
          if (px < SW - 1) { const q = p + 1;  if (isContent[q] && label[q] < 0) { label[q] = curLabel; stack.push(q); } }
          if (py > 0)      { const q = p - SW; if (isContent[q] && label[q] < 0) { label[q] = curLabel; stack.push(q); } }
          if (py < SH - 1) { const q = p + SW; if (isContent[q] && label[q] < 0) { label[q] = curLabel; stack.push(q); } }
        }
        sizes[curLabel] = size;
        if (size > bestSize) bestSize = size;
        curLabel++;
      }
      if (bestSize > 0) {
        // 保留「所有足够大的块」，不再只留最大一块（2026-10-12）：
        // logo 的星号、末尾细笔画字母（Claude 的 e）、证件照里与脸不相连的西装，
        // 都可能和主体不连通——只留最大块会把它们当噪点**整块丢掉**
        // （离线复现实测：合成 Claude logo 的星号被整块吃掉）。
        // 阈值以下的（1~5 像素的截图噪点/反光碎屑）仍然丢。
        const keepMin = Math.max(6, Math.floor(bestSize * 0.02));
        let kept = 0, keptBlocks = 0, droppedBlocks = 0;
        for (let i = 0; i < SW * SH; i++) {
          if (!isContent[i]) continue;
          if (sizes[label[i]] >= keepMin) kept++;
          else isContent[i] = 0;
        }
        for (let L = 0; L < curLabel; L++) (sizes[L] >= keepMin) ? keptBlocks++ : droppedBlocks++;
        console.log('[裁剪] 连通块：共' + curLabel + '块，保留 ' + keptBlocks + ' 块共 ' + kept + ' 像素，丢弃小方块 ' + droppedBlocks + ' 个（keepMin=' + keepMin + '）');
      }
      let minX = SW, minY = SH, maxX = -1, maxY = -1;
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          if (isContent[y * SW + x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) { console.log('[裁剪] 放弃：未检出任何内容像素（THR=' + THR + ' 下全图与局部背景差异都不足）'); return null; }
      const kx = iw / SW, ky = ih / SH;
      const bw = (maxX - minX + 1) * kx, bh = (maxY - minY + 1) * ky;
      // 内容若几乎撑满整张图（没有可裁的边），就不裁
      if (bw >= iw * 0.96 && bh >= ih * 0.96) {
        console.log('[裁剪] 放弃：内容几乎撑满整图 bw=' + Math.round(bw) + '/' + iw + ' bh=' + Math.round(bh) + '/' + ih);
        return null;
      }
      // 裁剪框外圈检查（2026-10-12 第二版，替代"面积<30% 拒裁"）：
      // 看紧贴裁剪框外面一圈（约图宽 2%）是否还是背景——
      //   · 合法裁边（大白底上的 logo/QR）：框外是纯背景 → 放行（这类内容面积常 <10%，按面积卡会误杀）
      //   · 误裁（蓝底证件照把构图裁到只剩脸）：框外紧贴着西装/头发等大量内容 → 拒
      // isContent 在连通块过滤前先留一份全量副本用于本检查。
      if (bandAll && bandAll.length) {
        const T = Math.max(2, Math.round(SW * 0.02));
        let bandTotal = 0, bandContent = 0;
        const x0 = Math.max(0, minX - T), x1 = Math.min(SW - 1, maxX + T);
        const y0 = Math.max(0, minY - T), y1 = Math.min(SH - 1, maxY + T);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const inBox = (x >= minX && x <= maxX && y >= minY && y <= maxY);
            if (inBox) continue;
            bandTotal++;
            if (bandAll[y * SW + x]) bandContent++;
          }
        }
        const frac = bandTotal ? bandContent / bandTotal : 0;
        if (frac > 0.10) {
          console.log('[裁剪] 放弃：裁剪框外圈仍有 ' + Math.round(frac * 100) + '% 内容像素，疑似把构图裁到只剩局部');
          return null;
        }
      }
      // 映射回源图坐标 + 一点 padding（避免贴边太紧/切到细笔画）
      const pad = Math.round(Math.min(bw, bh) * 0.04);
      const x0 = Math.max(0, Math.floor(minX * kx) - pad);
      const y0 = Math.max(0, Math.floor(minY * ky) - pad);
      const x1 = Math.min(iw, Math.ceil((maxX + 1) * kx) + pad);
      const y1 = Math.min(ih, Math.ceil((maxY + 1) * ky) + pad);
      return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
    } catch (e) {
      console.warn('[裁剪] 失败', e);
      return null;
    }
  },

  goPreview() {
    // 用作品自身的品牌，不是全局当前品牌：打开一张 Hama 老图纸时两者并不相同（审查 F05）
    const unknown = !!this.brandUnknown;
    // 品牌未知时**留空**，绝不回退成当前默认品牌：那会把旧色号（C1 之类）
    // 冒充成 MARD 的合法色号，用户照着采购清单买回来的豆子对不上（复核 R3）。
    const workBrand = unknown ? '' : (this.brandKey || paletteLoader.getCurrentBrand());
    const workInfo = unknown ? { brandName: '', size: '', count: 0 }
                             : paletteLoader.getPaletteInfo(workBrand);
    app.globalData.project = {
      src: this.src,
      brand: workBrand,
      brandName: workInfo.brandName,
      brandUnknown: unknown,
      w: this.data.w, h: this.data.h,
      shape: this.data.shape,
      colorCount: this.data.colorCount,
      fitMode: this.data.fitMode,
      grid: this.grid, colorMeta: this.colorMeta, colors: this.data.colors,
      boards: this.data.boards, locked: this.locked,
      palettePanel: this.data.palettePanel,
      // 来自历史就带上原记录 id，预览页保存时才知道该更新哪一条（而不是又新增一份）
      recId: this._recId || '',
      // 非矩形才带 fullGrid，供重新生成/切形状使用
      fullGrid: (this.data.shape && this.data.shape !== 'rect') ? this.fullGrid : null
    };
    if (unknown) {
      // 进得去预览（用户要能看效果），但预览页会挡住一切导出，直到选定品牌
      wx.showToast({ title: '色号系统未确认，导出前请先选择', icon: 'none', duration: 2500 });
    }
    wx.navigateTo({ url: '/pages/preview/preview' });
  },
  // 分享给好友（右上角“...”→ 转发）
  onShareAppMessage() {
    return {
      title: '豆豆工坊A · 一句话生成拼豆图纸',
      path: '/pages/index/index',
      imageUrl: ''
    };
  },

  // 分享到朋友圈
  onShareTimeline() {
    return {
      title: '豆豆工坊A · 一句话生成拼豆图纸',
      imageUrl: ''
    };
  }

});