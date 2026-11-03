// 统一账号体系：泽曦工作台（yj）为主账号库，向其他业务系统开通「影子账号」
//
// 原理：6 套系统里 yj/quan(zexi-api, bcrypt) + wms(FastAPI, passlib bcrypt) + zc(asset, bcryptjs)
// 全部使用 bcrypt，密码哈希可直接跨系统复制 —— 老师用同一手机号+密码登录所有已开通系统。
//
// 数据流（全部以 yj 为准，单向同步）：
//   超管在账号管理页勾选系统+角色 → PUT /admin/users/:id/access → 这里 provision
//   重置密码 / 本人改密码 → syncPassword（广播哈希到所有已开通系统）
//   停用 / 启用 → setActive
//   删除 → 各系统停用影子账号并清空开通记录（不物理删除，遵守数据红线）
//
// 失败策略：任何同步失败只记日志，不阻断主流程（登录/改密始终可用）。

import fs from 'node:fs';
import pg from 'pg';
import { getPool } from './db.js';
import { genId } from './util.js';

// ---------- 可选系统清单（前端弹窗与后端校验共用） ----------
export const SYNC_SYSTEMS = {
  quan: {
    name: '券类核销系统',
    roles: [['teacher', '教师'], ['admin', '管理员'], ['superadmin', '超级管理员']],
  },
  wms: {
    name: '仓库管理系统',
    roles: [['operator', '操作员'], ['admin', '管理员']],
  },
  zc: {
    name: '固定资产管理',
    roles: [['teacher', '教师'], ['finance', '财务'], ['head', '负责人'], ['principal', '校长'], ['admin', '管理员'], ['superadmin', '超级管理员']],
  },
};

// 新开通系统时的默认角色（按 yj 工作台角色映射，超管可再改）
export const DEFAULT_ROLE_MAP = {
  superadmin: { quan: 'superadmin', wms: 'admin', zc: 'superadmin' },
  principal:  { quan: 'admin', wms: 'admin', zc: 'principal' },
  finance:    { quan: 'teacher', wms: 'operator', zc: 'finance' },
  teacher:    { quan: 'teacher', wms: 'operator', zc: 'teacher' },
};

// ---------- zc（固定资产，SQLite 独立容器）HTTP 内部接口配置 ----------
// 环境变量 ZC_SYNC_URL / ZC_SYNC_KEY，或容器内配置文件（默认 /app/config/zc-sync.json，不进代码库）
let zcCfg = null;
let zcResolveTried = false;
function resolveZcConfig() {
  if (zcResolveTried) return zcCfg;
  zcResolveTried = true;
  const env = process.env;
  const cfg = {
    baseUrl: (env.ZC_SYNC_URL || '').replace(/\/+$/, ''),
    key: env.ZC_SYNC_KEY || '',
  };
  if (!cfg.baseUrl || !cfg.key) {
    const file = env.ZC_SYNC_CONFIG || '/app/config/zc-sync.json';
    try {
      const f = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!cfg.baseUrl) cfg.baseUrl = (f.baseUrl || '').replace(/\/+$/, '');
      if (!cfg.key) cfg.key = f.key || '';
    } catch { /* 未配置 */ }
  }
  zcCfg = cfg.baseUrl && cfg.key ? cfg : null;
  return zcCfg;
}

// ---------- wms（仓库，独立 PostgreSQL）连接 ----------
// 与 wmssync.js 相同的配置来源（wms-sync.json / WMS_PG* 环境变量），避免重复配置
let wmsPool = null;
let wmsCfg = null;
let wmsResolveTried = false;
function resolveWmsConfig() {
  if (wmsResolveTried) return wmsCfg;
  wmsResolveTried = true;
  const env = process.env;
  const cfg = {
    host: env.WMS_PGHOST || '',
    port: parseInt(env.WMS_PGPORT || '5432', 10),
    user: env.WMS_PGUSER || '',
    password: env.WMS_PGPASSWORD || '',
    database: env.WMS_PGDATABASE || '',
  };
  if (!cfg.host || !cfg.password) {
    const file = env.WMS_SYNC_CONFIG || '/app/config/wms-sync.json';
    try {
      const f = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!cfg.host) cfg.host = f.host || '';
      if (!cfg.user) cfg.user = f.user || '';
      if (!cfg.password) cfg.password = f.password || '';
      if (!cfg.database) cfg.database = f.database || '';
    } catch { /* 未配置 */ }
  }
  if (!cfg.host || !cfg.password) { wmsCfg = null; return null; }
  if (!cfg.user) cfg.user = 'zexi_wms';
  if (!cfg.database) cfg.database = 'zexi_wms';
  wmsCfg = cfg;
  return wmsCfg;
}
function getWmsPool() {
  const cfg = resolveWmsConfig();
  if (!cfg) throw new Error('wms 数据库未配置');
  if (!wmsPool) {
    wmsPool = new pg.Pool({ ...cfg, max: 5, connectionTimeoutMillis: 5000 });
    wmsPool.on('error', (err) => console.error('wms acct pool error:', err.message));
  }
  return wmsPool;
}

