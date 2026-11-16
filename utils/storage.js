// utils/storage.js
// 本地历史记录（收藏）管理。数据存于 wx.storage，包含可再次编辑所需的图纸数据。
//
// 容量约束（微信官方）：单个 key 上限 1MB，同一小程序全部缓存上限 10MB。
// 图纸的 grid 是 w*h 个整数，大图（如 100×100）单条就可能几十 KB，
// 所以所有写入都走 writeList/safeSet 做上限判断，失败时返回错误而不是静默丢数据。

const thumb = require('./thumb.js');
const migrate = require('./migrate.js');

const KEY = 'history';        // 历史图纸列表
const BAK_KEY = 'history_bak'; // 云端恢复前的本机自动备份（防误覆盖）
const META_KEY = 'cloud_meta'; // 云同步状态（最近同步时间等）
const DRAFT_KEY = 'draft';     // 编辑器草稿（未保存到历史前的自动存档）

const MAX_KEY_BYTES = 1024 * 1024;  // 微信单 key 上限 1MB，留 5% 余量
const DRAFT_MAX_BYTES = 900 * 1024;

// UTF-8 字节数估算：ASCII 1 字节、中文 3 字节、代理对 4 字节。
// 用字符数当字节数会低估中文文案，这里按真实编码算，避免踩到 1MB 上限。
function utf8Bytes(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// 安全写入：把「写失败」变成返回值，不让调用方被异常打断
function safeSet(key, data) {
  try {
    wx.setStorageSync(key, data);
    return { ok: true };
  } catch (e) {
    console.error('[storage] 写入失败 key=' + key, e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 历史列表写入：先算字节数，超限直接拒绝并给出可执行的提示
function writeList(list) {
  let size = 0;
  try { size = utf8Bytes(JSON.stringify(list)); }
  catch (e) { return { ok: false, error: '数据无法序列化' }; }
  if (size > MAX_KEY_BYTES * 0.95) {
    return {
      ok: false,
      error: '本机历史已达存储上限（' + Math.round(size / 1024) + 'KB / 上限 1024KB）',
      full: true
    };
  }
  return safeSet(KEY, list);
}

function getHistory() {
  // 读的时候顺手把旧版写坏的色号修正掉（只改颜色元数据，不动 grid）。
  // 不在这里回写：读就写会产生难以追踪的隐式副作用；等用户下一次保存时自然落库。
  const list = migrate.migrateList(wx.getStorageSync(KEY) || []);
  // 再兜一层网格形态（老数据里的 Int32Array 可能已被 JSON 化成普通对象）
  let any = false;
  const out = list.map(function (r) { const n = normProject(r); if (n !== r) any = true; return n; });
  return any ? out : list;
}

function genId() {
  return 'p_' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

// ===== 网格形态归一化 =====
// 网格来自 bead.finalize / applyShapeMask，是 Int32Array。微信 storage 走 JSON 序列化，
// Int32Array 会被写成 {"0":1,"1":2,...} —— 既没有 length 也没有 slice：
//   · 历史记录：编辑器 loadFromData 里的 rec.grid.slice() 直接抛 TypeError
//   · 编辑器草稿：getDraft 的 !d.grid.length 判定为真 → 草稿被静默丢弃
// 所以写入前统一转成普通数组，读取时再兜一层（兼容已经被写坏的老数据）。
function toGridArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;                 // 已经是普通数组：原样返回，不做拷贝
  const n = v.length;
  if (typeof n === 'number' && n >= 0) return Array.prototype.slice.call(v);  // TypedArray/类数组
  const keys = Object.keys(v);
  if (!keys.length) return [];
  let max = -1;
  for (let i = 0; i < keys.length; i++) {
    const k = Number(keys[i]);
    if (Number.isInteger(k) && k >= 0 && k > max) max = k;
  }
  if (max < 0) return [];
  const out = new Array(max + 1);
  for (let i = 0; i < keys.length; i++) {
    const k = Number(keys[i]);
    if (Number.isInteger(k) && k >= 0) out[k] = v[keys[i]];
  }
  return out;
}

// 归一化一条记录里的 grid / fullGrid；不需要改时原样返回（不产生拷贝）。
// 只处理**存在**的字段：updateProject 的 patch 可能只带 thumb，不能凭空塞一个 grid 覆盖原数据。
function normProject(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  let out = rec;
  if (rec.grid !== undefined) {
    const g = toGridArray(rec.grid);
    if (g !== rec.grid) out = Object.assign({}, out, { grid: g });
  }
  if (rec.fullGrid !== undefined && rec.fullGrid !== null) {
    const f = toGridArray(rec.fullGrid);
    if (f !== rec.fullGrid) out = Object.assign({}, out, { fullGrid: f });
  }
  return out;
}

// project: { name, note, w, h, algorithm, colorCount, brand, lockBrand, grid, colors, boards }
// 返回写入后的记录；写入失败返回 null（调用方需提示用户，不要当成成功）
function addProject(project) {
  const list = getHistory();
  const record = Object.assign({
    id: genId(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  }, normProject(project));
  list.unshift(record);
  const w = writeList(list);
  if (!w.ok) return null;
  return record;
}

function updateProject(id, patch) {
  const list = getHistory();
  const idx = list.findIndex(p => p.id === id);
  if (idx < 0) return null;
  list[idx] = Object.assign({}, list[idx], normProject(patch), { updatedAt: Date.now() });
  const w = writeList(list);
  if (!w.ok) return null;
  return list[idx];
}

function removeProject(id) {
  const removed = getProject(id);
  const list = getHistory().filter(p => p.id !== id);
  const w = writeList(list);
  if (!w.ok) return false;
  if (removed) thumb.removeThumb(id); // 顺手清掉缩略图文件，不留垃圾
  return true;
}

function getProject(id) {
  return getHistory().find(p => p.id === id) || null;
}

// ===== 编辑器草稿（防进程回收丢进度）=====
// 只在用户真的改动过（editor._dirty）时才写，所以「打开看看就退出」不会产生草稿。
function saveDraft(draft) {
  const payload = normProject(Object.assign({}, draft, { savedAt: Date.now() }));
  let size = 0;
  try { size = utf8Bytes(JSON.stringify(payload)); }
  catch (e) { return { ok: false, reason: '数据无法序列化' }; }
  if (size > DRAFT_MAX_BYTES) return { ok: false, reason: '图纸过大，暂不自动存档' };
  const r = safeSet(DRAFT_KEY, payload);
  return r.ok ? { ok: true, savedAt: payload.savedAt } : { ok: false, reason: r.error };
}

function getDraft() {
  const d = wx.getStorageSync(DRAFT_KEY);
  if (!d) return null;
  // 草稿同样可能是旧版写坏的色号，一并迁移
  const rec = normProject(migrate.migrateRecord(d).rec);
  // 归一化之后再判断：否则被 JSON 化成对象的 grid 没有 length，会被误判成"无草稿"而静默丢弃
  if (!rec || !rec.grid || !rec.grid.length) return null;
  return rec;
}

function clearDraft() {
  try { wx.removeStorageSync(DRAFT_KEY); } catch (e) { /* 忽略 */ }
}

// ===== 云同步（本地兜底 + 云端备份）=====
// 依赖：微信开发者工具已开通「云开发」，app.js 已 wx.cloud.init()，且已部署云函数 syncHistory。
// 模型：云端用「每个用户一条整份备份」（bead_docs 集合，按 openid 隔离）。
//       上传 = 用本机整份覆盖云端；下拉 = 用云端整份覆盖本机（覆盖前会自动备份本机，可回滚）。
let cloudInited = false;
function initCloud() {
  if (cloudInited) return true;
  if (typeof wx.cloud === 'undefined' || !wx.cloud) return false;
  try { wx.cloud.init({ traceUser: true }); cloudInited = true; return true; }
  catch (e) { return false; }
}
function isCloudEnabled() { return initCloud(); }

const CLOUD_FN = 'syncHistory';

function getCloudMeta() { return wx.getStorageSync(META_KEY) || null; }

function setCloudMeta(patch) {
  const m = Object.assign({}, getCloudMeta() || {}, patch, { at: Date.now() });
  safeSet(META_KEY, m);
  return m;
}

// 上推：把本地历史整份备份到云端（覆盖自己那条云端记录）
function syncToCloud() {
  return new Promise((resolve) => {
    if (!initCloud()) { resolve({ ok: false, reason: '未开通云开发，图纸已安全保存在本机', local: true }); return; }
    const projects = getHistory();
    wx.cloud.callFunction({
      name: CLOUD_FN,
      data: { action: 'upload', projects, updatedAt: Date.now() }
    }).then((r) => {
      const res = r && r.result ? r.result : {};
      if (res.ok) {
        setCloudMeta({ lastUploadAt: Date.now(), lastCount: projects.length });
        resolve({ ok: true, reason: res.msg || '已同步到云端', count: res.count, detail: '' });
      } else {
        resolve({ ok: false, reason: res.msg || '云端同步失败', detail: res.detail || '', count: res.count });
      }
    }).catch((e) => {
      resolve({ ok: false, reason: '同步失败，请确认已部署 syncHistory 云函数并创建 bead_docs 集合', detail: String(e) });
    });
  });
}

// 下拉：用云端备份覆盖本地历史。
// 关键防护：覆盖前必须先把本机现状备份到 BAK_KEY；备份失败就拒绝覆盖（宁可不同步，也不丢数据）。
function pullFromCloud() {
  return new Promise((resolve) => {
    if (!initCloud()) { resolve({ ok: false, reason: '未开通云开发，无法从云端恢复' }); return; }
    wx.cloud.callFunction({
      name: CLOUD_FN,
      data: { action: 'pull' }
    }).then((r) => {
      const res = r && r.result ? r.result : {};
      if (!res.ok) { resolve({ ok: false, reason: res.msg || '恢复失败', detail: res.detail || '' }); return; }
      const projects = res.projects || [];
      if (!projects.length) { resolve({ ok: false, reason: '云端还没有备份，无内容可恢复' }); return; }

      const local = getHistory();
      if (local.length) {
        const b = safeSet(BAK_KEY, { at: Date.now(), count: local.length, projects: local });
        if (!b.ok) {
          resolve({
            ok: false,
            reason: '本机空间不足，无法在覆盖前备份当前 ' + local.length + ' 张图纸，已中止恢复',
            detail: '请先删除一些本机图纸或清理小程序缓存后重试。' + (b.error || '')
          });
          return;
        }
      }

      const w = writeList(projects);
      if (!w.ok) { resolve({ ok: false, reason: '恢复写入失败：' + (w.error || ''), detail: '' }); return; }

      setCloudMeta({ lastPullAt: Date.now(), cloudUpdatedAt: res.updatedAt || 0, cloudCount: projects.length });
      resolve({
        ok: true,
        count: projects.length,
        backedUp: local.length,
        cloudUpdatedAt: res.updatedAt || 0,
        reason: '已从云端恢复 ' + projects.length + ' 张'
      });
    }).catch((e) => {
      resolve({ ok: false, reason: '恢复失败，请确认已部署 syncHistory 云函数', detail: String(e) });
    });
  });
}

// 本机自动备份信息（用于展示「可回滚」入口）
function getBackupInfo() {
  const b = wx.getStorageSync(BAK_KEY);
  if (!b || !b.projects || !b.projects.length) return null;
  return { at: b.at, count: b.count || b.projects.length };
}

// 安全删除：失败也不抛，交给调用方按返回值决定
function safeRemove(key) {
  try { wx.removeStorageSync(key); return true; }
  catch (e) { console.warn('[storage] 删除失败 key=' + key, e); return false; }
}

// 回滚到本机备份：与当前内容做「互换」，所以可以来回切，不怕点错。
//
// 这是跨两个 key 的搬迁，必须按"事务"来做（审查 F13）。旧版忽略 safeSet 的
// 返回值，两个分支都会让用户至少丢掉一个版本，界面却还报成功：
//   ① 备份写失败、历史写成功 → 返回 ok:true，但当前作品已被旧备份覆盖，永久丢失；
//   ② 备份写成功、历史写失败 → 返回 ok:false，但原备份已被当前内容覆盖，回不去了。
// 现在：两份数据先进临时键并回读校验，任一步失败就退出，尽量不碰已有数据。
const TMP_KEY = 'history_tmp';

// 两份列表是不是**同一份内容**（不是"ID 对得上"就算同一份）。
// 回滚的每一步都要靠它判断"数据到底落在哪一侧了"。
//
// 复核报告 S2：同一件作品改过之后，历史与备份里的 id 相同、grid 却不同
// （P/grid=[1] 与 P/grid=[2] 是同一作品的前后两个版本，是正常情况，
// 不该要求用户换 ID）。旧版只比 id，于是把"两个版本"误判成"同一份数据"，
// 收尾时直接清掉临时键 —— 用户的旧版本从此不在任何 key 里。
//
// 比较口径：**按内容**比，且必须比原始存储值。不能拿 getHistory() 来比，
// 因为它在读的时候会跑迁移修复（修旧色号、归一化网格形态），
// 读出来的东西和当初存进去的已经不是一个字节，会把"同一份"误判成"不同"。
const VOLATILE_FIELDS = ['at', 'savedAt', 'updatedAt', 'thumbAt', 'syncedAt'];

// 规范化序列化：对象按键名排序，保证"字段顺序不同但内容相同"不误判为不同；
// 时间戳类字段不参与比较（它们只表示"什么时候存的"，不代表内容）。
function canonValue(v) {
  if (Array.isArray(v)) {
    return '[' + v.map(canonValue).join(',') + ']';
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter(function (k) { return VOLATILE_FIELDS.indexOf(k) < 0; }).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + canonValue(v[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

function sameContent(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (canonValue(a[i]) !== canonValue(b[i])) return false;
  }
  return true;
}

// 原始历史（不经迁移/归一化）。回滚里的"两侧比对"必须用它。
function rawHistory() {
  const v = wx.getStorageSync(KEY);
  return Array.isArray(v) ? v : [];
}

// 未完成回滚的收尾。回滚要跨 history / history_bak 两个 key 搬迁，
// 中途失败就会留下"换了一半"的状态：临时键里存着唯一一份救援快照，
// 而 history_bak 可能已经被当前内容覆盖过。
// 旧版第二次点回滚时**无条件重写临时键**，那一份救援快照就被抹掉了，
// 之后回滚还报成功 —— 用户的原始备份从此不在任何 key 里（复核 R6）。
// 这里在启动和每次回滚前先收尾：把救援快照放回备份键，确认放回去了才清临时键。
//   情况一 历史已经是救援快照 → 上次其实换成功了，只是没来得及清临时键；
//          成功路径上 history_bak 早已登记为旧内容，直接清掉临时键即可。
//   情况二 历史还不是 → 换到一半，必须把救援快照放回 history_bak。
function recoverRestore() {
  const t = wx.getStorageSync(TMP_KEY);
  if (!t) return { recovered: false };
  const bakSnap = t.bak;
  if (!bakSnap || !Array.isArray(bakSnap.projects) || !bakSnap.projects.length) {
    // 残缺的临时数据，留着也没用
    safeRemove(TMP_KEY);
    return { recovered: false, reason: '临时数据不完整，已清理' };
  }
  if (sameContent(rawHistory(), bakSnap.projects)) {
    safeRemove(TMP_KEY);
    return { recovered: true, restored: false };
  }
  const w = safeSet(BAK_KEY, bakSnap);
  if (!w.ok) {
    // 放不回备份键就**保留**临时键 —— 它是此刻唯一的一份，抹掉就真没了
    return { recovered: false, keptTmp: true, reason: w.error || '' };
  }
  safeRemove(TMP_KEY);
  return { recovered: true, restored: true };
}

function restoreBackup() {
  // 先把上一次没做完的回滚收尾，否则下面第 ① 步会把唯一的救援快照覆盖掉。
  // 收尾**必须看结果**（复核报告 S3）：如果它没能把救援快照放回备份键
  // （写入故障还在），此时唯一一份旧数据就只活在临时键里。这时若继续往下走，
  // 第 ① 步会用当前内容覆盖临时键，之后的失败分支还会把临时键删掉 ——
  // 用户的旧版本在"重试"这个动作里被彻底抹掉。所以这里必须停下来。
  const rec = recoverRestore();
  if (rec && rec.keptTmp) {
    return {
      ok: false,
      keptTmp: true,
      reason: '上一次回滚还没收尾（' + (rec.reason || '备份写入失败') +
        '）。原备份已留在本机救援区，先解决存储写入问题再重试。'
    };
  }

  const b = wx.getStorageSync(BAK_KEY);
  if (!b || !b.projects || !b.projects.length) return { ok: false, reason: '没有可回滚的本机备份' };
  const cur = getHistory();
  const stamp = Date.now();
  const curSnap = { at: stamp, count: cur.length, projects: cur };
  const bakSnap = { at: b.at || 0, count: b.count || b.projects.length, projects: b.projects };

  // 失败收尾：尽力把救援快照放回备份键；放不回去就保留临时键并如实告知，
  // 绝不"报成功 + 删临时键"把唯一一份数据带走。
  const failSafe = function (why) {
    const r1 = cur.length ? safeSet(BAK_KEY, bakSnap) : { ok: true };
    if (r1.ok) {
      safeRemove(TMP_KEY);
      return { ok: false, reason: why };
    }
    return {
      ok: false,
      keptTmp: true,
      reason: why + '。原备份已留在本机救援区，再点一次回滚会自动恢复。'
    };
  };

  // ① 只暂存**救援快照**（即将成为历史的这一份）并回读校验。
  //    另一份（当前内容）此刻还在 history 里，不必再替它存一遍 ——
  //    旧版把两份完整历史塞进同一个临时键，两份各自合法、相加却可能超过
  //    单键 1MB 上限，回滚会被安全拒绝（复核报告"容量成本"一节）。
  const t = safeSet(TMP_KEY, { at: stamp, bak: bakSnap });
  if (!t.ok) return { ok: false, reason: '回滚已取消（无法暂存数据）：' + (t.error || '') };
  const back = wx.getStorageSync(TMP_KEY);
  if (!back || !back.bak || !Array.isArray(back.bak.projects) ||
      back.bak.projects.length !== bakSnap.projects.length) {
    safeRemove(TMP_KEY);
    return { ok: false, reason: '回滚已取消（暂存校验未通过）' };
  }

  // ② 把当前内容登记为新备份；失败就原样退出，历史与备份一个字节都没动
  if (cur.length) {
    const s1 = safeSet(BAK_KEY, curSnap);
    if (!s1.ok) {
      safeRemove(TMP_KEY);
      return { ok: false, reason: '回滚已取消（备份写入失败）：' + (s1.error || '') };
    }
  }

  // ③ 用备份覆盖历史
  const w = writeList(bakSnap.projects);
  if (!w.ok) return failSafe('写入失败：' + (w.error || ''));

  // 写入成功 ≠ 内容正确：再读回来核对一遍**内容**（不只看 ID 列表 ——
  // 同 ID 不同 grid 会被 ID 比较放过，复核报告 S2）。
  // 核对不过按失败处理，让救援分支把备份放回去。
  const after = wx.getStorageSync(KEY) || [];
  if (!sameContent(after, bakSnap.projects)) {
    return failSafe('回滚后校验未通过：历史内容与备份不一致');
  }

  // ④ 确认历史与备份都写好了，才清掉临时键
  safeRemove(TMP_KEY);
  return { ok: true, count: bakSnap.projects.length };
}

module.exports = {
  getHistory, addProject, updateProject, removeProject, getProject, genId,
  isCloudEnabled, syncToCloud, pullFromCloud, getCloudMeta, getBackupInfo, restoreBackup,
  recoverRestore,
  saveDraft, getDraft, clearDraft,
  // 供页面在读取外部传入的网格时兜底（编辑器 / 预览页）
  toGridArray
};
