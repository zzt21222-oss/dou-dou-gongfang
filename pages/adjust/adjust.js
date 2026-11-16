// pages/adjust/adjust.js
// 图片调整页：承接首页选图后的「预览 + 调整 + 裁剪 + 笔刷抠图」，完成后跳编辑器
const app = getApp();

Page({
  data: {
    src: '',
    brightness: 100,
    contrast: 100,
    saturate: 100,
    rotate: 0,
    mirror: false,
    bgWhite: false,
    ratio: 'free',
    ratios: ['free', '1:1', '4:3', '3:4', '16:9', '9:16'],
    cutMode: false,
    brushSize: 24,
    brushMode: 'erase',
    a11yClass: ''
  },

  img: null,
  imgSrc: '',
  crop: { sx: 0, sy: 0, sw: 0, sh: 0 },
  mask: null,
  maskW: 0,
  maskH: 0,
  overlay: null,
  octx: null,

  // ===== 渲染 / 导出的串行化 =====
  // render() 是异步的（第一句就是 await this.ensureCanvas()）。旧版 goEditor
  // 直接调用它却不等待，于是 applyMask / applyCutWhite 烧进画布的擦除像素
  // 会被 render 后半段的重绘整片盖回去：擦除处 alpha 先为 0，
  // 等编码器真正取像素时又变回 255（复核报告 R5）。
  // 这里把所有「会重绘画布」和「要读画布」的操作排进同一条链，
  // 保证 重绘 → 烧遮罩 → 导出 三步之间插不进另一次 render。
  _serial(task) {
    const prev = this._chain || Promise.resolve();
    const next = prev.then(function () { return task(); });
    // 前一步失败也不能卡死整条链（错误由调用方各自的 Promise 处理）
    this._chain = next.catch(function () {});
    return next;
  },
  _queueRender() { return this._serial(() => this.render()); },

  // 首页选图后跳过来，图片临时路径通过 URL 参数 src 传入
  onLoad(options) {
    const src = options && options.src ? decodeURIComponent(options.src) : '';
    if (!src) {
      wx.showToast({ title: '没有拿到图片', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.setData({ src });
    this._queueRender();
  },

  onShow() {
    const app = getApp();
    const acc = (app.globalData.prefs && app.globalData.prefs.accessibility) || {};
    this.setData({ a11yClass: (acc.largeFont ? ' a11y-lg' : '') + (acc.highContrast ? ' a11y-hc' : '') });
  },

  // 返回首页
  goHome() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/index/index' })
    });
  },

  ensureCanvas() {
    if (this.canvas && this.overlay) return Promise.resolve();
    return new Promise((resolve) => {
      const q = wx.createSelectorQuery();
      q.select('#cv').fields({ node: true, size: true });
      q.select('#ov').fields({ node: true, size: true });
      q.exec((res) => {
        const c = res[0].node;
        const ctx = c.getContext('2d');
        const dpr = wx.getWindowInfo().pixelRatio;
        c.width = res[0].width * dpr;
        c.height = res[0].height * dpr;
        ctx.scale(dpr, dpr);
        this.canvas = c; this.ctx = ctx;
        this.cssW = res[0].width; this.cssH = res[0].height;

        const ov = res[1].node;
        const octx = ov.getContext('2d');
        ov.width = res[1].width * dpr;
        ov.height = res[1].height * dpr;
        octx.scale(dpr, dpr);
        this.overlay = ov; this.octx = octx;
        this.ovCssW = res[1].width; this.ovCssH = res[1].height;
        resolve();
      });
    });
  },

  loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = this.canvas.createImage();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  },

  setImage(src) {
    this.setData({ src, brightness: 100, contrast: 100, saturate: 100, rotate: 0, mirror: false, bgWhite: false, ratio: 'free', cutMode: false });
    this.img = null;
    this.mask = null;
    if (this.octx) this.octx.clearRect(0, 0, this.ovCssW, this.ovCssH);
    this._queueRender();
  },

  recomputeCrop() {
    const img = this.img;
    const ratio = this.data.ratio;
    if (ratio === 'free' || !img) {
      this.crop = { sx: 0, sy: 0, sw: img ? img.width : 0, sh: img ? img.height : 0 };
      return;
    }
    const [rw, rh] = ratio.split(':').map(Number);
    const target = rw / rh;
    const cur = img.width / img.height;
    let sw, sh;
    if (cur > target) { sh = img.height; sw = img.height * target; }
    else { sw = img.width; sh = img.width / target; }
    this.crop = { sx: (img.width - sw) / 2, sy: (img.height - sh) / 2, sw, sh };
  },

  async render() {
    await this.ensureCanvas();
    if (!this.data.src) return;
    if (!this.img || this.imgSrc !== this.data.src) {
      try {
        this.img = await this.loadImage(this.data.src);
        this.imgSrc = this.data.src;
        this.recomputeCrop();
      } catch (e) {
        wx.showToast({ title: '图片加载失败', icon: 'none' });
        return;
      }
    }
    const { ctx, cssW, cssH, img } = this;
    const d = this.data;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.save();
    ctx.translate(cssW / 2, cssH / 2);
    ctx.rotate(d.rotate * Math.PI / 180);
    if (d.mirror) ctx.scale(-1, 1);
    ctx.filter = `brightness(${d.brightness / 100}) contrast(${d.contrast / 100}) saturate(${d.saturate / 100})`;
    const crop = this.crop;
    const scale = Math.min(cssW / crop.sw, cssH / crop.sh);
    const dw = crop.sw * scale, dh = crop.sh * scale;
    ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    ctx.filter = 'none';
    if (d.bgWhite && !d.cutMode) this.applyCutWhite();
  },

  // 去掉白底 = 把近白像素变成**透明**，不是涂成白色。
  // 涂成不透明的白，后面采样时仍会被当成"这里有一颗白豆"，
  // 于是用户擦掉背景、却拿到一张要用白豆填满的矩形图纸（审查 F03）。
  applyCutWhite() {
    const { ctx, canvas } = this;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) {
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        d[i + 3] = 0;   // 关键：alpha 归零，才算真的"去掉了"
      }
    }
    ctx.putImageData(imgData, 0, 0);
  },

  // 笔刷抠图：把遮罩烧入图片（擦除区 alpha=0）
  applyMask() {
    if (!this.mask) return;
    const { ctx, canvas } = this;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = imgData.data;
    const dpr = canvas.width / this.cssW;
    for (let cy = 0; cy < canvas.height; cy++) {
      const my = Math.min(this.maskH - 1, Math.floor(cy / dpr));
      for (let cx = 0; cx < canvas.width; cx++) {
        const mx = Math.min(this.maskW - 1, Math.floor(cx / dpr));
        if (this.mask[my * this.maskW + mx] === 0) {
          d[(cy * canvas.width + cx) * 4 + 3] = 0;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);
  },

  onBrightness(e) { this.setData({ brightness: e.detail.value }); this._queueRender(); },
  onContrast(e) { this.setData({ contrast: e.detail.value }); this._queueRender(); },
  onSaturate(e) { this.setData({ saturate: e.detail.value }); this._queueRender(); },

  rotate90() { this.setData({ rotate: (this.data.rotate + 90) % 360 }); this._queueRender(); },
  toggleMirror() { this.setData({ mirror: !this.data.mirror }); this._queueRender(); },
  cutWhite() { this.setData({ bgWhite: true, cutMode: false }); this._queueRender(); },

  // 抠图模式
  onCutMode() {
    const cutMode = !this.data.cutMode;
    this.setData({ cutMode, bgWhite: false });
    if (cutMode) {
      this.mask = new Uint8Array(this.cssW * this.cssH).fill(1);
      this.maskW = this.cssW; this.maskH = this.cssH;
      if (this.octx) this.octx.clearRect(0, 0, this.ovCssW, this.ovCssH);
    }
  },
  onBrushSize(e) { this.setData({ brushSize: e.detail.value }); },
  onBrushMode(e) { this.setData({ brushMode: e.currentTarget.dataset.mode }); },
  resetMask() {
    if (this.mask) this.mask.fill(1);
    if (this.octx) this.octx.clearRect(0, 0, this.ovCssW, this.ovCssH);
  },

  onMaskTouch(e) {
    if (!this.data.cutMode || !this.mask) return;
    const t = e.touches[0] || e.changedTouches[0];
    if (!t) return;
    const x = Math.round(t.x), y = Math.round(t.y);
    const r = this.data.brushSize;
    const val = this.data.brushMode === 'erase' ? 0 : 1;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const mx = x + dx, my = y + dy;
        if (mx >= 0 && my >= 0 && mx < this.maskW && my < this.maskH) this.mask[my * this.maskW + mx] = val;
      }
    }
    const ctx = this.octx;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = val === 0 ? 'rgba(20,20,20,0.45)' : 'rgba(46,204,113,0.45)';
    ctx.fill();
  },

  reset() {
    this.setData({ brightness: 100, contrast: 100, saturate: 100, rotate: 0, mirror: false, bgWhite: false, ratio: 'free', cutMode: false });
    this.mask = null;
    if (this.octx) this.octx.clearRect(0, 0, this.ovCssW, this.ovCssH);
    this.recomputeCrop();
    this._queueRender();
  },
  setRatio(e) {
    this.setData({ ratio: e.currentTarget.dataset.ratio });
    this.recomputeCrop();
    this._queueRender();
  },

  goEditor() {
    if (!this.data.src) return;
    if (this._exporting) return;   // 连点两下只导一次
    this._exporting = true;
    wx.showLoading({ title: '正在生成图纸…', mask: true });   // 导出秒级耗时，期间挡住"下一步"防连点
    // 整段「重绘 → 烧遮罩 → 导出」作为一个事务排在链上：
    // 期间任何滑杆/旋转触发的重绘都排在它**后面**，不会把擦除结果盖掉。
    this._serial(async () => {
      await this.render();   // 必须等重绘真正结束，再往画布上烧遮罩
      if (this.data.cutMode && this.mask) this.applyMask();
      else if (this.data.bgWhite) this.applyCutWhite();
      await this._exportToEditor();
    }).then(
      () => { this._exporting = false; wx.hideLoading(); },
      () => { this._exporting = false; wx.hideLoading(); }
    );
  },

  // 导出当前画布并跳编辑器。只在上面那个事务内部调用 ——
  // 单独调用（不排队）就会退回到"导出与重绘竞争"的旧问题。
  _exportToEditor() {
    return new Promise((resolve) => {
      // 看门狗：导出回调理论上必然触发 success 或 fail，但万一平台两个都不回，
      // 整条渲染链就会永久挂住（页面从此不再重绘，表现成"卡死"）。
      // 宁可晚一步恢复渲染，也不要让页面死等 —— 故设上限兜底。
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(wd); resolve(); };
      const wd = setTimeout(function () {
        if (done) return;
        console.warn('[adjust] 导出回调超时，恢复渲染队列');
        finish();
      }, 15000);
      wx.canvasToTempFilePath({
        canvas: this.canvas,
        success: (res) => {
          app.globalData.project = {
            src: res.tempFilePath,
            adjust: { ratio: this.data.ratio },
            cropW: this.crop.sw,
            cropH: this.crop.sh
          };
          // 同时把 src 放 URL 里，避免 globalData 丢失导致编辑器读不到图
          // 也把原始图路径带上，临时文件若损坏/过期可回退用原图
          const url = '/pages/editor/editor?src=' + encodeURIComponent(res.tempFilePath)
                    + '&origSrc=' + encodeURIComponent(this.data.src)
                    + '&cropW=' + encodeURIComponent(this.crop.sw)
                    + '&cropH=' + encodeURIComponent(this.crop.sh);
          wx.navigateTo({ url });
          finish();
        },
        fail: () => { wx.hideLoading(); wx.showToast({ title: '生成失败', icon: 'none' }); finish(); }
      });
    });
  }
});