// ---------- 确保 yj users 表有所需列（幂等，首次调用自动补） ----------
let colsReady = false;
export async function ensureCols() {
  if (colsReady) return;
  await getPool('yj').query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS system_access text[] NOT NULL DEFAULT '{}';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS system_roles jsonb NOT NULL DEFAULT '{}'::jsonb;`);
  colsReady = true;
}

/** 读用户（含开通信息与密码哈希，provision 用） */
export async function getUserAccess(id) {
  await ensureCols();
  const r = await getPool('yj').query(
    'SELECT id, phone, name, role, active, password_hash, system_access, system_roles FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// ---------- 各系统 provision 原语 ----------
async function provisionQuan(user, role, active) {
  // users 表：手机号唯一，存在即更新（接管老账号：姓名/哈希/状态以工作台为准）
  const q = await getPool('quan').query('SELECT id FROM users WHERE phone = $1', [user.phone]);
  let quanId = q.rows[0]?.id;
  if (quanId) {
    await getPool('quan').query(
      'UPDATE users SET password_hash = $1, name = $2, active = $3 WHERE id = $4',
      [user.password_hash, user.name, active, quanId]);
  } else {
    quanId = genId();
    await getPool('quan').query(
      'INSERT INTO users (id, phone, password_hash, name, role, active) VALUES ($1,$2,$3,$4,$5,$6)',
      [quanId, user.phone, user.password_hash, user.name, 'teacher', active]);
  }
  // staff 表：quan 的业务角色在这里
  await getPool('quan').query(
    `INSERT INTO staff (owner_id, phone, name, role, active, created_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (owner_id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active,
       name = EXCLUDED.name, phone = EXCLUDED.phone`,
    [quanId, user.phone, user.name, role, active]);
}

async function provisionWms(user, role, active) {
  await getWmsPool().query(
    `INSERT INTO users (username, password_hash, display_name, role, is_active)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       display_name = EXCLUDED.display_name, role = EXCLUDED.role, is_active = EXCLUDED.is_active`,
    [user.phone, user.password_hash, user.name, role, active]);
}

async function provisionZc(user, role, active) {
  const cfg = resolveZcConfig();
  if (!cfg) throw new Error('zc 同步未配置');
  const res = await fetch(cfg.baseUrl + '/api/internal/account-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({ action: 'upsert', phone: user.phone, name: user.name, password_hash: user.password_hash, role, active }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('zc 接口 ' + res.status);
}

async function setActiveQuan(phone, active) {
  const q = await getPool('quan').query('SELECT id FROM users WHERE phone = $1', [phone]);
  if (!q.rows[0]) return;
  await getPool('quan').query('UPDATE users SET active = $1 WHERE id = $2', [active, q.rows[0].id]);
  await getPool('quan').query('UPDATE staff SET active = $1 WHERE owner_id = $2', [active, q.rows[0].id]);
}
async function setActiveWms(phone, active) {
  await getWmsPool().query('UPDATE users SET is_active = $1 WHERE username = $2', [active, phone]);
}
async function setActiveZc(phone, active) {
  const cfg = resolveZcConfig();
  if (!cfg) throw new Error('zc 同步未配置');
  const res = await fetch(cfg.baseUrl + '/api/internal/account-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
    body: JSON.stringify({ action: 'set-active', phone, active }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('zc 接口 ' + res.status);
}

const PROVISIONERS = { quan: provisionQuan, wms: provisionWms, zc: provisionZc };
const ACTIVE_SETTERS = { quan: setActiveQuan, wms: setActiveWms, zc: setActiveZc };

function logSyncErr(what, system, err) {
  console.error(`[account-sync] ${what} (${system}) 失败: ${err.message}`);
}

// ---------- 对外动作（全部 best-effort：单个系统失败不拖垮整体） ----------

/** 向指定系统开通影子账号（幂等，可重复调用） */
export async function provisionToSystem(user, system, role) {
  await ensureCols();
  try { await PROVISIONERS[system](user, role, user.active !== false); }
  catch (e) { logSyncErr('provision', system, e); throw e; }
}

/** 密码哈希变更 → 广播到所有已开通系统 */
export async function syncPasswordHash(user, passwordHash) {
  await ensureCols();
  const access = user.system_access || [];
  const full = { ...user, password_hash: passwordHash };
  for (const s of access) {
    if (!PROVISIONERS[s]) continue;
    const role = (user.system_roles || {})[s] || DEFAULT_ROLE_MAP[user.role]?.[s] || SYNC_SYSTEMS[s].roles[0][0];
    try { await PROVISIONERS[s](full, role, user.active !== false); }
    catch (e) { logSyncErr('sync-password', s, e); }
  }
}

/** 停用/启用 → 所有已开通系统跟随 */
export async function syncActive(user, active) {
  await ensureCols();
  for (const s of user.system_access || []) {
    if (!ACTIVE_SETTERS[s]) continue;
    try { await ACTIVE_SETTERS[s](user.phone, active); }
    catch (e) { logSyncErr(active ? 'enable' : 'disable', s, e); }
  }
}

/** 删除工作台账号 → 各系统停用影子账号（不物理删除，保留业务数据归属） */
export async function syncRemoved(user) {
  await syncActive(user, false);
}
