// 手机号+密码认证：register / login / session / change-password
// users 表：id text PK, phone UNIQUE, password_hash, name, created_at
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { getPool } from './db.js';
import { genId, isPhone, errorBody, HttpError } from './util.js';
import { ensureCols, getUserAccess, provisionToSystem, syncPasswordHash, syncActive, syncRemoved, SYNC_SYSTEMS, DEFAULT_ROLE_MAP, listWmsLocations } from './accountsync.js';

export function signToken(user, app) {
  return jwt.sign({ sub: user.id, phone: user.phone, role: user.role || 'user', app }, config.jwtSecret, {
    expiresIn: config.jwtExpires,
  });
}

/** 从请求头解析 JWT，返回 {id, phone} 或 null。app 不匹配视为未登录。 */
export function getAuthUser(req, app) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  try {
    const payload = jwt.verify(m[1], config.jwtSecret);
    if (payload.app !== app) return null;
    return { id: String(payload.sub), phone: payload.phone, role: payload.role || 'user' };
  } catch {
    return null;
  }
}

/** 要求登录，未登录抛 401 */
export function requireAuth(req, app) {
  const user = getAuthUser(req, app);
  if (!user) throw new HttpError(401, '未登录或登录已过期');
  return user;
}

async function findUserByPhone(app, phone) {
  const r = await getPool(app).query(
    'SELECT id, phone, password_hash, name, role, active FROM users WHERE phone = $1',
    [phone]
  );
  return r.rows[0] || null;
}

