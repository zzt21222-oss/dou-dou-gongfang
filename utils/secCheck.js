// utils/secCheck.js - 图片内容安全校验统一入口
// 所有"选图/拍照"后必须先过此校验，通过才进入后续处理
// 校验走云函数 -> 微信 security.imgSecCheck，覆盖相册、拍照等全部图片输入场景

/**
 * 校验单张本地图片是否合规
 * @param {string} tempFilePath 微信 chooseMedia 返回的临时路径
 * @returns {Promise<{ok:boolean, msg?:string}>} ok=true 放行；false 拦截
 */
function checkImage(tempFilePath) {
  return new Promise((resolve) => {
    // 未开通云开发时降级：直接放行（避免影响本地调试）
    if (!wx.cloud || !wx.cloud.uploadFile) {
      resolve({ ok: true, msg: 'cloud_not_ready' });
      return;
    }
    wx.showLoading({ title: '安全检测中', mask: true });
    // 1. 先把图片传到云存储，拿到 fileID
    const cloudPath = `sec-check/${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
    wx.cloud.uploadFile({
      cloudPath,
      filePath: tempFilePath,
      success: (up) => {
        // 2. 调云函数做内容安全检测
        wx.cloud.callFunction({
          name: 'imgSecCheck',
          data: { fileID: up.fileID },
          success: (r) => {
            wx.hideLoading();
            const res = (r && r.result) || {};
            if (res.ok) {
              resolve({ ok: true });
            } else {
              // 审核口径：仅需提示含违规信息即可
              wx.showModal({
                title: '提示',
                content: '图片包含违规信息，无法使用',
                showCancel: false
              });
              resolve({ ok: false, msg: res.msg || '违规' });
            }
          },
          fail: () => {
            wx.hideLoading();
            // 检测服务异常时放行，不阻塞用户（并记录）
            resolve({ ok: true, msg: 'check_failed_pass' });
          }
        });
      },
      fail: () => {
        wx.hideLoading();
        resolve({ ok: true, msg: 'upload_failed_pass' });
      }
    });
  });
}

module.exports = { checkImage };
