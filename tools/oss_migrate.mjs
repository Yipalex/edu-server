// 存量上传文件迁移到 OSS：/opt/edu-apps/data/uploads/yj/** → 桶 key edu/yj/**
// 用法（容器内）：node tools/oss_migrate.mjs [--dry]
// 只上传、不删本地（本地留作备份，确认无误后可另行清理）
import fs from 'node:fs';
import path from 'node:path';
import { ossPut, ossExists, ossKeyForAppPath } from '../src/oss.js';
import { config } from '../src/config.js';

const root = path.join(config.uploadDir, 'yj');
const dry = process.argv.includes('--dry');

if (!config.oss.keyId || !config.oss.bucket) {
  console.error('OSS 未配置（缺 OSS_ACCESS_KEY_ID / OSS_BUCKET 等）');
  process.exit(1);
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.heic': 'image/heic', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.pdf': 'application/pdf',
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const files = walk(root);
console.log(`共 ${files.length} 个文件，根目录 ${root}${dry ? '（DRY-RUN）' : ''}`);

let ok = 0, skip = 0, fail = 0;
for (const abs of files) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const key = ossKeyForAppPath('yj', rel);
  const ct = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  try {
    if (!dry) {
      if (await ossExists(key)) { skip++; console.log(`SKIP 已存在 ${key}`); continue; }
      await ossPut(key, fs.readFileSync(abs), ct);
    }
    ok++;
    console.log(`OK   ${key}`);
  } catch (e) {
    fail++;
    console.error(`FAIL ${key}: ${e.message}`);
  }
}
console.log(`完成：上传 ${ok}，跳过 ${skip}，失败 ${fail}`);
process.exit(fail ? 2 : 0);
