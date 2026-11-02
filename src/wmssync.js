// WMS（仓库管理系统）→ 业绩登记系统（yj）物品名录同步
// 数据源：edu-wms 独立 PostgreSQL（只读）；目标：edu_yj.items（条码/名称/类目/规格 + status）
//
// 同步规则（wms 为唯一准绳）：
//   1. wms 侧有码物品（排除 merged）按条码对齐：已存在→更新名称/类目/规格/状态；不存在→新增
//   2. yj 侧条码在 wms 找不到、但名称能唯一匹配某 wms 物品且目标条码未被占用 → 重指条码（修复条码错配）
//   3. 其余 yj 侧条码在 wms 不存在的记录 → 标记 status='deprecated'（前端隐藏；不删除，遵守数据红线）
//   4. wms 侧 retired 物品同步为 deprecated；merged 物品由保留项（keeper）同步，自身跳过
//
// 配置来源（优先级从高到低）：
//   环境变量 WMS_PGHOST / WMS_PGPORT / WMS_PGUSER / WMS_PGPASSWORD / WMS_PGDATABASE
//   容器内配置文件（由 WMS_SYNC_CONFIG 指定路径，默认 /app/config/wms-sync.json，不进代码库）
// 两者都没有时同步功能静默停用（服务照常启动，手动/自动同步均报错或不执行）。
import fs from 'node:fs';
import pg from 'pg';
import { getPool } from './db.js';
import { requireSuperAdmin } from './auth.js';
import { errorBody } from './util.js';

const SYNC_LOCK_KEY = 723317; // 'wms-sync-items' 事务级咨询锁，防手动/自动并发双跑
const AUTO_INTERVAL_MS = 10 * 60 * 1000; // 自动同步：每 10 分钟
const BOOT_DELAY_MS = 15 * 1000;         // 启动后延迟首次同步，等服务/网络就绪

let wmsPool = null;
let resolvedCfg = null;
let resolveTried = false;

function resolveWmsConfig() {
  if (resolveTried) return resolvedCfg;
  resolveTried = true;
  const env = process.env;
  const cfg = {
    host: env.WMS_PGHOST || '',
    port: parseInt(env.WMS_PGPORT || '5432', 10),
    user: env.WMS_PGUSER || '',
    password: env.WMS_PGPASSWORD || '',
    database: env.WMS_PGDATABASE || '',
  };
  if (!cfg.host || !cfg.password) {
    // 兜底：容器内配置文件（部署时 docker cp 注入，不提交代码库）
    const file = env.WMS_SYNC_CONFIG || '/app/config/wms-sync.json';
    try {
      const fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!cfg.host) cfg.host = fileCfg.host || '';
      if (!cfg.user) cfg.user = fileCfg.user || '';
      if (!cfg.password) cfg.password = fileCfg.password || '';
      if (!cfg.database) cfg.database = fileCfg.database || '';
    } catch { /* 配置文件不存在则保持未配置 */ }
  }
  if (!cfg.host || !cfg.password) { resolvedCfg = null; return null; }
  if (!cfg.user) cfg.user = 'edu_wms';
  if (!cfg.database) cfg.database = 'edu_wms';
  resolvedCfg = cfg;
  return resolvedCfg;
}

function getWmsPool(cfg) {
  if (!wmsPool) {
    wmsPool = new pg.Pool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      max: 3,
      connectionTimeoutMillis: 5000,
    });
    wmsPool.on('error', (err) => console.error('[wmssync] wms pool error:', err.message));
  }
  return wmsPool;
}

