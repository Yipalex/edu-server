// Fastify 启动入口：注册全部路由
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config, APPS } from './config.js';
import { registerAuthRoutes, registerAdminRoutes } from './auth.js';
import { registerProfileRoutes } from './profile.js';
import { registerDbRoutes } from './dbroutes.js';
import { registerStorageRoutes } from './storage.js';
import { registerLlmRoutes } from './llm.js';
import { registerSfReportRoutes } from './sfreport.js';
import { registerWmsSyncRoutes, startWmsAutoSync } from './wmssync.js';
import { registerWorkspaceRoutes } from './workspace.js';
import { errorBody } from './util.js';
import { closePools } from './db.js';

const fastify = Fastify({
  logger: true,
  bodyLimit: 15 * 1024 * 1024, // jz 报名表单含 base64 附件
  // 文件签名 URL 的路径参数较长（base64url(路径) + 过期时间 + HMAC），
  // 默认 100 会导致 /api/yj/files/:token 直接 404，这里放宽到 512。
  maxParamLength: 512,
});

await fastify.register(multipart, {
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});
await fastify.register(rateLimit, { global: false });

// 统一错误处理
fastify.setErrorHandler((err, req, reply) => {
  const status = err.statusCode || 500;
  if (status >= 500) req.log.error(err);
  reply.code(status).send(errorBody(err.message || '服务器内部错误'));
});
fastify.setNotFoundHandler((req, reply) => {
  reply.code(404).send(errorBody('接口不存在'));
});

// 应用名合法性校验（/:app 前缀下所有路由；params 在 preHandler 阶段才可用）
fastify.addHook('preHandler', async (req, reply) => {
  const app = req.params?.app;
  if (app !== undefined && !APPS.includes(app)) {
    return reply.code(404).send(errorBody('未知应用'));
  }
});

// 健康检查
fastify.get('/api/health', async () => ({ ok: true }));

// 认证：jz 不需要（注册/登录对 jz 返回 404）
registerAuthRoutes('yj', fastify);
registerAuthRoutes('quan', fastify);
// 个人资料：头像上传 + 姓名/手机号修改（手机号变更全系统联动）
registerProfileRoutes('yj', fastify);
registerProfileRoutes('quan', fastify);
// 账号管理（仅 yj）：列表/开通/停用/启用/删除/重置密码，超管专属
registerAdminRoutes('yj', fastify);

// DB 代理 + RPC 代理（三应用通用，内部按白名单/策略控制）
registerDbRoutes(fastify);

// 存储与 LLM（仅 yj）
registerStorageRoutes(fastify);
registerLlmRoutes(fastify);

// sf 评测报告上传（静态站，共享密钥认证，非 JWT）
registerSfReportRoutes(fastify);

// WMS → yj 物品名录同步（手动按钮 + 每 10 分钟自动，超管专属手动触发）
registerWmsSyncRoutes(fastify);
startWmsAutoSync(fastify);

// 工作台支撑：教师名单 / 消息中心 / 月度目标配置（仅 yj）
registerWorkspaceRoutes(fastify);

const shutdown = async () => {
  await fastify.close();
  await closePools();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await fastify.listen({ port: config.port, host: config.host });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
