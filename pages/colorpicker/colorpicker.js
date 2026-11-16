// pages/colorpicker/colorpicker.js
// 试色器：拍照/选图，取画面主色并匹配最接近的拼豆色号，方便对照实物豆。
//
// 色号来自「所选品牌」的真实色卡数据。旧版是把几个品牌的颜色混在一起匹配，
// 给出的色号可能既不属于你手上的品牌、也买不到 —— 现在按品牌精确匹配。
const paletteLoader = require('../../utils/paletteLoader.js');
const { checkImage } = require('../../utils/secCheck.js');

// 返回最接近的色板下标（用下标而非 hex 做键，避免同色值不同色号互相覆盖）
function nearestIdx(rgb, all) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    const d = (rgb[0] - c.rgb[0]) ** 2 + (rgb[1] - c.rgb[1]) ** 2 + (rgb[2] - c.rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

Page({
  data: {
    src: '',
    mainHex: '',
    mainRgb: null,
    matches: [],
    loading: false,
    brandList: [],
    brandNames: [],
    brandIndex: 0,
    brandName: '',
    brandCount: 0
  },

  allColors: [],

  onLoad() {
    const app = getApp();
    const brand = (app.globalData.prefs && app.globalData.prefs.brand) || paletteLoader.getCurrentBrand();
    const key = paletteLoader.setCurrentBrand(brand);
    const list = paletteLoader.getBrandList();
    let idx = 0;
    for (let i = 0; i < list.length; i++) { if (list[i].key === key) { idx = i; break; } }
    this.setData({
      brandList: list,
      brandNames: list.map(function (b) { return b.name; }),
      brandIndex: idx,
      brandName: list[idx] ? list[idx].name : '',
      brandCount: list[idx] ? list[idx].count : 0
    });
    this.refreshColors();
  },

  refreshColors() {
    const b = this.data.brandList[this.data.brandIndex];
    const key = b ? b.key : null;
    const info = paletteLoader.getPaletteInfo(key);
    const pal = paletteLoader.getPaletteColors(key);
    this.allColors = pal.map(function (c) {
      return {
        brand: info.brandName,
        code: c.id,
        short: c.short || c.id,
        name: c.name,
        hex: c.hex,
        rgb: c.rgb
      };
    });
  },

  // 切换色号系统：已识别的结果按新品牌重新给出
  onBrand(e) {
    const i = +e.detail.value;
    const b = this.data.brandList[i];
    if (!b) return;
    const app = getApp();
    app.setBrand(b.key);
    this.setData({ brandIndex: i, brandName: b.name, brandCount: b.count });
    this.refreshColors();
    if (this.data.src) {
      this.analyze(this.data.src);
    } else {
      wx.showToast({ title: '已切换到 ' + b.name, icon: 'none' });
    }
  },

  async chooseAlbum() {
    const r = await wx.chooseMedia({ mediaType: ['image'], sourceType: ['album'], sizeType: ['compressed'] });
    const path = r.tempFiles[0].tempFilePath;
    const pass = await checkImage(path);
    if (!pass.ok) return;
    this.analyze(path);
  },
  async chooseCamera() {
    const r = await wx.chooseMedia({ mediaType: ['image'], sourceType: ['camera'], sizeType: ['compressed'] });
    const path = r.tempFiles[0].tempFilePath;
    const pass = await checkImage(path);
    if (!pass.ok) return;
    this.analyze(path);
  },

  async analyze(src) {
    this.setData({ src, loading: true, matches: [], mainHex: '' });
    const query = wx.createSelectorQuery();
    query.select('#cv').fields({ node: true, size: true }).exec(async (res) => {
      const c = res[0].node;
      const dpr = wx.getWindowInfo().pixelRatio;
      c.width = res[0].width * dpr; c.height = res[0].height * dpr;
      const ctx = c.getContext('2d');
      ctx.scale(dpr, dpr);
      const img = c.createImage();
      img.src = src;
      img.onerror = () => {
        // 加载失败必须结束 loading，否则界面一直转圈（审查 F12）
        this.setData({ loading: false, mainHex: '', matches: [] });
        wx.showToast({ title: '图片加载失败', icon: 'none' });
      };
      img.onload = () => {
        // 缩到 36x36 采样。
        // 必须用独立、固定分辨率的离屏画布：显示用的 canvas 做了 ctx.scale(dpr,dpr)，
        // 而 getImageData 读的是**物理像素**、不受 scale 变换影响，
        // 于是高 DPR 机型上只读到左上角 1/dpr² 的区域 —— 识色整体偏左上
        // （审查 F12：DPR=2 时红色读到 1296、蓝色读到 0）。
        const S = 36;
        let sample = null, SW = S, SH = S;
        try {
          sample = wx.createOffscreenCanvas({ type: '2d', width: S, height: S }).getContext('2d');
        } catch (err) {
          sample = null;
        }
        if (!sample) {
          // 没有离屏画布时的兜底：按物理像素读整块已绘制区域，绝不按逻辑尺寸读
          sample = ctx;
          SW = Math.round(S * dpr); SH = Math.round(S * dpr);
          sample.clearRect(0, 0, res[0].width, res[0].height);
        }
        sample.drawImage(img, 0, 0, S, S);
        const data = sample.getImageData(0, 0, SW, SH).data;
        const all = this.allColors;
        if (!all.length) { this.setData({ loading: false }); return; }

        const counts = new Array(all.length).fill(0);
        let mainIdx = -1, mainCount = 0;
        const px = Math.floor(data.length / 4);
        for (let i = 0; i < px; i++) {
          const a = data[i * 4 + 3];
          if (a < 10) continue;
          const idx = nearestIdx([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]], all);
          counts[idx]++;
          if (counts[idx] > mainCount) { mainCount = counts[idx]; mainIdx = idx; }
        }

        const matches = counts.map(function (n, i) { return { c: all[i], n: n }; })
          .filter(function (x) { return x.n > 0; })
          .sort(function (a, b) { return b.n - a.n; })
          .slice(0, 6)
          .map(function (x) {
            return {
              brand: x.c.brand,
              code: x.c.code,
              short: x.c.short,
              name: x.c.name,
              hex: x.c.hex,
              rgb: x.c.rgb,
              count: x.n
            };
          });

        const main = mainIdx >= 0 ? all[mainIdx] : null;
        this.setData({
          loading: false,
          mainHex: main ? main.hex : '',
          mainRgb: main ? main.rgb : null,
          matches: matches
        });
      };
    });
  },

  toHex(rgb) {
    return '#' + rgb.map(v => ('0' + Math.max(0, Math.min(255, v | 0)).toString(16)).slice(-2)).join('').toUpperCase();
  },

  copyOne(e) {
    const item = e.currentTarget.dataset.item;
    wx.setClipboardData({ data: `${item.brand} ${item.code} ${item.name} ${item.hex}` });
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
