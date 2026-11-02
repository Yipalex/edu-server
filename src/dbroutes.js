// 通用 DB 代理（替代 PostgREST 链式查询）+ RPC 代理
import { getPool, getFunctionSigs, resolveOverload } from './db.js';
import { getAuthUser } from './auth.js';
import { authorize, loadYjRole, isYjStaffRole } from './policies.js';
import { isIdent } from './util.js';
import { onRecordsStatusChange } from './xibao.js';

const OPS = {
  eq: (c, p) => `${c} = ${p}`,
  ne: (c, p) => `${c} <> ${p}`,
  gt: (c, p) => `${c} > ${p}`,
  gte: (c, p) => `${c} >= ${p}`,
  lt: (c, p) => `${c} < ${p}`,
  lte: (c, p) => `${c} <= ${p}`,
  like: (c, p) => `${c} LIKE ${p}`,
  ilike: (c, p) => `${c} ILIKE ${p}`,
};

// RPC 白名单：value 为 true 表示匿名可访问
const RPC_WHITELIST = {
  yj: {},
  quan: {
    server_now: false, staff_me: false, claim_staff: false, create_claim: false,
    deduct_session: false, delete_class: false, grant_staff: false, is_admin: false,
    is_staff: false, issue_vouchers: false, batch_issue_vouchers: false,
    list_claims: false, parent_lookup: true, recharge_wallet: false,
    redeem_voucher: false, set_eligibility: false, set_staff_active: false,
    upsert_class: false, upsert_mentor: false, upsert_student: false,
    void_transaction: false, void_voucher: false, void_voucher_use: false,
  },
  jz: {
    check_registration_status: true, check_score: true,
    admin_list_registrations: true, admin_review_registration: true,
    admin_get_attachments: true, admin_add_scores: true,
    admin_list_scores: true, admin_delete_score: true,
  },
};

