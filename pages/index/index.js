// pages/index/index.js
// 首页：只做入口（上传 / 拍照 / 试色器 / 教程 / 历史）
// 选图后的「预览 + 调整 + 裁剪 + 笔刷」已抽到 pages/adjust/adjust 页
const paletteLoader = require('../../utils/paletteLoader.js');
const { checkImage } = require('../../utils/secCheck.js');
const storage = require('../../utils/storage.js');

Page({
  onLoad() {
    const info = paletteLoader.getPaletteInfo();
    console.log('[色板] ' + info.brandName + ' · ' + info.count + ' 色（' + info.size + '）');
  },

  data: {
    a11yClass: '',
    draft: null // 未完成的草稿（有则显示「继续上次编辑」卡片）
  },

  onShow() {
    const app = getApp();
    const acc = (app.globalData.prefs && app.globalData.prefs.accessibility) || {};
    this.setData({ a11yClass: (acc.largeFont ? ' a11y-lg' : '') + (acc.highContrast ? ' a11y-hc' : '') });
    this.refreshDraft();
  },

  // 编辑器只在「真的改过」时才写草稿，所以这里能显示，就说明确实有没保存的进度
  refreshDraft() {
    const d = storage.getDraft();
    this.setData({
      draft: d ? { w: d.w, h: d.h, when: this.fmtAgo(d.savedAt) } : null
    });
  },

  fmtAgo(t) {
    if (!t) return '';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  },

  resumeDraft() {
    wx.navigateTo({ url: '/pages/editor/editor?draft=1' });
  },

  discardDraft() {
    wx.showModal({
      title: '放弃草稿',
      content: '将删除这段未保存的编辑内容，且无法找回。确定放弃？',
      confirmText: '放弃',
      confirmColor: '#e54d42',
      success: (r) => {
        if (!r.confirm) return;
        storage.clearDraft();
        this.refreshDraft();
        wx.showToast({ title: '已放弃', icon: 'none' });
      }
    });
  },

  async chooseAlbum() {
    const path = await this._pickAndCheck({ sourceType: ['album'] });
    if (path) this.goAdjust(path);
  },

  async chooseCamera() {
    const path = await this._pickAndCheck({ sourceType: ['camera'] });
    if (path) this.goAdjust(path);
  },

  // 选图 → 安全校验 → 返回临时路径（取消/失败返回空串，调用方直接跳过）。
  // 两个此前没兜住的坑：
  //   1) wx.chooseMedia 用户取消会 reject（promise 化的 fail）——那是正常操作，不能当错误抛；
  //   2) 安全检测进行中再点上传/拍照，会叠出第二个选图框 —— 用 _picking 互斥。
  //      检测本身的「安全检测中」loading 由 checkImage 负责（自带 mask），这里不重复做。
  async _pickAndCheck(opts) {
    if (this._picking) return '';
    this._picking = true;
    try {
      let r;
      try {
        r = await wx.chooseMedia(Object.assign({ mediaType: ['image'], sizeType: ['original'] }, opts));
      } catch (e) {
        if (String((e && e.errMsg) || e).indexOf('cancel') >= 0) return '';
        console.error('[选图失败]', e);
        wx.showToast({ title: '选图失败，请重试', icon: 'none' });
        return '';
      }
      const path = r.tempFiles && r.tempFiles[0] && r.tempFiles[0].tempFilePath;
      if (!path) { wx.showToast({ title: '没有拿到图片', icon: 'none' }); return ''; }
      const pass = await checkImage(path);
      if (!pass.ok) return '';   // 检测未过：checkImage 内部已弹窗说明
      return path;
    } finally {
      this._picking = false;
    }
  },

  // 选完图直接跳「调整图片」页，图片临时路径经 URL 传入
  goAdjust(path) {
    wx.navigateTo({ url: '/pages/adjust/adjust?src=' + encodeURIComponent(path) });
  },

  goColorpicker() {
    wx.navigateTo({ url: '/pages/colorpicker/colorpicker' });
  },
  goGuide() {
    wx.navigateTo({ url: '/pages/guide/guide' });
  },
  goHistory() {
    wx.switchTab({ url: '/pages/history/history' });
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
