// 喜报推送：老师登记学费记录即推送（2026-11-04 起改为登记即推，不再等财务审核）
// 规则：仅学费登记触发；每单仅推一次（records.xibao_sent_at 幂等）；发送失败不阻断登记
// 保留审核钩子作为幂等兜底：登记后审核通过不会重复推；2026-11 前未推的历史单若日后审核仍会计入
// Webhook 配置优先级：环境变量 XIBAO_WEBHOOK > 容器内 /app/config/xibao.json（均不入代码库、不回显）
import fs from 'node:fs';
import { getPool } from './db.js';

const CONFIG_PATH = '/app/config/xibao.json';
let cachedWebhook = null;
let cacheAt = 0;

export function loadWebhook() {
  if (process.env.XIBAO_WEBHOOK) return process.env.XIBAO_WEBHOOK;
  const now = Date.now();
  if (cachedWebhook && now - cacheAt < 60_000) return cachedWebhook;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cachedWebhook = (cfg && cfg.webhook) || null;
  } catch {
    cachedWebhook = null;
  }
  cacheAt = now;
  return cachedWebhook;
}

/** 业务日期 → 中文日期（2026-11-01 → 2026年11月1日） */
function cnDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return String(s || '');
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

function fmtAmount(n) {
  const v = Number(n);
  if (!isFinite(v)) return String(n == null ? '' : n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** 组装喜报文本（模板见 PRD V1.0 附录 B，字段顺序与文案固定） */
export function buildXibaoText(rec, monthNth) {
  const d = rec.payload || {};
  const feeType = d.fee_type || '';
  // 类型行：老师自填多行文本优先；留空按学费类型兜底（新签 → 新生）
  let typeLine = (d.typenote || '').trim();
  if (!typeLine) typeLine = feeType === '新签' ? '新生' : feeType;
  const m = /(\d{4})-(\d{2})/.exec(rec.month || (d.pay_date || ''));
  const monthLabel = m ? `${Number(m[2])}月` : '本月';
  return [
    '🎉 喜报｜喜报！ 🎉',
    '业绩冲锋🏆势破万军',
    `📌 学员姓名：${d.student || ''}`,
    `📚 课程类型：${d.course_type || ''}`,
    `💰 成交金额：${fmtAmount(d.amount)}`,
    `📅 成交日期：${cnDate(d.pay_date)}`,
    `跟进老师🎖️：${d.commission_to || rec.owner_name || ''}`,
    `👩‍🏫 授课老师：${d.teacher || ''}`,
    `🤝 成交来源：${d.source || ''}`,
    `- 类型:${typeLine}`,
    `[發]业绩累计：这是我${monthLabel}的第${monthNth}单`,
  ].join('\n');
}

async function postWebhook(webhook, text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.errcode !== undefined && data.errcode !== 0)) {
      throw new Error(`webhook 返回 errcode=${data.errcode ?? res.status}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/* ============ 消息中心写入（与 workspace.js 共用 messages 表） ============ */
export async function pushMessage(pool, userId, kind, title, body) {
  if (!userId) return;
  try {
    await pool.query(
      'INSERT INTO messages (user_id, kind, title, body) VALUES ($1, $2, $3, $4)',
      [String(userId), kind, String(title || '').slice(0, 200), String(body || '').slice(0, 2000)]
    );
  } catch (e) {
    // 消息写入失败只记日志，绝不影响主流程
    console.warn('[xibao] pushMessage failed:', e.message);
  }
}

/**
 * 核心推送：对单条学费记录推喜报（幂等：xibao_sent_at 已置位则跳过）
 * @param {string} via 触发来源（登记/核算），仅影响消息文案
 */
async function pushXibaoForRow(pool, req, row, via) {
  const d = row.payload || {};
  const webhook = loadWebhook();
  if (!webhook) {
    req.log && req.log.warn('[xibao] webhook 未配置，跳过推送 record=%s', row.id);
    await pushMessage(pool, row.owner_id, 'xibao_skip', '喜报未推送',
      `学员「${d.student || ''}」学费已${via}，但喜报机器人未配置 webhook，请联系 IT 管理员。`);
    return;
  }

  /* 本月第 N 单：按跟进老师（提成归属人）统计当月有效单（待审核+已核算，退回除外，含本单） */
  const nthR = await pool.query(
    `SELECT COUNT(*)::int AS n FROM records
     WHERE type = 'tuition' AND status IN ('pending','accounted') AND month = $1
       AND COALESCE(payload->>'commission_to', owner_name) = $2`,
    [row.month, d.commission_to || row.owner_name || '']
  );
  const text = buildXibaoText(row, nthR.rows[0] ? nthR.rows[0].n : 1);
  await postWebhook(webhook, text);
  await pool.query('UPDATE records SET xibao_sent_at = now() WHERE id = $1', [row.id]);
  await pushMessage(pool, row.owner_id, 'xibao', '喜报已推送 🎉',
    `学员「${d.student || ''}」${fmtAmount(d.amount)} 元学费已${via}，喜报已推送到群。`);
  req.log && req.log.info('[xibao] pushed record=%s nth=%s via=%s', row.id, nthR.rows[0] && nthR.rows[0].n, via);
}

/**
 * 记录创建钩子（由 dbroutes 在 records INSERT 成功后调用，fire-and-forget）
 * 2026-11-04 起：老师登记学费 → 立即推喜报，无需等待审核
 */
export async function onRecordsCreated(app, req, rows = []) {
  if (app !== 'yj' || !rows.length) return;
  const pool = getPool(app);
  for (const row of rows) {
    try {
      if (!row || row.type !== 'tuition') continue;
      if (row.xibao_sent_at) continue; // 幂等：每单仅一次
      await pushXibaoForRow(pool, req, row, '登记');
    } catch (e) {
      req.log && req.log.warn('[xibao] push failed record=%s: %s', row && row.id, e.message);
      await pushMessage(pool, row.owner_id, 'xibao_fail', '喜报推送失败',
        '学费已登记，但喜报推送失败，请 IT 检查机器人配置。');
    }
  }
}

/**
 * 记录状态变更钩子（由 dbroutes 在 records UPDATE 成功后调用，fire-and-forget）
 * 登记即推之后，此处仅作幂等兜底：登记时已推的单不会再推；
 * 2026-11 前未推的历史积压单若日后审核通过，在此补推
 */
export async function onRecordsStatusChange(app, req, { set = {}, before = [], afterRows = [] }) {
  if (app !== 'yj' || !set.status) return;
  const pool = getPool(app);

  /* 退回 → 给填报人发消息（persist，进消息中心） */
  if (set.status === 'returned') {
    for (const row of afterRows) {
      await pushMessage(pool, row.owner_id, 'returned', '记录被退回',
        `${row.owner_name || ''}的「学费/登记」记录被退回。${set.remark ? '原因：' + String(set.remark).replace(/^退回原因：/, '') : '请联系财务核对。'}`);
    }
    return;
  }

  /* 审核通过 → 学费登记补推喜报（登记时已推过的会被 xibao_sent_at 幂等跳过） */
  if (set.status !== 'accounted') return;
  const beforeById = new Map((before || []).map((b) => [String(b.id), b]));
  for (const row of afterRows) {
    try {
      if (row.type !== 'tuition') continue;
      if (row.xibao_sent_at) continue; // 幂等：每单仅一次
      const prev = beforeById.get(String(row.id));
      if (prev && prev.status !== 'pending') continue; // 只认首次通过
      await pushXibaoForRow(pool, req, row, '核算');
    } catch (e) {
      req.log && req.log.warn('[xibao] push failed record=%s: %s', row.id, e.message);
      await pushMessage(pool, row.owner_id, 'xibao_fail', '喜报推送失败',
        '学费已核算，但喜报推送失败，请 IT 检查机器人配置。');
    }
  }
}