function buildWhere(filters, values, startIdx) {
  const clauses = [];
  let i = startIdx;
  for (const f of filters) {
    if (!f || !isIdent(f.col)) throw Object.assign(new Error(`非法列名: ${f && f.col}`), { statusCode: 400 });
    const op = f.op;
    if (op === 'in') {
      if (!Array.isArray(f.val)) throw Object.assign(new Error('in 的值必须是数组'), { statusCode: 400 });
      clauses.push(`${f.col} = ANY($${i++})`);
      values.push(f.val);
    } else if (op === 'is') {
      if (f.val === null) clauses.push(`${f.col} IS NULL`);
      else if (f.val === true) clauses.push(`${f.col} IS TRUE`);
      else if (f.val === false) clauses.push(`${f.col} IS FALSE`);
      else throw Object.assign(new Error('is 的值只允许 null/true/false'), { statusCode: 400 });
    } else if (OPS[op]) {
      clauses.push(OPS[op](f.col, `$${i++}`));
      values.push(f.val === undefined ? null : f.val);
    } else {
      throw Object.assign(new Error(`不支持的操作符: ${op}`), { statusCode: 400 });
    }
  }
  return { sql: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', nextIdx: i };
}

function parseSelectCols(selectCols) {
  if (!selectCols || selectCols === '*') return '*';
  const cols = Array.isArray(selectCols) ? selectCols : String(selectCols).split(',');
  const cleaned = cols.map((c) => c.trim()).filter(Boolean);
  if (!cleaned.length) return '*';
  for (const c of cleaned) {
    if (!isIdent(c)) throw Object.assign(new Error(`非法列名: ${c}`), { statusCode: 400 });
  }
  return cleaned.join(', ');
}

/** 组装鉴权上下文（yj 需要查角色） */
async function makeCtx(app, table, op, req) {
  const user = getAuthUser(req, app);
  let isStaff = false;
  let userName = null;
  if (app === 'yj' && user) {
    const role = await loadYjRole(getPool(app), user.id).catch(() => 'staff');
    isStaff = isYjStaffRole(role);
    const r = await getPool(app).query('SELECT name FROM users WHERE id = $1', [user.id]).catch(() => ({ rows: [] }));
    userName = r.rows[0]?.name || null;
  }
  return authorize({ app, table, op, user, isStaff, userName });
}

/* ============ 审计日志（仅 yj）：所有写操作留痕，保留 90 天 ============ */
let lastAuditPurge = 0;

function summarizeDetail(payload) {
  try {
    let s = JSON.stringify(payload === undefined ? null : payload);
    if (s && s.length > 8000) s = s.slice(0, 8000) + '…[截断]';
    return s;
  } catch (e) {
    return 'null';
  }
}

function pickRecordId(source) {
  if (Array.isArray(source)) {
    const f = source.find((x) => x && x.col === 'id' && (x.op === 'eq' || x.op === 'in'));
    if (f) return Array.isArray(f.val) ? f.val.join(',') : String(f.val);
    return null;
  }
  if (source && source.id !== undefined && source.id !== null) return String(source.id);
  return null;
}

/* 写操作前抓取受影响记录的内容快照（审计日志展示用）。records 表只取常用列，控制日志体积。 */
async function snapshotRows(app, table, filters) {
  try {
    const values = [];
    const where = buildWhere(filters, values, 1);
    const cols = table === 'records'
      ? 'id, type, status, month, campus, owner_name, remark, payload'
      : '*';
    const r = await getPool(app).query(`SELECT ${cols} FROM ${table}${where.sql} LIMIT 10`, values);
    return r.rows;
  } catch (_) {
    return null;
  }
}

async function auditWrite(app, req, { tbl, op, recordId, detail }) {
  if (app !== 'yj') return;
  try {
    const user = getAuthUser(req, app);
    const pool = getPool(app);
    let userName = null;
    if (user) {
      const r = await pool.query('SELECT name FROM users WHERE id = $1', [user.id]).catch(() => ({ rows: [] }));
      userName = r.rows[0]?.name || null;
    }
    await pool.query(
      `INSERT INTO audit_logs (tbl, op, user_id, user_phone, user_name, record_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [tbl, op, user ? user.id : null, (user && user.phone) || null, userName, recordId, summarizeDetail(detail), req.ip || null]
    );
    // 惰性清理 90 天前日志（10 分钟节流；保留期内数据不动）
    const now = Date.now();
    if (now - lastAuditPurge > 10 * 60 * 1000) {
      lastAuditPurge = now;
      pool.query(`DELETE FROM audit_logs WHERE created_at < now() - interval '90 days'`).catch(() => {});
    }
  } catch (e) {
    req.log && req.log.warn({ err: e && e.message }, 'audit write failed');
  }
}

export function registerDbRoutes(fastify) {
  // POST /api/:app/db/query
  // 返回约定：成功返回裸值（rows 数组）；失败返回 {error:{message}}（HTTP 200，前端按 error 字段判断）
  fastify.post('/api/:app/db/query', async (req) => {
    const { app } = req.params;
    const { table, filters = [], order = [], limit, offset } = req.body || {};
    const selectCols = req.body?.selectCols ?? req.body?.select ?? '*'; // adapter 发的是 select
    if (!isIdent(table)) return { error: { message: '非法表名' } };

    let authz;
    try {
      authz = await makeCtx(app, table, 'select', req);
    } catch (e) {
      return { error: { message: e.message } };
    }

    const values = [];
    let where;
    try {
      const cols = parseSelectCols(selectCols);
      where = buildWhere([...(authz.filters || []), ...filters], values, 1);
      let sql = `SELECT ${cols} FROM ${table}${where.sql}`;
      if (Array.isArray(order)) {
        const parts = [];
        for (const o of order) {
          if (!o || !isIdent(o.col)) return { error: { message: `非法排序列: ${o && o.col}` } };
          parts.push(`${o.col} ${o.ascending === false ? 'DESC' : 'ASC'}`);
        }
        if (parts.length) sql += ' ORDER BY ' + parts.join(', ');
      }
      if (limit != null) {
        sql += ` LIMIT $${where.nextIdx++}`;
        values.push(Math.min(Math.max(parseInt(limit, 10) || 0, 0), 10000));
      }
      if (offset != null) {
        sql += ` OFFSET $${where.nextIdx++}`;
        values.push(Math.max(parseInt(offset, 10) || 0, 0));
      }
      const r = await getPool(app).query(sql, values);
      return r.rows;
    } catch (e) {
      return { error: { message: e.message } };
    }
  });

  // POST /api/:app/db/insert {table, rows:[...], returning}
  fastify.post('/api/:app/db/insert', async (req) => {
    const { app } = req.params;
    const { table, rows, returning } = req.body || {};
    if (!isIdent(table)) return { error: { message: '非法表名' } };
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500)
      return { error: { message: 'rows 必须是 1~500 条的数组' } };

    let authz;
    try {
      authz = await makeCtx(app, table, 'insert', req);
    } catch (e) {
      return { error: { message: e.message } };
    }

    try {
      const forceSet = authz.set || {};
      const allowFields = authz.allowFields || null;
      const cleanRows = rows.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('rows 元素必须是对象');
        const out = {};
        for (const [k, v] of Object.entries(row)) {
          if (!isIdent(k)) throw new Error(`非法列名: ${k}`);
          if (allowFields && !allowFields.includes(k)) continue; // 丢弃非白名单字段
          out[k] = v;
        }
        Object.assign(out, forceSet); // 强制字段覆盖客户端值
        return out;
      });

      // 所有行用并集列，缺列补 null
      const colSet = new Set();
      for (const r of cleanRows) Object.keys(r).forEach((k) => colSet.add(k));
      const cols = [...colSet];
      if (!cols.length) return { error: { message: '没有可写入的字段' } };

      const values = [];
      const tuples = cleanRows.map((row) => {
        const ph = cols.map((c) => {
          values.push(row[c] === undefined ? null : row[c]);
          return `$${values.length}`;
        });
        return `(${ph.join(', ')})`;
      });
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}${returning ? ' RETURNING *' : ''}`;
      const r = await getPool(app).query(sql, values);
      await auditWrite(app, req, {
        tbl: table, op: 'insert',
        recordId: pickRecordId((r.rows && r.rows[0]) || cleanRows[0]),
        detail: { rows: cleanRows },
      });
      return returning ? r.rows : null;
    } catch (e) {
      return { error: { message: e.message } };
    }
  });

  // POST /api/:app/db/update {table, set:{}, filters, returning}
  fastify.post('/api/:app/db/update', async (req) => {
    const { app } = req.params;
    const { table, set, filters = [], returning } = req.body || {};
    if (!isIdent(table)) return { error: { message: '非法表名' } };
    if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length)
      return { error: { message: 'set 必须是非空对象' } };

    let authz;
    try {
      authz = await makeCtx(app, table, 'update', req);
    } catch (e) {
      return { error: { message: e.message } };
    }

    try {
      const values = [];
      const setClauses = [];
      for (const [k, v] of Object.entries(set)) {
        if (!isIdent(k)) throw new Error(`非法列名: ${k}`);
        if ((authz.set || {})[k] !== undefined && (authz.set || {})[k] !== v) continue; // 不允许改强制字段
        setClauses.push(`${k} = $${values.length + 1}`);
        values.push(v);
      }
      if (!setClauses.length) return { error: { message: '没有可更新的字段' } };
      // 变更前快照（用于审计日志展示"从 X 改到 Y"）
      const before = await snapshotRows(app, table, [...(authz.filters || []), ...filters]);
      const where = buildWhere([...(authz.filters || []), ...filters], values, values.length + 1);
      const sql = `UPDATE ${table} SET ${setClauses.join(', ')}${where.sql}${returning ? ' RETURNING *' : ''}`;
      const r = await getPool(app).query(sql, values);
      await auditWrite(app, req, {
        tbl: table, op: 'update',
        recordId: pickRecordId(filters) || pickRecordId(r.rows && r.rows[0]),
        detail: { set, before },
      });
      /* 记录状态变更钩子（喜报推送/退回消息）：仅 yj records，fire-and-forget，异常已在钩子内兜住。
         注意：必须单独组装查询参数 —— values 已按 SET 子句占用占位符，复用会错位 */
      if (app === 'yj' && table === 'records' && set.status !== undefined) {
        const selValues = [];
        const selWhere = buildWhere([...(authz.filters || []), ...filters], selValues, 1);
        getPool(app).query(`SELECT * FROM ${table}${selWhere.sql} LIMIT 50`, selValues)
          .then((sel) => onRecordsStatusChange(app, req, { set, before, afterRows: sel.rows || [] }))
          .catch(() => {});
      }
      return returning ? r.rows : null;
    } catch (e) {
      return { error: { message: e.message } };
    }
  });

  // POST /api/:app/db/delete {table, filters, returning}
  fastify.post('/api/:app/db/delete', async (req) => {
    const { app } = req.params;
    const { table, filters = [], returning } = req.body || {};
    if (!isIdent(table)) return { error: { message: '非法表名' } };
    if (!Array.isArray(filters) || filters.length === 0)
      return { error: { message: 'delete 必须带过滤条件' } };

    let authz;
    try {
      authz = await makeCtx(app, table, 'delete', req);
    } catch (e) {
      return { error: { message: e.message } };
    }

    try {
      const values = [];
      // 删除前快照（审计日志需展示被删记录的内容）
      const deleted = await snapshotRows(app, table, [...(authz.filters || []), ...filters]);
      const where = buildWhere([...(authz.filters || []), ...filters], values, 1);
      const sql = `DELETE FROM ${table}${where.sql}${returning ? ' RETURNING *' : ''}`;
      const r = await getPool(app).query(sql, values);
      await auditWrite(app, req, {
        tbl: table, op: 'delete',
        recordId: pickRecordId(filters) || pickRecordId(r.rows && r.rows[0]),
        detail: { deleted },
      });
      return returning ? r.rows : null;
    } catch (e) {
      return { error: { message: e.message } };
    }
  });

  // POST /api/:app/rpc/:fn —— 事务内 set_config 后用命名参数调用
  // 成功返回函数值（裸值：标量/对象/行数组）；函数 raise exception 的 message 原样放在 {error:{message}}，HTTP 200
  fastify.post('/api/:app/rpc/:fn', async (req, reply) => {
    const { app, fn } = req.params;
    const whitelist = RPC_WHITELIST[app] || {};
    if (!isIdent(fn) || !(fn in whitelist)) {
      return reply.code(404).send({ error: { message: '函数不存在或不允许调用' }, message: '函数不存在或不允许调用' });
    }
    const anonAllowed = whitelist[fn] === true;
    const user = getAuthUser(req, app);
    if (!user && !anonAllowed) {
      return reply.code(401).send({ error: { message: '未登录或登录已过期' }, message: '未登录或登录已过期' });
    }
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

    let overloads;
    try {
      overloads = await getFunctionSigs(app, fn, Object.keys(whitelist));
    } catch (e) {
      return reply.code(503).send({ error: { message: `数据库不可用: ${e.message}` }, message: `数据库不可用: ${e.message}` });
    }
    if (!overloads) return { error: { message: `函数 ${fn} 在数据库中不存在` } };

    let resolved;
    try {
      resolved = resolveOverload(overloads, body);
    } catch (e) {
      return { error: { message: e.message } };
    }
    const pool = getPool(app);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (user) {
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
        await client.query(`SELECT set_config('app.user_phone', $1, true)`, [user.phone || '']);
      }
      const namedArgs = resolved.argNames.map((n, i) => `${n} := $${i + 1}`).join(', ');
      const sql = `SELECT * FROM ${fn}(${namedArgs})`;
      const r = await client.query(sql, resolved.values);
      await client.query('COMMIT');

      // 返回值规整：裸值直接返回（标量/对象/数组）
      const fields = r.fields.map((f) => f.name);
      if (resolved.retset) {
        return r.rows.map((row) => (fields.length === 1 ? row[fields[0]] : row));
      }
      if (r.rows.length === 0) return null;
      if (fields.length === 1) return r.rows[0][fields[0]]; // 标量或对象/数组，直接返回该值
      return r.rows[0];
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // 函数内 raise exception 的 message 原样返回，HTTP 200，前端按 error 字段判断
      return { error: { message: e.message } };
    } finally {
      client.release();
    }
  });
}