/** 执行一次同步，返回统计对象 */
export async function syncItemsFromWms() {
  const cfg = resolveWmsConfig();
  if (!cfg) throw new Error('WMS 数据库未配置（缺少 WMS_PGHOST/WMS_PGPASSWORD 或 wms-sync.json）');
  const wms = getWmsPool(cfg);
  const src = await wms.query(
    `SELECT i.barcode::text AS barcode, i.name, c.name AS category,
            NULLIF(i.spec, '') AS spec, i.status::text AS status
       FROM items i
       JOIN categories c ON c.id = i.category_id
      WHERE i.barcode IS NOT NULL AND i.status <> 'merged'`
  );
  const wmsItems = src.rows;
  const stats = { total: wmsItems.length, added: 0, updated: 0, repointed: 0, deprecated: 0, unchanged: 0 };

  const yj = getPool('yj');
  const client = await yj.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY]);
    // status 列：先查再改（edu 账号非表属主，列已存在时 ALTER 会报 must be owner）
    const colCheck = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'items' AND column_name = 'status'`
    );
    if (!colCheck.rows.length) {
      await client.query(`ALTER TABLE items ADD COLUMN status text NOT NULL DEFAULT 'active'`);
    }

    const { rows: existing } = await client.query('SELECT id, barcode, name, category, spec, status FROM items');
    const byBarcode = new Map();
    for (const r of existing) if (r.barcode && !byBarcode.has(r.barcode)) byBarcode.set(r.barcode, r);
    const wmsBarcodes = new Set(wmsItems.map((i) => i.barcode));

    // 1) 按条码对齐：更新既有 / 插入新增
    for (const it of wmsItems) {
      const targetStatus = it.status === 'active' ? 'active' : 'deprecated';
      const cur = byBarcode.get(it.barcode);
      if (cur) {
        const changed =
          cur.name !== it.name ||
          (cur.category || '') !== (it.category || '') ||
          (cur.spec || '') !== (it.spec || '') ||
          (cur.status || 'active') !== targetStatus;
        if (changed) {
          await client.query(
            'UPDATE items SET name=$1, category=$2, spec=$3, status=$4 WHERE id=$5',
            [it.name, it.category, it.spec, targetStatus, cur.id]
          );
          stats.updated++;
        } else {
          stats.unchanged++;
        }
      } else {
        await client.query(
          'INSERT INTO items (barcode, name, category, spec, status) VALUES ($1,$2,$3,$4,$5)',
          [it.barcode, it.name, it.category, it.spec, targetStatus]
        );
        byBarcode.set(it.barcode, { id: 'new' });
        stats.added++;
      }
    }

    // 2) 条码不在 wms 的存量行：名称唯一匹配且目标条码空闲 → 重指条码；否则停用
    const nameIndex = new Map();
    for (const it of wmsItems) {
      if (!nameIndex.has(it.name)) nameIndex.set(it.name, []);
      nameIndex.get(it.name).push(it);
    }
    for (const r of existing) {
      if (wmsBarcodes.has(r.barcode)) continue; // 条码已对齐（含重复条码行），不动
      const cand = nameIndex.get(r.name);
      if (cand && cand.length === 1 && !byBarcode.has(cand[0].barcode)) {
        const t = cand[0];
        await client.query(
          'UPDATE items SET barcode=$1, name=$2, category=$3, spec=$4, status=$5 WHERE id=$6',
          [t.barcode, t.name, t.category, t.spec, t.status === 'active' ? 'active' : 'deprecated', r.id]
        );
        byBarcode.set(t.barcode, r);
        stats.repointed++;
      } else if ((r.status || 'active') !== 'deprecated') {
        await client.query("UPDATE items SET status='deprecated' WHERE id=$1", [r.id]);
        stats.deprecated++;
      }
    }

    await client.query('COMMIT');
    return stats;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 手动同步接口：仅 yj 超级管理员 */
export function registerWmsSyncRoutes(fastify) {
  fastify.post('/api/yj/items/sync-from-wms', async (req, reply) => {
    try {
      requireSuperAdmin(req, 'yj');
    } catch (e) {
      return reply.code(e.statusCode || 401).send(errorBody(e.message));
    }
    try {
      const stats = await syncItemsFromWms();
      req.log.info({ stats }, 'wms items sync (manual)');
      return { ok: true, stats, syncedAt: new Date().toISOString() };
    } catch (e) {
      req.log.error(e);
      return reply.code(502).send(errorBody('同步失败：' + e.message));
    }
  });
}

/** 自动同步：启动后延迟一次 + 每 10 分钟；未配置或失败仅记日志，不影响服务 */
export function startWmsAutoSync(fastify) {
  if (!resolveWmsConfig()) {
    fastify.log.info('[wmssync] WMS 数据库未配置，物品名录自动同步停用');
    return;
  }
  const run = async (trigger) => {
    try {
      const stats = await syncItemsFromWms();
      fastify.log.info({ trigger, ...stats }, 'wms items synced');
    } catch (e) {
      fastify.log.warn({ err: e.message, trigger }, 'wms items sync failed');
    }
  };
  const bootTimer = setTimeout(() => run('boot'), BOOT_DELAY_MS);
  const timer = setInterval(() => run('interval'), AUTO_INTERVAL_MS);
  bootTimer.unref?.();
  timer.unref?.();
}
