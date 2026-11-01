// sf 书法评测报告上传：生成器（静态页）导出 HTML 后一键上传到站点 reports/ 目录，
// 让报告二维码（https://sf.example.com/reports/<id>.html）立即可扫。
//
// 认证：共享密钥（SF_UPLOAD_KEY 环境变量 + 页面配置里的上传密钥），非 JWT——
// sf 是纯静态站无登录体系，密钥只挡随手滥用，不防恶意（页面公开可见密钥属预期折中）。
//
// 校验：
//   - id 必须符合生成器规则 /^r\d{8}-[a-z0-9]{5}$/（防路径穿越）
//   - 大小 ≤ 8MB；内容必须是 HTML 且包含该报告编号（防止传错文件/覆盖他人报告）
//   - 同名覆盖允许（生成器固定 reportId，重复导出需覆盖更新）
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { errorBody } from './util.js';

const ID_RE = /^r\d{8}-[a-z0-9]{5}$/;
const MAX_BYTES = 8 * 1024 * 1024;
/* 生产环境页面与接口同源（nginx 反代），本不需要 CORS；
   放开 * 仅为了方便从其它端口/域名测试，安全由上传密钥保证 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-zx-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function registerSfReportRoutes(fastify) {
  fastify.options('/api/sf/reports/upload', async (req, reply) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => reply.header(k, v));
    return reply.code(204).send();
  });

  fastify.post('/api/sf/reports/upload', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => reply.header(k, v));
    const key = req.headers['x-zx-key'];
    if (!config.sf.uploadKey || key !== config.sf.uploadKey) {
      return reply.code(401).send(errorBody('上传密钥不正确'));
    }
    const { id, html } = req.body || {};
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      return reply.code(400).send(errorBody('报告编号不合法'));
    }
    if (typeof html !== 'string' || !html.length) {
      return reply.code(400).send(errorBody('报告内容为空'));
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) {
      return reply.code(413).send(errorBody('报告超过 8MB，请压缩照片后重试'));
    }
    if (!/<html[\s>]/i.test(html) || !html.includes(id)) {
      return reply.code(400).send(errorBody('内容不是有效的报告 HTML'));
    }

    const dir = config.sf.reportsDir;
    const file = path.join(dir, id + '.html');
    if (path.dirname(file) !== dir) { // 双保险，防任何路径穿越
      return reply.code(400).send(errorBody('报告编号不合法'));
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, html, 'utf8');
      fs.renameSync(tmp, file); // 原子替换，避免扫到写了一半的文件
      fs.chmodSync(file, 0o644);
    } catch (e) {
      req.log.error('报告写入失败: %s', e.message);
      return reply.code(500).send(errorBody('写入失败：' + e.message));
    }
    return { ok: true, url: '/reports/' + id + '.html' };
  });
}
