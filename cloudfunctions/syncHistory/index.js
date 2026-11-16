// 云函数：历史跨设备同步
// 模型：bead_docs 集合里每个用户至多一条记录，存整份图纸数组。
// action:
//   upload: 把本地历史整份覆盖到该用户的云端备份（本地为权威）
//   pull:   拉回该用户自己的云端备份
//
// 为什么用 ownerOpenId 而不是 _openid（2026-09-19 审查 F16）：
//   微信云开发的 _openid 由**客户端 SDK 自动注入**，管理端（控制台 / 云函数）
//   写入的记录不会带这个字段。旧版首次 add 只写 { projects, updatedAt }，
//   之后却按 { _openid: OPENID } 查询 —— 结果是：上传返回成功、拉取永远为空、
//   再上传又新增一条，越堆越多。
//   现在统一用服务端 getWXContext() 拿到的 OPENID 写进固定字段 ownerOpenId，
//   读写都按它查；客户端传入的任何身份字段一律忽略，不信任客户端身份。
//
// 注意：若云端已有按 _openid 存的旧记录，它们不会被新条件查到（等于不可见）。
//       需要的话请手动给这些记录补上 ownerOpenId，不要猜测归属批量分配。
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COLLECTION = 'bead_docs';
const MAX_PROJECTS = 200;
const MAX_BYTES = 900 * 1024;

function bytesOf(v) {
  try { return JSON.stringify(v).length; } catch (e) { return Infinity; }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, code: -1, msg: '无法获取用户身份' };
  }
  const action = (event && event.action) || '';
  try {
    const db = cloud.database();
    const coll = db.collection(COLLECTION);
    // 唯一的身份条件，且只认服务端身份
    const mine = { ownerOpenId: OPENID };

    if (action === 'upload') {
      const projects = (event && event.projects) || [];
      if (!Array.isArray(projects)) {
        return { ok: false, code: -4, msg: 'projects 必须是数组' };
      }
      if (projects.length > MAX_PROJECTS) {
        return { ok: false, code: -5, msg: '图纸数量超出上限（' + MAX_PROJECTS + '）' };
      }
      if (bytesOf(projects) > MAX_BYTES) {
        return { ok: false, code: -6, msg: '备份数据过大，无法同步' };
      }
      const updatedAt = (event && event.updatedAt) || Date.now();
      const payload = {
        ownerOpenId: OPENID,
        projects: projects,
        updatedAt: updatedAt,
        count: projects.length
      };
      const existing = await coll.where(mine).limit(1).get();
      if (existing.data.length) {
        await coll.doc(existing.data[0]._id).update({ data: payload });
      } else {
        await coll.add({ data: payload });
      }
      return { ok: true, msg: '同步成功', count: projects.length, updatedAt: updatedAt };
    }

    if (action === 'pull') {
      const existing = await coll.where(mine).limit(1).get();
      if (!existing.data.length) {
        return { ok: true, projects: [], msg: '云端暂无备份' };
      }
      const doc = existing.data[0];
      const projects = doc.projects || [];
      return {
        ok: true,
        projects: projects,
        updatedAt: doc.updatedAt || 0,
        count: projects.length
      };
    }

    return { ok: false, code: -2, msg: '未知 action：' + action };
  } catch (e) {
    console.error('syncHistory error', e);
    return { ok: false, code: -3, msg: '云函数异常', detail: String(e) };
  }
};
