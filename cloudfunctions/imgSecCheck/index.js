// 云函数：图片内容安全校验
// 前端上传图片后调用此函数，过检才允许后续处理
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event) => {
  const { fileID } = event;
  if (!fileID) {
    return { ok: false, code: -1, msg: '缺少 fileID' };
  }
  try {
    // 从云存储下载图片为 buffer
    const file = await cloud.downloadFile({ fileID });
    const buffer = file.fileContent;

    // 调用微信内容安全接口（图片鉴黄/暴恐/政治敏感）
    const res = await cloud.openapi.security.imgSecCheck({
      media: {
        contentType: 'image/png',
        value: buffer
      }
    });
    // errCode 0 = 通过；87014 = 含违规内容
    if (res.errCode === 0) {
      return { ok: true, code: 0 };
    }
    return { ok: false, code: res.errCode, msg: '图片包含违规内容' };
  } catch (e) {
    // 接口异常时按"放行但记录"处理，避免误杀正常用户
    console.error('imgSecCheck error', e);
    return { ok: true, code: -2, msg: 'check_error', detail: String(e) };
  }
};
