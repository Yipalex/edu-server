// 每应用每表的访问控制（代码实现，替代 RLS；DB 连接用表 owner 角色）
//
// authorize(ctx, op) 返回：
//   true                    → 放行（仍需登录的已由调用方保证）
//   { filters: [...] }      → 放行，但需附加过滤条件（self 语义）
//   { set: {...} }          → insert 时强制写入的字段
//   以上可组合；false       → 禁止
//
// ctx = { app, table, user: {id, phone} | null, isStaff: boolean }

/** yj 角色：查 profiles 表，role ∈ leader/finance 视为管理/财务 */
export async function loadYjRole(pool, userId) {
  const r = await pool.query('SELECT role FROM profiles WHERE owner_id = $1 LIMIT 1', [userId]);
  return r.rows[0]?.role || 'staff';
}

const YJ_STAFF_ROLES = ['leader', 'finance'];

export function isYjStaffRole(role) {
  return YJ_STAFF_ROLES.includes(role);
}

// jz 报名表允许匿名写入的字段白名单
const JZ_REG_FIELDS = ['name', 'phone', 'stage', 'has_cert', 'bio', 'attachments', 'reg_no'];

const yj = {
  profiles: {
    select: (c) => ({ filters: [{ col: 'owner_id', op: 'eq', val: c.user.id }] }),
    insert: (c) => ({ set: { owner_id: c.user.id } }),
    update: (c) => ({ filters: [{ col: 'owner_id', op: 'eq', val: c.user.id }] }),
    delete: false,
  },
  records: {
    select: (c) =>
      c.isStaff ? true : { filters: [{ col: 'owner_id', op: 'eq', val: c.user.id }] },
    insert: (c) => ({ set: { owner_id: c.user.id, owner_name: c.userName || null } }),
    /* 指定超管账号（13800000000）可更新任意记录（配合前端做已核算回退等操作），其余人仅改自己的 */
    update: (c) =>
      c.isStaff || (c.user && c.user.phone === '13800000000')
        ? true
        : { filters: [{ col: 'owner_id', op: 'eq', val: c.user.id }] },
    /* 指定超管账号（13800000000）可彻底删除任意记录（含已核算），其余人仅删自己的 */
    delete: (c) =>
      c.isStaff || (c.user && c.user.phone === '13800000000')
        ? true
        : { filters: [{ col: 'owner_id', op: 'eq', val: c.user.id }] },
  },
  items: { select: true, insert: false, update: false, delete: false },
  role_presets: { select: true, insert: false, update: false, delete: false },
  /* 课后服务地址：全员登录可读；增删改仅超级管理员（JWT user.role 判定，在函数内返回 false 即 403） */
  service_addrs: {
    select: true,
    insert: (c) => !!(c.user && c.user.role === 'superadmin'),
    update: (c) => !!(c.user && c.user.role === 'superadmin'),
    delete: (c) => !!(c.user && c.user.role === 'superadmin'),
  },
  params: {
    select: true,
    insert: (c) => c.isStaff,
    update: (c) => c.isStaff,
    delete: (c) => c.isStaff,
  },
  /* 操作审计日志：仅超级管理员（JWT role）可查；写入由服务端内部完成，API 层禁写删 */
  audit_logs: {
    select: (c) => !!(c.user && c.user.role === 'superadmin'),
    insert: false,
    update: false,
    delete: false,
  },
};

const QUAN_READONLY = { select: true, insert: false, update: false, delete: false };
const quan = {
  classes: QUAN_READONLY,
  course_tiers: QUAN_READONLY,
  mentors: QUAN_READONLY,
  session_vouchers: QUAN_READONLY,
  voucher_events: QUAN_READONLY,
  student_eligibility: QUAN_READONLY,
  students: QUAN_READONLY,
  transactions: QUAN_READONLY,
  wallets: QUAN_READONLY,
  staff: QUAN_READONLY,
  staff_claims: { select: false, insert: false, update: false, delete: false },
};

const jz = {
  registrations: {
    select: false,
    // 匿名公开报名：只允许白名单字段，强制 status='待审核'
    insert: () => ({ allowFields: JZ_REG_FIELDS, set: { status: '待审核' } }),
    update: false,
    delete: false,
  },
  exam_scores: { select: false, insert: false, update: false, delete: false },
};

const POLICIES = { yj, quan, jz };

/**
 * 鉴权入口。返回 { allowFields?, filters?, set? } 或抛 HttpError。
 * 调用方需先解析 JWT（可为 null）。
 */
export function authorize({ app, table, op, user, isStaff = false, userName = null }) {
  const appPolicy = POLICIES[app];
  const tablePolicy = appPolicy && appPolicy[table];
  if (!tablePolicy) {
    const err = new Error(`表 ${table} 不允许访问`);
    err.statusCode = 403;
    throw err;
  }
  const rule = tablePolicy[op];
  if (rule === false || rule === undefined) {
    const err = new Error(`表 ${table} 不允许 ${op} 操作`);
    err.statusCode = 403;
    throw err;
  }
  const isPublicAnon = app === 'jz' && table === 'registrations' && op === 'insert';
  if (!user && !isPublicAnon) {
    const err = new Error('未登录或登录已过期');
    err.statusCode = 401;
    throw err;
  }
  if (rule === true) return {};
  const ctx = { user, isStaff, userName };
  const result = typeof rule === 'function' ? rule(ctx) : rule;
  if (!result) {
    const err = new Error('没有权限执行此操作');
    err.statusCode = 403;
    throw err;
  }
  return result === true ? {} : result;
}
