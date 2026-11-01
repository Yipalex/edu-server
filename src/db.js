// 每应用一个 pg 连接池（懒创建：数据库暂不可用时服务照常启动，首次请求才报错）
import pg from 'pg';
import { config } from './config.js';

// bigint(int8) 在安全整数范围内返回 number，超出保持 string（与 PostgREST 行为一致，避免前端比较出错）
pg.types.setTypeParser(20, (v) => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
});

const pools = new Map();

export function getPool(app) {
  let pool = pools.get(app);
  if (!pool) {
    const database = config.dbs[app];
    if (!database) throw new Error(`unknown app: ${app}`);
    pool = new pg.Pool({
      host: config.pg.host,
      port: config.pg.port,
      user: config.pg.user,
      password: config.pg.password,
      database,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error(`pg pool error [${app}]:`, err.message);
    });
    pools.set(app, pool);
  }
  return pool;
}

// ---- RPC 函数签名缓存（用于重载解析与命名参数调用） ----
// sigs: Map<fnName, Array<{ oid, pronargs, pronargdefaults, argNames: string[], retset: boolean }>>
const sigCache = new Map();

export async function loadFunctionSigs(app, fnNames) {
  const pool = getPool(app);
  const r = await pool.query(
    `SELECT p.oid, p.proname AS name, p.pronargs, p.pronargdefaults, p.proretset,
            COALESCE(p.proargnames, '{}'::text[]) AS argnames
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [fnNames]
  );
  const sigs = new Map();
  for (const row of r.rows) {
    const entry = {
      oid: row.oid,
      argNames: row.argnames.slice(0, row.pronargs),
      requiredCount: row.pronargs - row.pronargdefaults,
      retset: row.proretset,
    };
    if (!sigs.has(row.name)) sigs.set(row.name, []);
    sigs.get(row.name).push(entry);
  }
  sigCache.set(app, sigs);
  return sigs;
}

/**
 * 取函数签名（带缓存，未命中时刷新一次再判断）。
 * 返回 { overloads } 或 null（函数不存在）。
 */
export async function getFunctionSigs(app, fnName, whitelist) {
  let sigs = sigCache.get(app);
  if (!sigs) {
    sigs = await loadFunctionSigs(app, whitelist);
  }
  let overloads = sigs.get(fnName);
  if (!overloads) {
    // 刷新一次（可能在服务启动后新建了函数）
    sigs = await loadFunctionSigs(app, whitelist);
    overloads = sigs.get(fnName);
  }
  return overloads || null;
}

/**
 * 重载解析：请求 body 的 key 集合能覆盖某重载的全部必填参数、且不含未知参数，
 * 则匹配；多个匹配时选参数总数最多的那个。
 * 返回 { argNames, values, retset } 或抛错。
 */
export function resolveOverload(overloads, body) {
  const provided = Object.keys(body).filter((k) => body[k] !== undefined);
  const matches = [];
  for (const ov of overloads) {
    const required = ov.argNames.slice(0, ov.requiredCount);
    const known = new Set(ov.argNames);
    if (provided.some((k) => !known.has(k))) continue;      // 含未知参数
    if (required.some((k) => !provided.includes(k))) continue; // 缺必填参数
    matches.push(ov);
  }
  if (matches.length === 0) {
    throw new Error(`参数与函数签名不匹配（可选参数: ${overloads.map((o) => o.argNames.join(',')).join(' | ')}）`);
  }
  matches.sort((a, b) => b.argNames.length - a.argNames.length);
  const ov = matches[0];
  // 按函数声明顺序取已提供的参数（命名参数表示法，缺省参数走 DEFAULT）
  const used = ov.argNames.filter((n) => provided.includes(n));
  return { argNames: used, values: used.map((n) => body[n]), retset: ov.retset };
}

export async function closePools() {
  for (const pool of pools.values()) {
    await pool.end().catch(() => {});
  }
  pools.clear();
}
