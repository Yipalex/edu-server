// 工作台支撑路由（仅 yj 挂载）：教师名单 / 消息中心 / 月度目标配置
// 月度目标：按自然月固定口径存金额（超管可配默认值与个人覆盖值），展示侧 Phase 2 消费
import { getPool } from './db.js';
import { requireAuth, requireSuperAdmin } from './auth.js';
import { errorBody } from './util.js';

const DEFAULT_TARGET = 15000;

export function registerWorkspaceRoutes(fastify) {
  const pool = () => getPool('yj');

  /* 教师名单：全机构在职账号（登录即可读，供学费登记「授课老师」下拉） */
  fastify.get('/api/yj/teachers', async (req, reply) => {
    requireAuth(req, 'yj');
    const r = await pool().query(
      "SELECT id, name FROM users WHERE active = true AND name IS NOT NULL AND name <> '' ORDER BY name"
    );
    return { teachers: r.rows };
  });

  /* ========== 消息中心 ========== */
  fastify.get('/api/yj/messages', async (req, reply) => {
    const me = requireAuth(req, 'yj');
    const r = await pool().query(
      'SELECT id, kind, title, body, read, created_at FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT 50',
      [me.id]
    );
    return { messages: r.rows };
  });

  fastify.get('/api/yj/messages/unread-count', async (req, reply) => {
    const me = requireAuth(req, 'yj');
    const r = await pool().query(
      'SELECT COUNT(*)::int AS n FROM messages WHERE user_id = $1 AND read = false',
      [me.id]
    );
    return { count: r.rows[0] ? r.rows[0].n : 0 };
  });

  fastify.post('/api/yj/messages/read-all', async (req, reply) => {
    const me = requireAuth(req, 'yj');
    await pool().query('UPDATE messages SET read = true WHERE user_id = $1 AND read = false', [me.id]);
    return { ok: true };
  });

  /* ========== 月度目标（超管可配置；按自然月固定金额） ========== */
  async function readTargetCfg() {
    const r = await pool().query("SELECT value FROM settings WHERE key = 'monthly_target'");
    const v = (r.rows[0] && r.rows[0].value) || {};
    return { default: Number(v.default) || DEFAULT_TARGET, perUser: v.perUser || {} };
  }

  fastify.get('/api/yj/settings/target', async (req, reply) => {
    requireSuperAdmin(req, 'yj');
    const cfg = await readTargetCfg();
    return { target: cfg.default, perUser: cfg.perUser };
  });

  fastify.put('/api/yj/settings/target', async (req, reply) => {
    requireSuperAdmin(req, 'yj');
    const { default: dft, perUser } = req.body || {};
    if (dft !== undefined && (!Number.isFinite(Number(dft)) || Number(dft) < 0))
      return reply.code(400).send(errorBody('默认目标必须是不小于 0 的数字'));
    const clean = {};
    if (perUser && typeof perUser === 'object') {
      for (const [uid, val] of Object.entries(perUser)) {
        const n = Number(val);
        if (val === null || val === '' || !Number.isFinite(n) || n <= 0) continue; // 空值/非法值忽略（视为用默认）
        clean[String(uid)] = n;
      }
    }
    const cfg = await readTargetCfg();
    const next = { default: dft !== undefined ? Number(dft) : cfg.default, perUser: Object.keys(clean).length ? clean : cfg.perUser };
    if (perUser && typeof perUser === 'object') next.perUser = clean; // 显式提交即整体覆盖
    await pool().query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('monthly_target', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(next)]
    );
    return { ok: true, target: next };
  });

  /* 本人当月目标（任意登录用户；展示侧消费） */
  fastify.get('/api/yj/my-target', async (req, reply) => {
    const me = requireAuth(req, 'yj');
    const cfg = await readTargetCfg();
    const mine = cfg.perUser[me.id] !== undefined ? Number(cfg.perUser[me.id]) : cfg.default;
    return { target: mine, default: cfg.default };
  });

  /* ========== 工作台首页统计（个人聚合，跨人比较只回名次不回他人明细） ========== */
  async function myName(me) {
    const r = await pool().query('SELECT name FROM profiles WHERE owner_id = $1 LIMIT 1', [me.id]);
    if (r.rows[0] && r.rows[0].name) return r.rows[0].name;
    const u = await pool().query('SELECT name FROM users WHERE id = $1 LIMIT 1', [me.id]);
    return (u.rows[0] && u.rows[0].name) || '';
  }
  const curMonth = () => new Date().toISOString().slice(0, 7);

  fastify.get('/api/yj/my-stats', async (req, reply) => {
    const me = requireAuth(req, 'yj');
    const name = await myName(me);
    const month = (req.query && String(req.query.month || '').match(/^\d{4}-\d{2}$/)) ? req.query.month : curMonth();

    const P = () => pool();
    const [amount, orders, hours, invites] = await Promise.all([
      P().query(
        `SELECT COALESCE(SUM((payload->>'amount')::numeric),0)::float8 AS v FROM records
         WHERE type='tuition' AND status IN ('pending','accounted') AND month=$1 AND payload->>'commission_to'=$2`,
        [month, name]
      ),
      P().query(
        `SELECT COUNT(*)::int AS v FROM records
         WHERE type='tuition' AND month=$1 AND payload->>'commission_to'=$2`,
        [month, name]
      ),
      P().query(
        `SELECT COUNT(*)::int AS v FROM records
         WHERE type='course' AND month=$1 AND owner_name=$2`,
        [month, name]
      ),
      P().query(
        `SELECT COUNT(*)::int AS v FROM records
         WHERE type='invite' AND month=$1 AND owner_name=$2`,
        [month, name]
      ),
    ]);

    // 近 6 个月业绩趋势（已核算学费，按跟进老师归属）
    const trendRows = await P().query(
      `SELECT month, COALESCE(SUM((payload->>'amount')::numeric),0)::float8 AS v FROM records
       WHERE type='tuition' AND status IN ('pending','accounted') AND payload->>'commission_to'=$1
         AND month >= to_char(date_trunc('month', $2::date) - interval '5 months', 'YYYY-MM')
         AND month <= to_char($2::date, 'YYYY-MM')
       GROUP BY month ORDER BY month`,
      [name, month + '-01']
    );
    const trend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(month + '-01T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() - i);
      const m = d.toISOString().slice(0, 7);
      const row = trendRows.rows.find((r) => r.month === m);
      trend.push({ month: m, amount: row ? row.v : 0 });
    }

    // 全校名次：本月已核算业绩金额排名（只回本人名次与总人数）
    const rankRows = await P().query(
      `SELECT payload->>'commission_to' AS name, COALESCE(SUM((payload->>'amount')::numeric),0) AS v
       FROM records WHERE type='tuition' AND status IN ('pending','accounted') AND month=$1
         AND payload->>'commission_to' IS NOT NULL AND payload->>'commission_to' <> ''
       GROUP BY 1 ORDER BY v DESC`,
      [month]
    );
    const rankIdx = rankRows.rows.findIndex((r) => r.name === name);
    const rank = rankIdx >= 0 ? rankIdx + 1 : null;
    const rankTotal = rankRows.rows.length;

    // 徽章（服务端算好，只回获得标记；并列第一均可获得）
    const ordRows = await P().query(
      `SELECT payload->>'commission_to' AS name, COUNT(*)::int AS n FROM records
       WHERE type='tuition' AND month=$1 AND payload->>'commission_to' IS NOT NULL AND payload->>'commission_to' <> ''
       GROUP BY 1 ORDER BY n DESC`, [month]);
    const invRows = await P().query(
      `SELECT owner_name AS name, COUNT(*)::int AS n FROM records
       WHERE type='invite' AND month=$1 AND owner_name IS NOT NULL AND owner_name <> ''
       GROUP BY 1 ORDER BY n DESC`, [month]);
    const topN = (rows) => (rows.length && rows[0].n > 0 ? rows[0].n : 0);
    const myN = (rows) => { const r = rows.find((x) => x.name === name); return r ? r.n : 0; };
    // 满勤之星：本月至今日每天都有登记记录，且本月已过 >=10 天
    const days = await P().query(
      `SELECT COUNT(DISTINCT created_at::date)::int AS n FROM records
       WHERE owner_name=$1 AND created_at >= date_trunc('month', now()) AND created_at < now() + interval '1 day'`,
      [name]);
    const elapsed = new Date().getDate(); // 本月已过的天数（服务器时区）
    const fullAtt = elapsed >= 10 && days.rows[0] && days.rows[0].n >= elapsed;

    return {
      month, name,
      amount: amount.rows[0].v, orders: orders.rows[0].v,
      hours: hours.rows[0].v, invites: invites.rows[0].v,
      trend, rank, rankTotal,
      badges: {
        order_king: myN(ordRows.rows) > 0 && myN(ordRows.rows) === topN(ordRows.rows),
        invite_star: myN(invRows.rows) > 0 && myN(invRows.rows) === topN(invRows.rows),
        full_att: !!fullAtt,
      },
    };
  });

  /* ========== 业绩榜单（角色定界：教师仅本人+名次，避免攀比；校长看本校区；超管/财务看全校+校区汇总） ========== */
  /* profiles.campus（赤坎金城/霞山社坛…）与 records.campus（金城校区/霞山校区…）口径不一致，需别名映射 */
  const CAMPUS_ALIAS = { '赤坎金城': '金城校区', '霞山社坛': '霞山校区', '海东': '海东校区', '麻章': '麻章校区', '开发区': '开发区校区' };
  async function myCampus(me) {
    const r = await pool().query('SELECT campus FROM profiles WHERE owner_id = $1 LIMIT 1', [me.id]);
    const c = (r.rows[0] && r.rows[0].campus) || '';
    if (!c) return '';
    if (c.includes('校区')) return c;
    return CAMPUS_ALIAS[c] || c + '校区';
  }
  // 校区汇总：该校区已核算学费总额/单数 + 课时节数
  async function campusSummary(campus, month) {
    const r = await pool().query(
      `SELECT COALESCE(SUM((payload->>'amount')::numeric),0)::float8 AS amount, COUNT(*)::int AS orders
       FROM records WHERE type='tuition' AND status IN ('pending','accounted') AND month=$1 AND campus=$2`,
      [month, campus]);
    const h = await pool().query(
      `SELECT COUNT(*)::int AS n FROM records WHERE type='course' AND month=$1 AND campus=$2`,
      [month, campus]);
    return { campus, amount: r.rows[0].amount, orders: r.rows[0].orders, hours: h.rows[0].n };
  }

  fastify.get('/api/yj/rank', async (req, reply) => {
    const me = requireAuth(req, 'yj');
    const month = (req.query && String(req.query.month || '').match(/^\d{4}-\d{2}$/)) ? req.query.month : curMonth();
    const isSuperMgr = me.role === 'superadmin' || me.role === 'finance';
    const isPrincipal = me.role === 'principal';
    const name = await myName(me);

    const mine = await pool().query(
      `SELECT COALESCE(SUM((payload->>'amount')::numeric),0)::float8 AS amount, COUNT(*)::int AS orders
       FROM records WHERE type='tuition' AND status IN ('pending','accounted') AND month=$1 AND payload->>'commission_to'=$2`,
      [month, name]);
    const rankRows = await pool().query(
      `SELECT payload->>'commission_to' AS name, COALESCE(SUM((payload->>'amount')::numeric),0)::float8 AS amount, COUNT(*)::int AS orders
       FROM records WHERE type='tuition' AND status IN ('pending','accounted') AND month=$1
         AND payload->>'commission_to' IS NOT NULL AND payload->>'commission_to' <> ''
       GROUP BY 1 ORDER BY amount DESC`, [month]);
    const idx = rankRows.rows.findIndex((r) => r.name === name);
    const out = {
      month,
      role: isSuperMgr ? 'manager' : (isPrincipal ? 'principal' : 'teacher'),
      self: { name, amount: mine.rows[0].amount, orders: mine.rows[0].orders, rank: idx >= 0 ? idx + 1 : null, total: rankRows.rows.length },
    };
    if (isSuperMgr) {
      out.top = rankRows.rows.slice(0, 10);
      const cs = await pool().query(
        `SELECT campus, COALESCE(SUM((payload->>'amount')::numeric),0)::float8 AS amount, COUNT(*)::int AS orders
         FROM records WHERE type='tuition' AND status IN ('pending','accounted') AND month=$1 AND campus IS NOT NULL AND campus <> ''
         GROUP BY campus ORDER BY amount DESC`, [month]);
      const hs = await pool().query(
        `SELECT campus, COUNT(*)::int AS n FROM records
         WHERE type='course' AND month=$1 AND campus IS NOT NULL AND campus <> '' GROUP BY campus`, [month]);
      out.campusSummary = cs.rows.map((c) => ({ ...c, hours: (hs.rows.find((x) => x.campus === c.campus) || {}).n || 0 }));
    } else if (isPrincipal) {
      const campus = await myCampus(me);
      out.campus = campus;
      if (campus) {
        out.campusSummary = [await campusSummary(campus, month)];
        out.campusRank = await pool().query(
          `SELECT payload->>'commission_to' AS name, COALESCE(SUM((payload->>'amount')::numeric),0)::float8 AS amount, COUNT(*)::int AS orders
           FROM records WHERE type='tuition' AND status IN ('pending','accounted') AND month=$1 AND campus=$2
             AND payload->>'commission_to' IS NOT NULL AND payload->>'commission_to' <> ''
           GROUP BY 1 ORDER BY amount DESC`, [month, campus]).then((r) => r.rows);
      }
    }
    return out;
  });

  /* ========== 六系统切换（权限判定 + SSO 标记） ========== */
  const SYSTEMS = [
    { key: 'yj',   name: '业绩登记系统', desc: '课时 · 学费 · 物品 · 邀约', url: 'https://yj.zexishuhua.com/',   sso: true },
    { key: 'quan', name: '券类管理系统', desc: '优惠券发放与核销',          url: 'https://quan.zexishuhua.com/',  sso: true },
    { key: 'jz',   name: '教资报名系统', desc: '教资报名与课时',            url: 'https://jz.zexishuhua.com/',    sso: true },
    { key: 'sf',   name: '评测报告系统', desc: '学员书写评测报告生成',      url: 'https://sf.zexishuhua.com/',    sso: false },
    { key: 'wms',  name: '仓库管理系统', desc: '物品档案 · 出入库 · 盘点',  url: 'https://wms.zexishuhua.com/',   sso: false },
    { key: 'zc',   name: '固定资产管理', desc: '资产台账与领用',            url: 'https://zc.zexishuhua.com/',    sso: false },
  ];
  fastify.get('/api/yj/systems', async (req, reply) => {
    const me = requireAuth(req, 'yj');
    // 统一账号体系：可访问范围以 yj users.system_access 为准（超管恒为全系统）
    // 列尚不存在（迁移前）时 myAccess=null，按旧逻辑放行，避免误伤存量用户
    let myAccess = null;
    if (me.role !== 'superadmin') {
      try {
        const ur = await pool().query('SELECT system_access FROM users WHERE id = $1', [me.id]);
        myAccess = ur.rows[0]?.system_access || [];
      } catch { myAccess = null; }
    }
    const out = [];
    for (const s of SYSTEMS) {
      let access = 'granted'; // granted | denied | login（独立登录，直达其登录页）
      if (s.key === 'quan') {
        if (myAccess && !myAccess.includes('quan')) {
          access = 'denied';
        } else {
          try {
            const r = await getPool(s.key).query('SELECT active FROM users WHERE phone=$1 LIMIT 1', [me.phone]);
            access = r.rows[0] && r.rows[0].active ? 'granted' : 'denied';
          } catch { access = 'denied'; }
        }
      } else if (s.key === 'jz') {
        try {
          const r = await getPool(s.key).query('SELECT active FROM users WHERE phone=$1 LIMIT 1', [me.phone]);
          access = r.rows[0] && r.rows[0].active ? 'granted' : 'denied';
        } catch { access = 'denied'; }
      } else if (s.key === 'zc' || s.key === 'wms') {
        access = me.role === 'superadmin' || (myAccess && myAccess.includes(s.key)) ? 'login' : 'denied';
      }
      out.push({ ...s, access });
    }
    return { systems: out };
  });
}