export function registerAuthRoutes(app, fastify) {
  const rl = { rateLimit: { max: 5, timeWindow: '1 minute' } };

  // 注册：yj 公开（员工自助注册）；quan 仅已登录 admin/superadmin 可调用（给员工建号）；
  // quan 带 role 时一步完成建号+授权（teacher 管理员可授，admin/superadmin 仅超管可授）；jz 不挂载本路由（404）。
  fastify.post(`/api/${app}/auth/register`, { config: rl }, async (req, reply) => {
    let adminFlow = false;
    let operatorRole = null;
    if (app === 'quan') {
      const operator = requireAuth(req, app);
      const sr = await getPool(app).query(
        'SELECT role FROM staff WHERE owner_id = $1 AND active = true LIMIT 1',
        [operator.id]
      );
      operatorRole = sr.rows[0]?.role || null;
      if (operatorRole !== 'admin' && operatorRole !== 'superadmin')
        return reply.code(403).send(errorBody('仅管理员可创建账号'));
      adminFlow = true;
    }

    const { phone, password, name, role } = req.body || {};
    if (!isPhone(phone)) return reply.code(400).send(errorBody('手机号格式不正确'));
    if (typeof password !== 'string' || password.length < 6)
      return reply.code(400).send(errorBody('密码至少 6 位'));
    if (typeof name !== 'string' || !name.trim())
      return reply.code(400).send(errorBody('请填写姓名'));

    // quan：角色权限校验（在建号前完成，避免半状态）
    let vRole = null;
    if (app === 'quan' && adminFlow && role) {
      vRole = ['teacher', 'admin', 'superadmin'].includes(role) ? role : 'teacher';
      if ((vRole === 'admin' || vRole === 'superadmin') && operatorRole !== 'superadmin')
        return reply.code(403).send(errorBody('仅超级管理员可创建管理员及以上账号'));
    }

    const existing = await findUserByPhone(app, phone);
    if (existing) return reply.code(409).send(errorBody('该手机号已注册，请直接登录'));

    const user = {
      id: genId(),
      phone,
      password_hash: await bcrypt.hash(password, config.bcryptRounds),
      name: name.trim(),
    };
    await getPool(app).query(
      'INSERT INTO users (id, phone, password_hash, name, role) VALUES ($1, $2, $3, $4, $5)',
      [user.id, user.phone, user.password_hash, user.name, 'teacher']
    );
    // yj：注册时若 profiles 里已有同手机号的历史档案（迁移自旧系统），自动关联 owner_id
    if (app === 'yj') {
      try {
        await getPool(app).query(
          'UPDATE profiles SET owner_id = $1 WHERE phone = $2 AND owner_id <> $1',
          [user.id, user.phone]
        );
      } catch (e) { req.log.warn('profiles 自动关联失败: %s', e.message); }
    }
    // quan：带角色时直接写入 staff 表（一步完成建号+授权），并清理该手机号的待认领邀请
    if (app === 'quan' && vRole) {
      try {
        await getPool(app).query(
          `INSERT INTO staff (owner_id, phone, name, role, active, created_at)
           VALUES ($1, $2, $3, $4, true, now())
           ON CONFLICT (owner_id) DO UPDATE SET role = EXCLUDED.role, active = true,
             name = EXCLUDED.name, phone = EXCLUDED.phone`,
          [user.id, user.phone, user.name, vRole]
        );
        await getPool(app).query('DELETE FROM staff_claims WHERE phone = $1', [user.phone]);
      } catch (e) { req.log.warn('staff 授权失败: %s', e.message); }
    }
    // 管理员代建号不签发 token（避免顶掉管理员自己的会话）
    if (adminFlow) return { user: { id: user.id, phone, name: user.name, role: vRole } };
    return { token: signToken(user, app), user: { id: user.id, phone, name: user.name } };
  });

  fastify.post(`/api/${app}/auth/login`, { config: rl }, async (req, reply) => {
    const { phone, password } = req.body || {};
    if (!isPhone(phone) || typeof password !== 'string')
      return reply.code(400).send(errorBody('请输入手机号和密码'));
    const user = await findUserByPhone(app, phone);
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return reply.code(401).send(errorBody('手机号或密码错误'));
    if (!user.active)
      return reply.code(401).send(errorBody('该账号已被停用，请联系管理员'));
    return {
      token: signToken(user, app),
      user: { id: user.id, phone: user.phone, name: user.name, role: user.role || 'user' },
    };
  });

  fastify.get(`/api/${app}/auth/session`, async (req, reply) => {
    const auth = requireAuth(req, app);
    const r = await getPool(app).query('SELECT id, phone, name, role, active FROM users WHERE id = $1', [auth.id]);
    const user = r.rows[0];
    if (!user) return reply.code(401).send(errorBody('账号不存在'));
    return { user: { id: user.id, phone: user.phone, name: user.name, role: user.role || 'user', active: user.active } };
  });

  fastify.post(`/api/${app}/auth/logout`, async () => ({ ok: true }));

  fastify.post(`/api/${app}/auth/change-password`, async (req, reply) => {
    const auth = requireAuth(req, app);
    const { oldPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 6)
      return reply.code(400).send(errorBody('新密码至少 6 位'));
    const r = await getPool(app).query('SELECT password_hash FROM users WHERE id = $1', [auth.id]);
    const user = r.rows[0];
    if (!user) return reply.code(401).send(errorBody('账号不存在'));
    if (!(await bcrypt.compare(String(oldPassword || ''), user.password_hash)))
      return reply.code(400).send(errorBody('原密码错误'));
    const hash = await bcrypt.hash(newPassword, config.bcryptRounds);
    await getPool(app).query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, auth.id]);
    // 统一账号体系：密码变更广播到所有已开通系统（best-effort；主库为 yj，仅 yj 侧改动触发广播）
    if (app === 'yj') {
      try {
        const u = await getUserAccess(auth.id);
        if (u && (u.system_access || []).length) await syncPasswordHash(u, hash);
      } catch (e) { req.log.warn('跨系统密码同步失败: %s', e.message); }
    }
    return { ok: true };
  });
}

/** 要求超级管理员，否则抛 403 */
export function requireSuperAdmin(req, app) {
  const user = requireAuth(req, app);
  if (user.role !== 'superadmin') throw new HttpError(403, '仅超级管理员可执行此操作');
  return user;
}

/**
 * 账号管理路由（仅 yj 注册）：列表 / 开通 / 停用 / 启用 / 删除 / 重置初始密码。
 * 所有接口前置 requireSuperAdmin（JWT 内 role 校验）。
 */
