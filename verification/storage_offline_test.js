// verification/storage_offline_test.js
// utils/storage.js 的离线用例：用 wx 桩件在 Node 里跑，不需要开发者工具。
// 覆盖：新增/更新/删除、草稿读写、1MB 单键上限保护、
//       云端恢复前自动备份本机、备份失败则拒绝覆盖、回滚（互换式）
// 用法：node verification/storage_offline_test.js
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ---------- wx 桩件 ----------
const store = {};
const unlinked = [];
let forceFull = false;
let forceKey = null;

global.wx = {
  getStorageSync: (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : ''),
  setStorageSync: (k, v) => {
    if (forceFull && k === (forceKey || 'history')) throw new Error('exceed storage max size');
    store[k] = JSON.parse(JSON.stringify(v));
  },
  removeStorageSync: (k) => { delete store[k]; },
  getFileSystemManager: () => ({ unlink: (o) => { unlinked.push(o.filePath); o.success && o.success(); } }),
  env: { USER_DATA_PATH: '/tmp' },
  cloud: {
    init: () => {},
    callFunction: () => Promise.resolve({
      result: {
        ok: true,
        updatedAt: 1700000000000,
        projects: [{ id: 'c1', name: '云端1', w: 3, h: 3, grid: [1, 1, 1, 0, 0, 0, 2, 2, 2], colors: [] }]
      }
    })
  }
};

const storage = require(path.join(ROOT, 'utils/storage.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};
const rec1 = { name: 'A', w: 3, h: 3, grid: [1, 1, 1, 0, 0, 0, 2, 2, 2], colors: [{ id: 1, code: 'C1', name: '红', hex: '#f00', rgb: [255, 0, 0] }] };

console.log('\n[1] 新增 / 更新 / 删除');
const a = storage.addProject(rec1);
ok('addProject 返回带 id 的记录', !!(a && a.id));
const upd = storage.updateProject(a.id, { name: 'A2' });
ok('updateProject 改名成功', upd && upd.name === 'A2');
ok('更新是原地生效，不新增副本', storage.getHistory().length === 1);
ok('updateProject 对不存在的 id 返回 null', storage.updateProject('nope', {}) === null);

const b = storage.addProject({ ...rec1, name: 'B' });
ok('removeProject 返回 true（不再因未引入 thumb 而抛错）', storage.removeProject(b.id) === true);
ok('删除后只剩 1 条', storage.getHistory().length === 1);
ok('删除时顺带清理缩略图文件', unlinked.some(p => p.indexOf(b.id) >= 0));

console.log('\n[2] 草稿');
ok('初始无草稿', storage.getDraft() === null);
ok('saveDraft 成功', storage.saveDraft({ w: 3, h: 3, grid: [1, 1, 1], colorMeta: {}, recId: a.id }).ok === true);
const d = storage.getDraft();
ok('getDraft 能读回 grid 与来源 recId', !!d && d.grid.length === 3 && d.recId === a.id);
ok('草稿带 savedAt 时间戳', typeof d.savedAt === 'number');
storage.clearDraft();
ok('clearDraft 后读不到', storage.getDraft() === null);
storage.saveDraft({ grid: [] });
ok('grid 为空的草稿视为无效', storage.getDraft() === null);
storage.clearDraft();

console.log('\n[3] 1MB 单键上限保护');
const before = storage.getHistory().length;
forceFull = true;
ok('写入超限时 addProject 返回 null（不静默丢数据）', storage.addProject({ name: 'big', w: 200, h: 200, grid: new Array(40000).fill(1), colors: [] }) === null);
forceFull = false;
ok('超限失败后原历史未被破坏', storage.getHistory().length === before);

console.log('\n[4] 云端恢复前自动备份 + 回滚');
store.history = [];
storage.addProject({ ...rec1, name: '本机1' });
storage.addProject({ ...rec1, name: '本机2' });
ok('本机现有 2 张，且此时无备份', storage.getHistory().length === 2 && storage.getBackupInfo() === null);

storage.pullFromCloud().then(pr => {
  ok('恢复成功', pr.ok === true, JSON.stringify(pr));
  ok('返回「已备份本机张数」', pr.backedUp === 2, 'backedUp=' + pr.backedUp);
  ok('本机已被云端数据覆盖', storage.getHistory().length === 1);
  ok('覆盖前的内容确实进了本机备份', storage.getBackupInfo().count === 2);

  const rb = storage.restoreBackup();
  ok('回滚成功', rb.ok === true && rb.count === 2);
  ok('回滚后恢复为原来的 2 张', storage.getHistory().length === 2);
  ok('回滚是互换式：可再切回去', storage.getBackupInfo().count === 1);

  console.log('\n[5] 备份写入失败时拒绝覆盖（宁可不同步，也不丢数据）');
  forceFull = true;
  forceKey = 'history_bak';
  storage.pullFromCloud().then(pr2 => {
    forceFull = false; forceKey = null;
    ok('恢复被中止并返回失败', pr2.ok === false, JSON.stringify(pr2));
    ok('失败原因说明是备份失败', /备份/.test(pr2.reason || ''), pr2.reason);
    ok('本机数据未被覆盖（仍 2 张）', storage.getHistory().length === 2);
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail + '\n');
    process.exit(fail ? 1 : 0);
  });
}).catch(e => { console.log('  FAIL  恢复流程抛异常: ' + e.stack); process.exit(1); });
