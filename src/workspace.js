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
}
