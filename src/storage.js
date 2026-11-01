// 文件存储（仅 yj）：上传 → 阿里云 OSS（同地域内网直推），OSS 不可用时回退本地落盘；
// 下载签名：已入桶文件直接返回 OSS 公网 URL（桶公共读），未迁移的旧文件走 HMAC 签名本地代理
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { loadYjRole } from './policies.js';
import { getPool } from './db.js';
import { hmacSha256Hex, base64url, unbase64url, errorBody } from './util.js';
import { ossPut, ossExists, ossPublicUrl, ossKeyForAppPath } from './oss.js';

const PATH_RE = /^[A-Za-z0-9_./-]+$/;

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.heic': 'image/heic',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp4': 'video/mp4',
};

function safePath(p) {
  return typeof p === 'string' && PATH_RE.test(p) && !p.includes('..') && !p.startsWith('/');
}

function makeToken(filePath) {
  const exp = Date.now() + config.fileUrlTtlMs;
  const payload = `${base64url(filePath)}.${exp}`;
  const sig = hmacSha256Hex(config.fileSignSecret, payload);
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [b64, expStr, sig] = parts;
  const payload = `${b64}.${expStr}`;
  const expect = hmacSha256Hex(config.fileSignSecret, payload);
  if (sig.length !== expect.length || !crypto_timingSafeEq(sig, expect)) return null;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const filePath = unbase64url(b64);
  return safePath(filePath) ? filePath : null;
}

function crypto_timingSafeEq(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function registerStorageRoutes(fastify) {
  const root = path.join(config.uploadDir, 'yj');

  // POST /api/yj/storage/upload （multipart，字段 path + file）
  // 注意：必须在 for await 循环内就地消费 file 流，否则 busboy 背压会让请求永久挂起
  // （表现为 nginx upstream timed out → 504，且文件不落盘）。
  // 文件先缓冲到内存（上限同 multipart fileSize 15MB），随后直推 OSS；OSS 失败回退本地盘。
  fastify.post('/api/yj/storage/upload', async (req, reply) => {
    requireAuth(req, 'yj');

    const parts = req.parts();
    let relPath = null;
    let chunks = [];
    let bufSize = 0;
    let truncated = false;
    const MAX_BUF = 15 * 1024 * 1024;
    try {
      for await (const part of parts) {
        if (part.type === 'file') {
          for await (const chunk of part.file) {
            bufSize += chunk.length;
            if (bufSize > MAX_BUF) { truncated = true; break; }
            chunks.push(chunk);
          }
          truncated = truncated || !!part.file.truncated;
        } else if (part.fieldname === 'path') {
          relPath = part.value;
        }
      }
    } catch (e) {
      const msg = String(e && e.message || '');
      if (/too large|file size|limit/i.test(msg))
        return reply.code(413).send(errorBody('文件超出大小限制'));
      return reply.code(400).send(errorBody('文件接收失败：' + (msg || '未知错误')));
    }

    if (!relPath || !safePath(relPath)) {
      return reply.code(400).send(errorBody('path 不合法（只允许字母数字 _ / -，禁止 ..）'));
    }
    if (!chunks.length) return reply.code(400).send(errorBody('缺少文件'));
    if (truncated) return reply.code(413).send(errorBody('文件超出大小限制'));

    const buf = Buffer.concat(chunks);
    const ext = path.extname(relPath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const key = ossKeyForAppPath('yj', relPath);

    try {
      await ossPut(key, buf, contentType);
      return { path: relPath, url: ossPublicUrl(key), storage: 'oss' };
    } catch (e) {
      req.log.error({ err: e }, 'OSS 上传失败，回退本地盘');
    }

    // 回退：本地落盘（保持旧行为）
    const abs = path.join(root, relPath);
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
    } catch (e) {
      req.log.error({ err: e }, '上传落盘失败');
      return reply.code(500).send(errorBody('文件保存失败，请重试'));
    }
    return { path: relPath, storage: 'local' };
  });

  // GET /api/yj/storage/sign?path=... → {url}
  fastify.get('/api/yj/storage/sign', async (req, reply) => {
    const user = requireAuth(req, 'yj');
    const p = req.query.path;
    if (!p || !safePath(p)) return reply.code(400).send(errorBody('path 不合法'));

    const owner = p.split('/')[0];
    if (owner !== user.id) {
      const role = await loadYjRole(getPool('yj'), user.id).catch(() => 'staff');
      if (!['leader', 'finance'].includes(role))
        return reply.code(403).send(errorBody('只能访问自己的文件'));
    }
    // 已入桶的文件直接给 OSS 公网地址（无需签名、不占 VPS 带宽）
    const key = ossKeyForAppPath('yj', p);
    if (await ossExists(key)) return { url: ossPublicUrl(key), storage: 'oss' };
    return { url: `/api/yj/files/${makeToken(p)}`, storage: 'local' };
  });

  // GET /api/yj/files/:token —— 校验签名与过期后流式返回
  fastify.get('/api/yj/files/:token', async (req, reply) => {
    const filePath = verifyToken(req.params.token);
    if (!filePath) return reply.code(403).send(errorBody('链接无效或已过期'));
    const abs = path.join(root, filePath);
    let stat;
    try {
      stat = await fsp.stat(abs);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      return reply.code(404).send(errorBody('文件不存在'));
    }
    const ext = path.extname(abs).toLowerCase();
    reply.header('Content-Type', MIME[ext] || 'application/octet-stream');
    reply.header('Content-Length', stat.size);
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(fs.createReadStream(abs));
  });
}
