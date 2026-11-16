// pages/guide/guide.js
const app = getApp();

Page({
  data: { a11yClass: '', largeFont: false, highContrast: false },

  onShow() {
    const acc = (app.globalData.prefs && app.globalData.prefs.accessibility) || {};
    this.setData({
      largeFont: !!acc.largeFont,
      highContrast: !!acc.highContrast,
      a11yClass: (acc.largeFont ? ' a11y-lg' : '') + (acc.highContrast ? ' a11y-hc' : '')
    });
  },

  goMake() { wx.switchTab({ url: '/pages/index/index' }); },

  onLargeFont(e) { this.setAcc('largeFont', e.detail.value); },
  onHighContrast(e) { this.setAcc('highContrast', e.detail.value); },

  setAcc(key, val) {
    const acc = app.globalData.prefs.accessibility || {};
    acc[key] = val;
    app.globalData.prefs.accessibility = acc;
    app.savePrefs();
    const a = app.globalData.prefs.accessibility;
    this.setData({
      [key]: val,
      a11yClass: (a.largeFont ? ' a11y-lg' : '') + (a.highContrast ? ' a11y-hc' : '')
    });
    wx.showToast({ title: '设置已保存', icon: 'none' });
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