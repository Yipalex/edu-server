// 环境变量读取与集中配置
const env = process.env;

export const config = {
  port: parseInt(env.PORT || '3100', 10),
  host: env.HOST || '0.0.0.0',

  pg: {
    host: env.PGHOST || '127.0.0.1',
    port: parseInt(env.PGPORT || '5432', 10),
    user: env.PGUSER || 'postgres',
    password: env.PGPASSWORD || '',
  },
  // 应用名 -> 数据库名
  dbs: {
    yj: env.DB_YJ || 'edu_yj',
    quan: env.DB_QUAN || 'edu_quan',
    jz: env.DB_JZ || 'edu_jz',
  },

  // sf 书法评测报告上传（/api/sf/reports/upload，静态生成器页一键上传用）
  sf: {
    uploadKey: env.SF_UPLOAD_KEY || '',
    reportsDir: env.SF_REPORTS_DIR || '/opt/edu-apps/apps/sf/reports',
  },

  jwtSecret: env.JWT_SECRET || 'dev-insecure-secret-change-me',
  jwtExpires: env.JWT_EXPIRES || '7d',
  bcryptRounds: parseInt(env.BCRYPT_ROUNDS || '10', 10),

  uploadDir: env.UPLOAD_DIR || new URL('../../data/uploads', import.meta.url).pathname,
  fileSignSecret: env.FILE_SIGN_SECRET || 'dev-insecure-file-secret',
  fileUrlTtlMs: 10 * 60 * 1000, // 签名 URL 10 分钟有效

  // 阿里云 OSS（图片/视频等文件直存桶；服务器同地域走内网 endpoint，公网读用 publicBase）
  oss: {
    keyId: env.OSS_ACCESS_KEY_ID || '',
    keySecret: env.OSS_ACCESS_KEY_SECRET || '',
    bucket: env.OSS_BUCKET || '',
    // 服务器侧（内网，免流量费）：oss-cn-shenzhen-internal.aliyuncs.com
    internalEndpoint: env.OSS_INTERNAL_ENDPOINT || '',
    // 公网直读基址（桶公共读）：https://edushuhua.oss-cn-shenzhen.aliyuncs.com
    publicBase: (env.OSS_PUBLIC_BASE || '').replace(/\/+$/, ''),
  },

  llm: {
    text: {
      baseUrl: (env.LLM_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_TEXT_MODEL || '',
    },
    vision: {
      baseUrl: (env.LLM_VISION_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: env.LLM_VISION_API_KEY || '',
      model: env.LLM_VISION_MODEL || '',
    },
  },
};

export const APPS = ['yj', 'quan', 'jz', 'sf'];
