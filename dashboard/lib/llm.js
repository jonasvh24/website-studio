'use strict';
/**
 * Local model chain:
 *   1. Ollama            (http://localhost:11434, streaming)
 *   2. OpenAI-compatible (Kimi / Moonshot, LM Studio, llama.cpp server, vLLM…)
 *   3. caller falls back to the built-in template generator
 *
 * generate(prompt, { config, onToken, onStatus, signal }) → { text, provider, model }
 */

const SYSTEM = 'You are an expert web developer. You output only the requested files in the exact format asked, with no commentary.';

async function ollamaModels(base) {
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const json = await res.json();
  return (json.models || []).map(m => m.name);
}

const IDLE_MS = 90000;   // abort a stream that sends nothing for this long

async function readNdjson(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    let timer;
    const idle = new Promise((_, reject) => { timer = setTimeout(() => { reader.cancel().catch(() => {}); reject(new Error(`no data for ${IDLE_MS / 1000}s (connection stalled)`)); }, IDLE_MS); });
    const { value, done } = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf.trim());
}

async function viaOllama(prompt, opts) {
  const { ollama, onStatus, signal, modelOverride } = opts;
  const base = ollama.baseUrl.replace(/\/$/, '');
  const available = await ollamaModels(base);
  if (!available.length) throw new Error('Ollama is running but has no models pulled.');

  // Explicit override, else configured model if present, else closest match, else first available.
  const want = modelOverride || ollama.model;
  const model = available.includes(want) ? want
    : available.find(m => m.startsWith(want.split(':')[0])) || available[0];

  // Cloud models depend on the network: retry once, then fall back to a local model if configured.
  const isCloud = /cloud/.test(model);
  const fallback = ollama.fallbackModel && available.includes(ollama.fallbackModel) && ollama.fallbackModel !== model ? ollama.fallbackModel : null;
  const tries = isCloud ? [model, model, ...(fallback ? [fallback] : [])] : [model];
  let lastErr;
  for (let i = 0; i < tries.length; i++) {
    const m = tries[i];
    if (i > 0) onStatus?.(`${tries[i - 1]} failed (${lastErr.message}). ${m === tries[i - 1] ? 'Retrying.' : `Falling back to ${m}.`}`);
    try { return await ollamaChat(base, m, prompt, opts); }
    catch (err) { if (err.name === 'AbortError' || signal?.aborted) throw err; lastErr = err; }
  }
  throw lastErr;
}

async function ollamaChat(base, model, prompt, { ollama, onToken, onStatus, signal }) {
  onStatus?.(`Ollama: ${model}`);

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      options: {
        temperature: ollama.temperature ?? 0.4,
        num_ctx: ollama.numCtx ?? 16384,
        num_predict: ollama.maxTokens ?? 8192
      },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!res.ok) throw new Error(`Ollama chat HTTP ${res.status}: ${await res.text()}`);

  let text = '';
  await readNdjson(res, (line) => {
    let j; try { j = JSON.parse(line); } catch { return; }
    if (j.error) throw new Error(j.error);
    const t = j.message?.content || '';
    if (t) { text += t; onToken?.(t, text.length); }
  });
  return { text, provider: 'ollama', model };
}

function compatKey(openai) {
  return openai.apiKey || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || process.env.OPENAI_API_KEY || '';
}

// Preference order when model is "auto": newest Kimi generation first.
const KIMI_PREFERENCE = [/k3/i, /k2[.\-]?5/i, /k2.*think/i, /k2/i, /kimi-latest/i, /kimi/i];

async function compatModels(openai) {
  const base = openai.baseUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${compatKey(openai) || 'local'}` }, signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`${openai.label || 'Endpoint'} models HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map(m => m.id).filter(Boolean);
}

function pickCompatModel(openai, available) {
  if (openai.model && openai.model !== 'auto') return openai.model;
  for (const re of KIMI_PREFERENCE) {
    const hits = available.filter(id => re.test(id)).sort().reverse();
    if (hits.length) return hits[0];
  }
  return available[0];
}

