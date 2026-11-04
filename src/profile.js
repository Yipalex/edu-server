// 个人资料：头像上传 + 姓名/手机号修改（2026-11-04）
//
// 设计要点：
// 1. 头像存**各系统自己的 users.avatar_data**（base64 PNG，无 data URI 前缀）。
//    为什么不存文件：5 个系统分属 3 个后端（zexi-api / wms-api / zc-server），
//    文件共享要跨容器拷贝，复杂且易碎；存库则「同步」= 复制一段文本，最可靠。
//    前端负责裁剪压缩（canvas 居中裁正方形 → 256px PNG），服务端只做校验落库，
//    避免服务端引入图像处理依赖（服务器无 sharp）。
// 2. 头像读取端点公开（GET /api/{app}/avatars/:userId），方便 <img> 直接引用；
//    只暴露图片本身，不泄露手机号等资料。
// 3. 手机号是跨系统登录标识（quan.users.phone / wms.users.username / zc.username），
//    改手机号必须**全系统联动**，由 accountsync 的 syncPhone 统一广播。
import bcrypt from 'bcryptjs';
import { getPool } from './db.js';
import { requireAuth } from './auth.js';
import { isPhone, errorBody } from './util.js';
import { ensureCols, syncPhone, syncAvatar } from './accountsync.js';

const MAX_BYTES = 3 * 1024 * 1024;      // 上传上限 3MB（前端已压缩，一般 < 200KB）
const MAX_SIDE = 1024;                   // 允许的最大边长（前端会缩到 256）

