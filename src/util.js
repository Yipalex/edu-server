// 通用小工具
import crypto from 'node:crypto';

/** 生成纯数字雪花风格 ID 字符串（毫秒时间戳 + 3 位随机数） */
export function genId() {
  return Date.now().toString() + String(crypto.randomInt(0, 1000)).padStart(3, '0');
}

/** 标识符（表名/列名）白名单校验 */
export const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
export function isIdent(s) {
  return typeof s === 'string' && IDENT_RE.test(s);
}

export function isPhone(s) {
  return typeof s === 'string' && /^1\d{10}$/.test(s);
}

export function hmacSha256Hex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function base64url(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function unbase64url(s) {
  return Buffer.from(s, 'base64url').toString('utf8');
}

/** 统一错误响应体：{error:{message}} 且顶层带 message，兼容 sdk-adapter 的 !res.ok 分支 */
export function errorBody(message) {
  return { error: { message }, message };
}

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
