// app.js
const paletteLoader = require('./utils/paletteLoader.js');
const storage = require('./utils/storage.js');

App({
  globalData: {
    // 当前正在编辑的工程数据，在页面间传递
    project: null,
    // 用户偏好
    prefs: {
      boardSize: { w: 50, h: 50 },
      colorCount: 12,
      algorithm: 'median', // uniform | median | kmeans | dominant
      brand: 'mard',        // 色号系统：默认 MARD（国内最常用）
      lockBrand: true,
      showGrid: true,
      showBoardLines: true,
      shape: 'rect',
      accessibility: { largeFont: false, highContrast: false }
    }
  },

  onLaunch() {
    // 初始化云开发（内容安全校验走云函数）
    // 不传 env 时自动使用"默认环境"（你在开发者工具里开通云开发后创建的第一个环境）
    // 这样就不用每次手动填环境 ID 了
    if (wx.cloud) {
      wx.cloud.init({
        traceUser: true
      });
    }
    // 读取本地偏好
    const prefs = wx.getStorageSync('prefs');
    if (prefs) {
      this.globalData.prefs = Object.assign(this.globalData.prefs, prefs);
    }
    // 让色板加载器与用户偏好保持一致：所有页面拿到的都是同一个品牌的色板
    paletteLoader.setCurrentBrand(this.globalData.prefs.brand);
    // 回滚可能在上次退出时中途失败（两个 key 换到一半）。启动时先把它收尾：
    // 把仅存的救援快照放回备份键，否则下一次点回滚会把它覆盖掉（复核 R6）。
    try { storage.recoverRestore(); } catch (e) { console.warn('[app] 回滚事务收尾失败', e); }
  },

  // 切换色号系统：写入偏好并立即生效，返回最终生效的品牌 key
  setBrand(key) {
    const k = paletteLoader.setCurrentBrand(key);
    this.globalData.prefs.brand = k;
    this.savePrefs();
    return k;
  },

  savePrefs() {
    wx.setStorageSync('prefs', this.globalData.prefs);
  }
});