/** 校验 PNG 并读出尺寸 */
function readPngSize(buf) {
  if (buf.length < 24) throw new Error('BAD_PNG');
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('BAD_PNG');
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('BAD_PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 注册个人资料路由（yj / quan 共用；jz 无登录体系不挂）
 * - GET  /api/{app}/auth/profile        当前资料（姓名/手机号/头像）
 * - POST /api/{app}/auth/avatar         上传头像（multipart，字段名 file；须为 PNG）
 * - POST /api/{app}/auth/profile        修改姓名/手机号（改手机号需校验原密码）
 * - GET  /api/{app}/avatars/:userId     读取头像（公开，仅图片）
 */
export function registerProfileRoutes(app, fastify) {
  // 头像读取（公开，仅返回图片）
  fastify.get(`/api/${app}/avatars/:userId`, async (req, reply) => {
    const userId = String(req.params.userId || '');
    if (!userId || userId.length > 64) return reply.code(404).send(errorBody('头像不存在'));
    try {
      const r = await getPool(app).query(
        'SELECT avatar_data, avatar_updated_at FROM users WHERE id = $1', [userId]
      );
      const u = r.rows[0];
      if (!u || !u.avatar_data) return reply.code(404).send(errorBody('头像不存在'));
      reply.header('Content-Type', 'image/png');
      reply.header('Cache-Control', 'public, max-age=300');
      return reply.send(Buffer.from(u.avatar_data, 'base64'));
    } catch {
      return reply.code(404).send(errorBody('头像不存在'));
    }
  });

  // 当前资料
  fastify.get(`/api/${app}/auth/profile`, async (req, reply) => {
    const auth = requireAuth(req, app);
    const r = await getPool(app).query(
      'SELECT id, phone, name, role, active, avatar_updated_at FROM users WHERE id = $1', [auth.id]
    );
    const u = r.rows[0];
    if (!u) return reply.code(404).send(errorBody('账号不存在'));
    return {
      user: {
        id: u.id, phone: u.phone, name: u.name, role: u.role, active: u.active,
        has_avatar: !!u.avatar_updated_at,
        avatar_url: `/api/${app}/avatars/${encodeURIComponent(u.id)}?v=${u.avatar_updated_at ? new Date(u.avatar_updated_at).getTime() : 0}`,
      },
    };
  });

  // 上传头像
  fastify.post(`/api/${app}/auth/avatar`, async (req, reply) => {
    const auth = requireAuth(req, app);
    let file;
    try {
      file = await req.file({ limits: { fileSize: MAX_BYTES, files: 1 } });
    } catch {
      return reply.code(400).send(errorBody('图片太大，请选择 3MB 以内的图片'));
    }
    if (!file) return reply.code(400).send(errorBody('请选择要上传的图片'));
    const mime = String(file.mimetype || '');
    if (mime && !/^image\//.test(mime)) {
      return reply.code(400).send(errorBody('请上传图片文件'));
    }
    let buf;
    try {
      buf = await file.toBuffer();
    } catch {
      return reply.code(400).send(errorBody('图片太大，请选择 3MB 以内的图片'));
    }
    if (!buf.length) return reply.code(400).send(errorBody('图片内容为空'));
    let dim;
    try {
      dim = readPngSize(buf);
    } catch {
      return reply.code(400).send(errorBody('图片格式无法识别，请重新选择图片'));
    }
    if (dim.width > MAX_SIDE || dim.height > MAX_SIDE) {
      return reply.code(400).send(errorBody('图片尺寸过大，请重新选择'));
    }
    const b64 = buf.toString('base64');
    await ensureCols(app);
    await getPool(app).query(
      'UPDATE users SET avatar_data = $1, avatar_updated_at = now() WHERE id = $2', [b64, auth.id]
    );
    // 广播到其他已开通系统（同一头像，全站生效）
    try {
      const master = await getMasterByPhone(u.phone);
      if (master && (master.system_access || []).length) await syncAvatar(master, b64);
    } catch (e) { req.log.warn('跨系统头像同步失败: %s', e.message); }
    const now = Date.now();
    return { ok: true, avatar_url: `/api/${app}/avatars/${encodeURIComponent(auth.id)}?v=${now}` };
  });

  // 修改姓名 / 手机号
  fastify.post(`/api/${app}/auth/profile`, async (req, reply) => {
    const auth = requireAuth(req, app);
    const { name, phone, oldPassword } = req.body || {};
    const r = await getPool(app).query(
      'SELECT id, phone, name, password_hash FROM users WHERE id = $1', [auth.id]
    );
    const u = r.rows[0];
    if (!u) return reply.code(404).send(errorBody('账号不存在'));

    const newName = name === undefined || name === null ? u.name : String(name).trim();
    if (!newName) return reply.code(400).send(errorBody('姓名不能为空'));
    if (newName.length > 30) return reply.code(400).send(errorBody('姓名最多 30 个字'));

    const newPhone = phone === undefined || phone === null ? u.phone : String(phone).trim();
    if (newPhone !== u.phone) {
      if (!isPhone(newPhone)) return reply.code(400).send(errorBody('请输入正确的 11 位手机号'));
      // 新手机号不能被占用
      const dup = await getPool(app).query('SELECT id FROM users WHERE phone = $1 AND id <> $2', [newPhone, auth.id]);
      if (dup.rows.length) return reply.code(409).send(errorBody('该手机号已被其他账号使用'));
      // 必须校验原密码（防止拿到会话就改登录标识）
      if (!oldPassword || !(await bcrypt.compare(String(oldPassword), u.password_hash)))
        return reply.code(400).send(errorBody('原密码错误'));
    }

    await getPool(app).query('UPDATE users SET name = $1, phone = $2 WHERE id = $3', [newName, newPhone, auth.id]);
    // quan 的 staff 表冗余了 phone/name
    if (app === 'quan') {
      await getPool('quan').query('UPDATE staff SET name = $1, phone = $2 WHERE owner_id = $3', [newName, newPhone, auth.id]);
    }
    // 手机号变更 → 全系统联动（quan 库 + wms username + zc 内部接口）
    // 注意：主账号必须用**改号前**的手机号找（此时库里还是旧号）
    if (newPhone !== u.phone) {
      try {
        const master = await getMasterByPhone(u.phone);
        if (master) await syncPhone(master, newPhone);
      } catch (e) { req.log.error('跨系统手机号同步失败: %s', e.message); }
    }
    return {
      ok: true,
      user: { id: auth.id, phone: newPhone, name: newName },
    };
  });
}

/**
 * 取主库（工作台）用户（含 system_access / system_roles）
 * ⚠️ 必须按**手机号**匹配：quan 等子系统的用户 id 各自生成，与主库 id 不同。
 */
async function getMasterByPhone(phone) {
  if (!phone) return null;
  const r = await getPool('yj').query(
    'SELECT id, phone, name, role, active, system_access, system_roles FROM users WHERE phone = $1', [phone]
  );
  return r.rows[0] || null;
}