async function viaOpenAICompat(prompt, { openai, onToken, onStatus, signal, modelOverride }) {
  const base = openai.baseUrl.replace(/\/$/, '');
  const apiKey = compatKey(openai) || 'local';
  let model = modelOverride;
  if (!model) {
    const available = await compatModels(openai).catch(() => []);
    model = available.length ? pickCompatModel(openai, available) : (openai.model === 'auto' ? 'kimi-latest' : openai.model);
  }
  openai = { ...openai, model };
  onStatus?.(`${openai.label || 'OpenAI-compatible'}: ${openai.model}`);

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal,
    body: JSON.stringify({
      model: openai.model,
      stream: true,
      temperature: openai.temperature ?? 0.4,
      max_tokens: openai.maxTokens ?? 8192,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!res.ok) throw new Error(`${openai.label || 'Endpoint'} HTTP ${res.status}: ${await res.text()}`);

  let text = '';
  await readNdjson(res, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let j; try { j = JSON.parse(payload); } catch { return; }
    const t = j.choices?.[0]?.delta?.content || '';
    if (t) { text += t; onToken?.(t, text.length); }
  });
  return { text, provider: 'openai-compatible', model: openai.model };
}

/**
 * Provider order:
 *   modelOverride "kimi:<model>" or "ollama:<model>" forces one provider.
 *   config.provider "kimi" | "ollama" forces one provider.
 *   "auto": Kimi (OpenAI-compatible) first when a key is configured, then Ollama.
 */
function providerOrder(config, modelOverride) {
  const compat = config.openaiCompatible || {};
  const compatReady = compat.enabled !== false && !!compatKey(compat);
  const ollamaReady = config.ollama?.enabled !== false;
  if (modelOverride) {
    const [prov] = modelOverride.split(':');
    if (prov === 'kimi' || prov === 'compat') return ['compat'];
    if (prov === 'ollama') return ['ollama'];
  }
  if (config.provider === 'kimi' || config.provider === 'compat') return ['compat'];
  if (config.provider === 'ollama') return ['ollama'];
  const order = [];
  if (compatReady) order.push('compat');
  if (ollamaReady) order.push('ollama');
  return order;
}

async function generate(prompt, opts) {
  const { config, modelOverride } = opts;
  const errors = [];
  const bare = modelOverride ? modelOverride.replace(/^(kimi|compat|ollama):/, '') : null;

  for (const prov of providerOrder(config, modelOverride)) {
    try {
      if (prov === 'compat') return await viaOpenAICompat(prompt, { ...opts, openai: config.openaiCompatible, modelOverride: bare });
      if (prov === 'ollama') return await viaOllama(prompt, { ...opts, ollama: config.ollama, modelOverride: bare });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      const label = prov === 'compat' ? (config.openaiCompatible.label || 'Endpoint') : 'Ollama';
      errors.push(`${label}: ${err.message}`);
      opts.onStatus?.(`${label} unavailable (${err.message}). Trying next provider.`);
    }
  }

  const e = new Error('No model available. ' + errors.join(' | '));
  e.noModel = true;
  throw e;
}

async function providersStatus(config) {
  const compat = config.openaiCompatible || {};
  const out = {
    ollama: { ok: false, models: [] },
    openaiCompatible: { ok: false, enabled: compat.enabled !== false, hasKey: !!compatKey(compat), label: compat.label || 'Endpoint', models: [] },
    order: providerOrder(config, null)
  };
  try {
    const models = await ollamaModels(config.ollama.baseUrl.replace(/\/$/, ''));
    out.ollama = { ok: true, models, preferred: config.ollama.model };
  } catch (err) { out.ollama.error = err.message; }

  if (out.openaiCompatible.enabled && out.openaiCompatible.hasKey) {
    try {
      const models = await compatModels(compat);
      out.openaiCompatible.ok = true;
      out.openaiCompatible.models = models.filter(m => /kimi|moonshot/i.test(m)).length ? models.filter(m => /kimi|moonshot/i.test(m)) : models;
      out.openaiCompatible.preferred = pickCompatModel(compat, models);
    } catch (err) { out.openaiCompatible.error = err.message; }
  }
  return out;
}

module.exports = { generate, providersStatus };
