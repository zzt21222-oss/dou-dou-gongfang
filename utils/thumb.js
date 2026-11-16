// utils/thumb.js
// 历史图纸缩略图：用离屏 canvas 按记录数据画小图（复用 render.drawGrid，
// 样式与编辑器像素模式完全一致），画完写入 USER_DATA_PATH 永久文件。
// 一张图只生成一次；之后历史页直接读文件，秒出。
const render = require('./render.js');
const palette = require('./palette.js');

const MAX = 120; // 缩略图最长边（px）

function thumbPath(id) {
  return wx.env.USER_DATA_PATH + '/thumb_' + id + '.png';
}

// rec: 历史记录 { id, w, h, grid, colors } → Promise<永久文件路径>
// 兼容老记录：colors 可能缺 rgb（preview 旧版只存 hex），用 hexToRgb 兜底。
function genThumb(rec) {
  return new Promise((resolve, reject) => {
    try {
      if (!rec || !rec.grid || !rec.w || !rec.h) { reject(new Error('记录不完整')); return; }
      const cell = Math.max(2, Math.floor(Math.min(MAX / rec.w, MAX / rec.h)));
      const W = cell * rec.w, H = cell * rec.h;
      const canvas = wx.createOffscreenCanvas({ type: '2d', width: W, height: H });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      const colorMeta = {};
      (rec.colors || []).forEach(c => {
        colorMeta[c.id] = {
          rgb: c.rgb || (c.hex ? palette.hexToRgb(c.hex) : [255, 255, 255]),
          code: c.code, name: c.name, hex: c.hex
        };
      });
      render.drawGrid(ctx, {
        grid: rec.grid, w: rec.w, h: rec.h, cell, offX: 0, offY: 0,
        colorMeta, mode: 'pixel', symbolMap: null
      });
      const base64 = canvas.toDataURL('image/png').replace(/^data:image\/\w+;base64,/, '');
      const fp = thumbPath(rec.id);
      wx.getFileSystemManager().writeFile({
        filePath: fp,
        data: base64,
        encoding: 'base64',
        success: () => resolve(fp),
        fail: reject
      });
    } catch (e) { reject(e); }
  });
}

// 删除缩略图文件（删除记录时清理，失败静默——文件本就可能不存在）
function removeThumb(id) {
  try {
    wx.getFileSystemManager().unlink({ filePath: thumbPath(id), fail: () => {} });
  } catch (e) { /* 静默 */ }
}

module.exports = { genThumb, removeThumb, thumbPath };
