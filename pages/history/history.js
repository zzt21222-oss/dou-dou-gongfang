// pages/history/history.js
const storage = require('../../utils/storage.js');
const thumb = require('../../utils/thumb.js');

Page({
  data: { list: [], syncing: false, cloud: false, cloudMeta: null, backup: null },

  onShow() {
    // 进入历史页（回滚入口所在的页面）之前，先把上次没做完的回滚收尾，
    // 否则展示出来的"可回滚备份"可能已经是一份被覆盖过的内容（复核 R6）
    try { storage.recoverRestore(); } catch (e) { console.warn('[history] 回滚事务收尾失败', e); }
    this.load();
    this.setData({ cloud: storage.isCloudEnabled() });
  },

  // 同步状态 + 本机备份状态。有备份才显示「回滚」，
  // 这样「从云端恢复覆盖错了」还有一次反悔机会。
  refreshMeta() {
    const m = storage.getCloudMeta();
    const b = storage.getBackupInfo();
    let meta = null;
    if (m) {
      const up = m.lastUploadAt || 0, pull = m.lastPullAt || 0;
      const last = Math.max(up, pull);
      if (last) meta = { text: (pull >= up ? '云端恢复于 ' : '上传于 ') + this.fmt(last) };
    }
    this.setData({
      cloudMeta: meta,
      backup: b ? { count: b.count, text: this.fmt(b.at) } : null
    });
  },

  load() {
    const list = storage.getHistory();
    const mapped = list.map(r => ({
      id: r.id,
      name: r.name,
      thumb: r.thumb || '',
      size: `${r.w}×${r.h}`,
      date: this.fmt(r.updatedAt),
      colors: r.colors ? r.colors.length : 0
    }));
    this.setData({ list: mapped });
    this.refreshMeta();
    this.ensureThumbs(list); // 老图纸/缺缩略图的异步补生成，列表先秒出
  },

  // 缩略图补生成：以「永久文件是否存在」为准（不信任记录里的旧路径，
  // 换设备/清缓存后路径可能失效）。生成一张显示一张，并写回记录。
  ensureThumbs(records) {
    const fs = wx.getFileSystemManager();
    records.forEach(r => {
      const fp = thumb.thumbPath(r.id);
      fs.access({
        path: fp,
        success: () => this._applyThumb(r.id, fp, true),
        fail: () => {
          this._gening = this._gening || {};
          if (this._gening[r.id]) return;
          this._gening[r.id] = true;
          thumb.genThumb(r).then(p => {
            delete this._gening[r.id];
            this._applyThumb(r.id, p, true);
          }).catch(() => { delete this._gening[r.id]; }); // 生成失败：卡片显示「生成中」占位，不影响列表
        }
      });
    });
  },

  _applyThumb(id, fp, persist) {
    const list = this.data.list.map(x => (x.id === id ? Object.assign({}, x, { thumb: fp }) : x));
    this.setData({ list });
    if (persist) storage.updateProject(id, { thumb: fp });
  },

  // 图加载失败（如云端恢复后旧路径失效）→ 重新生成
  onThumbError(e) {
    const id = e.currentTarget.dataset.id;
    const rec = storage.getProject(id);
    if (!rec) return;
    thumb.genThumb(rec).then(p => this._applyThumb(id, p, true)).catch(() => {});
  },

  fmt(t) {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${('0' + d.getHours()).slice(-2)}:${('0' + d.getMinutes()).slice(-2)}`;
  },

  open(e) {
    wx.navigateTo({ url: '/pages/editor/editor?id=' + e.currentTarget.dataset.id });
  },

  del(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除',
      content: '确定删除该图纸？',
      success: (r) => {
        if (!r.confirm) return;
        if (storage.removeProject(id)) this.load();
        else wx.showModal({ title: '删除失败', content: '本机存储写入失败，请稍后重试。', showCancel: false });
      }
    });
  },

  goGuide() {
    wx.navigateTo({ url: '/pages/guide/guide' });
  },

  goMake() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  syncCloud() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    // mask 挡住整页：同步期间「从云端恢复 / 回滚」都不许点，防止并发读写存储
    wx.showLoading({ title: '同步中…', mask: true });
    const done = () => { this.setData({ syncing: false }); wx.hideLoading(); };
    storage.syncToCloud().then(r => {
      done();
      if (r.local) {
        wx.showModal({
          title: '本地模式',
          content: r.reason + '。如需换设备同步，请在微信公众平台开通云开发，并部署 syncHistory 云函数 + 创建 bead_docs 集合。',
          showCancel: false
        });
      } else if (r.ok) {
        wx.showToast({ title: '已同步到云端 ' + (r.count || 0) + ' 张' });
        this.refreshMeta();
      } else {
        wx.showModal({
          title: '同步失败',
          content: (r.reason || '') + (r.detail ? '\n' + r.detail : ''),
          showCancel: false
        });
      }
    }, (e) => {
      done();
      console.error('[syncCloud] 同步异常', e);
      wx.showModal({ title: '同步失败', content: String((e && e.errMsg) || e || '未知错误'), showCancel: false });
    });
  },

  // 从云端恢复。旧版只提示「会覆盖本机」但没有任何兜底，
  // 本机刚做的新图还没上传就误点恢复 → 直接永久丢失。
  // 现在覆盖前会自动把本机历史存成本机备份，恢复后可一键回滚。
  restoreFromCloud() {
    const cur = storage.getHistory().length;
    wx.showModal({
      title: '从云端恢复',
      content: '将用云端备份覆盖本机历史（换新设备 / 清缓存后使用）。\n\n'
        + '本机现有的 ' + cur + ' 张会先自动备份在本机，万一恢复错了可以点「回滚」还原。确定继续？',
      success: (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '正在从云端恢复…', mask: true });
        storage.pullFromCloud().then(pr => {
          wx.hideLoading();
          if (pr.ok) {
            const lines = [pr.reason];
            if (pr.backedUp) lines.push('恢复前的 ' + pr.backedUp + ' 张已存为本机备份，可在页面下方点「回滚」还原。');
            wx.showModal({ title: '恢复完成', content: lines.join('\n'), showCancel: false });
            this.load();
          } else {
            wx.showModal({
              title: '恢复失败',
              content: (pr.reason || '') + (pr.detail ? '\n' + pr.detail : ''),
              showCancel: false
            });
          }
        }, (e) => {
          wx.hideLoading();
          console.error('[restoreFromCloud] 恢复异常', e);
          wx.showModal({ title: '恢复失败', content: String((e && e.errMsg) || e || '未知错误'), showCancel: false });
        });
      }
    });
  },

  // 回滚到本机备份：与当前内容互换，所以点错了还能再切回来
  rollbackBackup() {
    const b = this.data.backup;
    wx.showModal({
      title: '回滚到本机备份',
      content: '将用备份的 ' + (b ? b.count : 0) + ' 张替换当前历史。当前内容会存为备份，可以再回滚回来。确定？',
      success: (r) => {
        if (!r.confirm) return;
        const res = storage.restoreBackup();
        if (res.ok) { wx.showToast({ title: '已回滚 ' + res.count + ' 张' }); this.load(); }
        else wx.showModal({ title: '回滚失败', content: res.reason, showCancel: false });
      }
    });
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
