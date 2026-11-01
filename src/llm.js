// LLM OpenAI 兼容转发（仅 yj，需 JWT）；stream 时 SSE 原样透传
import { Readable } from 'node:stream';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { errorBody } from './util.js';

function hasImage(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    if (!m) return false;
    if (Array.isArray(m.content))
      return m.content.some((c) => c && (c.type === 'image_url' || c.image_url));
    return false;
  });
}

export function registerLlmRoutes(fastify) {
  // GET /api/yj/llm/models
  fastify.get('/api/yj/llm/models', async (req) => {
    requireAuth(req, 'yj');
    const { text, vision } = config.llm;
    return [
      { id: text.model, supportsImages: false, disabled: !text.apiKey },
      { id: vision.model, supportsImages: true, disabled: !vision.apiKey },
    ];
  });

  // POST /api/yj/llm/test —— 测试大模型连通性（已登录即可调用）
  // 用于：用户填完 .env 的 LLM_*_API_KEY 后，点按钮验证 key 是否有效
  fastify.post('/api/yj/llm/test', async (req, reply) => {
    requireAuth(req, 'yj');
    const { kind } = req.body || {};
    const kinds = kind && kind !== 'all' ? [kind] : ['text', 'vision'];
    const out = {};
    for (const k of kinds) {
      const cfg = config.llm[k];
      const r = { kind: k, model: cfg.model, baseUrl: cfg.baseUrl, configured: !!(cfg.apiKey && cfg.baseUrl) };
      if (!cfg.apiKey || !cfg.baseUrl) {
        r.ok = false;
        r.error = '未配置（请在 .env 填写 LLM_' + (k === 'text' ? '' : 'VISION_') + 'API_KEY 与 *_BASE_URL）';
        out[k] = r;
        continue;
      }
      try {
        const promptMsg = k === 'vision'
          ? [{ role: 'user', content: [{ type: 'text', text: '回复"OK"两个字符即可' }] }]
          : [{ role: 'user', content: '回复"OK"两个字符即可' }];
        const upstream = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ model: cfg.model, messages: promptMsg, stream: false, max_tokens: 16 }),
        });
        if (!upstream.ok) {
          const t = await upstream.text().catch(() => '');
          let msg = `上游返回 HTTP ${upstream.status}`;
          try { const j = JSON.parse(t); msg = j.error?.message || msg; } catch {}
          r.ok = false; r.error = msg;
        } else {
          const j = await upstream.json();
          const reply = j.choices?.[0]?.message?.content || '';
          r.ok = true; r.reply = String(reply).slice(0, 60);
          r.usage = j.usage || null;
        }
      } catch (e) {
        r.ok = false; r.error = String(e?.message || e);
      }
      out[k] = r;
    }
    return out;  // 形如 { text:{...}, vision:{...} }
  });

  // POST /api/yj/llm/chat/completions
  fastify.post('/api/yj/llm/chat/completions', async (req, reply) => {
    requireAuth(req, 'yj');
    const { model, messages, stream, response_format } = req.body || {};
    if (!Array.isArray(messages) || !messages.length)
      return reply.code(400).send(errorBody('messages 不能为空'));

    const useVision = hasImage(messages);
    const cfg = useVision ? config.llm.vision : config.llm.text;
    if (!cfg.apiKey || !cfg.baseUrl)
      return reply.code(503).send(errorBody('大模型未配置'));

    const upstream = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: model || cfg.model,
        messages,
        stream: !!stream,
        ...(response_format ? { response_format } : {}),
      }),
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      let msg = `上游模型服务错误 HTTP ${upstream.status}`;
      try {
        const j = JSON.parse(text);
        msg = j.error?.message || msg;
      } catch {}
      return reply.code(502).send(errorBody(msg));
    }

    if (stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      Readable.fromWeb(upstream.body).pipe(reply.raw);
      return;
    }
    return upstream.json();
  });
}