export function registerAdminRoutes(app, fastify) {
  const pool = () => getPool(app);

  // 账号列表
  fastify.get(`/api/${app}/admin/users`, async (req) => {
    requireSuperAdmin(req, app);
    await ensureCols();
    const r = await pool().query(
      'SELECT id, phone, name, role, active, created_at, system_access, system_roles FROM users ORDER BY created_at DESC'
    );
    return { users: r.rows };
  });

  // 开通新账号（管理员代建，设置初始密码）
  fastify.post(`/api/${app}/admin/users`, async (req, reply) => {
    requireSuperAdmin(req, app);
    const { phone, name, password } = req.body || {};
    if (!isPhone(phone)) return reply.code(400).send(errorBody('手机号格式不正确'));
    if (typeof password !== 'string' || password.length < 6)
      return reply.code(400).send(errorBody('初始密码至少 6 位'));
    if (typeof name !== 'string' || !name.trim())
      return reply.code(400).send(errorBody('请填写姓名'));
    const existing = await pool().query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (existing.rows[0]) return reply.code(409).send(errorBody('该手机号已注册'));
    const id = genId();
    await pool().query(
      'INSERT INTO users (id, phone, password_hash, name, role, active) VALUES ($1,$2,$3,$4,$5,true)',
      [id, phone, await bcrypt.hash(password, config.bcryptRounds), name.trim(), 'teacher']
    );
    return { user: { id, phone, name: name.trim(), role: 'teacher', active: true } };
  });

  // 设置账号角色（教师/教务、校长、财务、超级管理员）
  fastify.post(`/api/${app}/admin/users/:id/role`, async (req, reply) => {
    const me = requireSuperAdmin(req, app);
    const id = String(req.params.id);
    const { role } = req.body || {};
    if (!['teacher', 'principal', 'finance', 'superadmin'].includes(role))
      return reply.code(400).send(errorBody('无效的角色'));
    if (me.id === id) return reply.code(400).send(errorBody('不能修改当前登录账号的角色'));
    const t = await pool().query('SELECT role FROM users WHERE id = $1', [id]);
    if (!t.rows[0]) return reply.code(404).send(errorBody('账号不存在'));
    // 防降级最后一名超级管理员
    if (t.rows[0].role === 'superadmin' && role !== 'superadmin') {
      const c = await pool().query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'superadmin'");
      if (c.rows[0].n <= 1) return reply.code(400).send(errorBody('不能降级最后一名超级管理员'));
    }
    await pool().query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    return { ok: true, role };
  });

  // 重置初始密码
  fastify.post(`/api/${app}/admin/users/:id/reset-password`, async (req, reply) => {
    requireSuperAdmin(req, app);
    const { password } = req.body || {};
    if (typeof password !== 'string' || password.length < 6)
      return reply.code(400).send(errorBody('新密码至少 6 位'));
    const hash = await bcrypt.hash(password, config.bcryptRounds);
    const r = await pool().query('UPDATE users SET password_hash = $1 WHERE id = $2',
      [hash, req.params.id]);
    if (r.rowCount === 0) return reply.code(404).send(errorBody('账号不存在'));
    try {
      const u = await getUserAccess(req.params.id);
      if (u && (u.system_access || []).length) await syncPasswordHash(u, hash);
    } catch (e) { req.log.warn('跨系统密码同步失败: %s', e.message); }
    return { ok: true };
  });

  // 读取某账号的系统开通情况
  fastify.get(`/api/${app}/admin/users/:id/access`, async (req, reply) => {
    requireSuperAdmin(req, app);
    const u = await getUserAccess(String(req.params.id));
    if (!u) return reply.code(404).send(errorBody('账号不存在'));
    return {
      access: u.system_access || [],
      roles: u.system_roles || {},
      campuses: u.system_campuses || {},
      defaults: DEFAULT_ROLE_MAP[u.role] || DEFAULT_ROLE_MAP.teacher,
      systems: SYNC_SYSTEMS,
    };
  });

  // WMS 校区/库位列表（「系统权限」弹窗给教师角色选校区用；WMS 未配置时返回空数组）
  fastify.get(`/api/${app}/admin/wms-locations`, async (req, reply) => {
    requireSuperAdmin(req, app);
    try { return { locations: await listWmsLocations() }; }
    catch { return { locations: [] }; }
  });

  // 设置某账号可访问的系统与各系统角色（勾选即开通影子账号，取消即停用，均不删数据）
  fastify.put(`/api/${app}/admin/users/:id/access`, async (req, reply) => {
    requireSuperAdmin(req, app);
    const id = String(req.params.id);
    const { access, roles, campuses } = req.body || {};
    if (!Array.isArray(access)) return reply.code(400).send(errorBody('access 必须是数组'));
    const bad = access.filter((s) => !SYNC_SYSTEMS[s]);
    if (bad.length) return reply.code(400).send(errorBody('未知系统: ' + bad.join(',')));
    const cleanRoles = {};
    for (const s of access) {
      const wanted = roles?.[s];
      const valid = SYNC_SYSTEMS[s].roles.some(([k]) => k === wanted);
      cleanRoles[s] = valid ? wanted : (DEFAULT_ROLE_MAP.teacher[s] || SYNC_SYSTEMS[s].roles[0][0]);
    }
    const u = await getUserAccess(id);
    if (!u) return reply.code(404).send(errorBody('账号不存在'));

    const prev = u.system_access || [];
    const cleanCampuses = {};
    for (const s of access) {
      const c = campuses?.[s];
      if (c != null && Number.isInteger(Number(c))) cleanCampuses[s] = Number(c);
    }
    await pool().query(
      'UPDATE users SET system_access = $1, system_roles = $2, system_campuses = $3 WHERE id = $4',
      [access, JSON.stringify(cleanRoles), JSON.stringify(cleanCampuses), id]);

    // 新开通 → provision；角色变化 → 重新 provision 应用新角色；取消 → 停用影子账号（均保留数据）
    const prevRoles = u.system_roles || {};
    const results = {};
    for (const s of access) {
      // 校区变化也要重新 provision（教师角色的 home_location_id 绑定）
      const campusChanged = (u.system_campuses || {})[s] !== cleanCampuses[s];
      if (prev.includes(s) && prevRoles[s] === cleanRoles[s] && !campusChanged) continue;
      try { await provisionToSystem(u, s, cleanRoles[s], cleanCampuses[s]); results[s] = prev.includes(s) ? 'role-updated' : 'ok'; }
      catch (e) { results[s] = 'fail: ' + e.message; }
    }
    for (const s of prev) {
      if (access.includes(s)) continue;
      try { await syncActive({ ...u, system_access: [s] }, false); results[s] = 'revoked'; }
      catch (e) { results[s] = 'revoke-fail: ' + e.message; }
    }
    return { ok: true, access, roles: cleanRoles, campuses: cleanCampuses, results };
  });

  // 停用
  fastify.post(`/api/${app}/admin/users/:id/disable`, async (req, reply) => {
    const me = requireSuperAdmin(req, app);
    if (me.id === String(req.params.id)) return reply.code(400).send(errorBody('不能停用当前登录的账号'));
    const r = await pool().query('UPDATE users SET active = false WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return reply.code(404).send(errorBody('账号不存在'));
    try {
      const u = await getUserAccess(String(req.params.id));
      if (u && (u.system_access || []).length) await syncActive(u, false);
    } catch (e) { req.log.warn('跨系统停用同步失败: %s', e.message); }
    return { ok: true };
  });

  // 启用
  fastify.post(`/api/${app}/admin/users/:id/enable`, async (req, reply) => {
    requireSuperAdmin(req, app);
    const r = await pool().query('UPDATE users SET active = true WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return reply.code(404).send(errorBody('账号不存在'));
    try {
      const u = await getUserAccess(String(req.params.id));
      if (u && (u.system_access || []).length) await syncActive(u, true);
    } catch (e) { req.log.warn('跨系统启用同步失败: %s', e.message); }
    return { ok: true };
  });

  // 删除
  fastify.delete(`/api/${app}/admin/users/:id`, async (req, reply) => {
    const me = requireSuperAdmin(req, app);
    const id = String(req.params.id);
    if (me.id === id) return reply.code(400).send(errorBody('不能删除当前登录的账号'));
    const t = await pool().query('SELECT role FROM users WHERE id = $1', [id]);
    if (!t.rows[0]) return reply.code(404).send(errorBody('账号不存在'));
    if (t.rows[0].role === 'superadmin') {
      const c = await pool().query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'superadmin'");
      if (c.rows[0].n <= 1) return reply.code(400).send(errorBody('不能删除最后一名超级管理员'));
    }
    // 统一账号体系：删除前把各系统影子账号停用（保留对方业务数据，遵守数据红线）
    try {
      const u = await getUserAccess(id);
      if (u && (u.system_access || []).length) await syncRemoved(u);
    } catch (e) { req.log.warn('跨系统删除同步失败: %s', e.message); }
    const r = await pool().query('DELETE FROM users WHERE id = $1', [id]);
    if (r.rowCount === 0) return reply.code(404).send(errorBody('账号不存在'));
    return { ok: true };
  });
}
