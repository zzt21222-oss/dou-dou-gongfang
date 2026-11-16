// 生成 3 张真实二维码 PNG（不同版本），供用户直观查看"算法检测不出的图"
'use strict';
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

async function main() {
  const dir = path.join(__dirname);
  const cases = [
    ['qr_v1_21mod.png', 'hello', 'M'],
    ['qr_v3_29mod.png', 'https://example.com/bead-tool', 'M'],
    ['qr_high_49mod.png', '拼豆图纸小程序豆豆工坊A二维码几何对齐测试_' + 'A'.repeat(40), 'Q'],
  ];
  for (const [file, text, ec] of cases) {
    // 生成 PNG（含默认静区），放大到 ~600px 便于查看
    const buf = await QRCode.toBuffer(text, { errorCorrectionLevel: ec, margin: 4, width: 640, type: 'png' });
    fs.writeFileSync(path.join(dir, file), buf);
    // 读回矩阵打印真实模块数
    const qr = QRCode.create(text, { errorCorrectionLevel: ec });
    console.log(file + ' -> 真实模块数=' + qr.modules.size + ', ' + buf.length + ' bytes');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
