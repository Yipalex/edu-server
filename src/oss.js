// 阿里云 OSS 直连（OSS REST API + V1 签名，无 SDK 依赖）
// 服务器与 OSS 同地域（深圳），上传/管理走内网 endpoint 免流量费；
// 外网用户读桶（公共读）走公网 endpoint 域名。
import crypto from 'node:crypto';
import https from 'node:https';
import { config } from './config.js';

function hmacSha1(secret, str) {
  return crypto.createHmac('sha1', secret).update(str, 'utf8').digest('base64');
}

function ossEnabled() {
  const o = config.oss;
  return !!(o && o.keyId && o.keySecret && o.bucket && o.internalEndpoint && o.publicBase);
}

// V1 签名：Authorization: OSS AccessKeyId:Signature
// StringToSign = VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders+CanonicalizedResource
function authHeader(method, contentType, date, resource) {
  const o = config.oss;
  const stringToSign = [method, '', contentType || '', date, resource].join('\n');
  return `OSS ${o.keyId}:${hmacSha1(o.keySecret, stringToSign)}`;
}

function request({ method, key, contentType = '', body = null, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const o = config.oss;
    const date = new Date().toUTCString();
    const resource = `/${o.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const req = https.request({
      // OSS 要求虚拟主机风格寻址：bucket.endpoint
      host: `${o.bucket}.${o.internalEndpoint}`,
      path: '/' + key.split('/').map(encodeURIComponent).join('/'),
      method,
      headers: {
        Date: date,
        'Content-Type': contentType,
        Authorization: authHeader(method, contentType, date, resource),
        ...(body && Buffer.isBuffer(body) ? { 'Content-Length': body.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('OSS 请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 上传 Buffer 到 OSS，覆盖同名；成功 resolve，失败 reject
export async function ossPut(key, buf, contentType = 'application/octet-stream') {
  if (!ossEnabled()) throw new Error('OSS 未配置');
  const r = await request({ method: 'PUT', key, contentType, body: buf });
  if (r.status !== 200) {
    throw new Error(`OSS PUT ${key} → ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`);
  }
}

// 对象是否存在（HEAD）
export async function ossExists(key) {
  if (!ossEnabled()) return false;
  try {
    const r = await request({ method: 'HEAD', key });
    return r.status === 200;
  } catch {
    return false;
  }
}

// 对象公网直读 URL（桶为公共读，无需签名）
export function ossPublicUrl(key) {
  const o = config.oss;
  return `${o.publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function ossKeyForAppPath(app, relPath) {
  return `edu/${app}/${relPath}`;
}
