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

async function readNdjson(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
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

async function viaOllama(prompt, { ollama, onToken, onStatus, signal }) {
  const base = ollama.baseUrl.replace(/\/$/, '');
  const available = await ollamaModels(base);
  if (!available.length) throw new Error('Ollama is running but has no models pulled.');

  // Use configured model if present; otherwise the first available.
  const model = available.includes(ollama.model) ? ollama.model
    : available.find(m => m.startsWith(ollama.model.split(':')[0])) || available[0];

  onStatus?.(`Ollama · ${model}`);

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

async function viaOpenAICompat(prompt, { openai, onToken, onStatus, signal }) {
  const base = openai.baseUrl.replace(/\/$/, '');
  const apiKey = openai.apiKey || process.env.KIMI_API_KEY || process.env.OPENAI_API_KEY || 'local';
  onStatus?.(`${openai.label || 'OpenAI-compatible'} · ${openai.model}`);

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

async function generate(prompt, opts) {
  const { config } = opts;
  const errors = [];

  if (config.ollama?.enabled !== false) {
    try {
      return await viaOllama(prompt, { ...opts, ollama: config.ollama });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      errors.push(`Ollama: ${err.message}`);
      opts.onStatus?.(`Ollama unavailable (${err.message}). Trying fallback…`);
    }
  }

  if (config.openaiCompatible?.enabled) {
    try {
      return await viaOpenAICompat(prompt, { ...opts, openai: config.openaiCompatible });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      errors.push(`${config.openaiCompatible.label || 'Fallback'}: ${err.message}`);
    }
  }

  const e = new Error('No model available. ' + errors.join(' | '));
  e.noModel = true;
  throw e;
}

async function providersStatus(config) {
  const out = { ollama: { ok: false }, openaiCompatible: { ok: false, enabled: !!config.openaiCompatible?.enabled } };
  try {
    const models = await ollamaModels(config.ollama.baseUrl.replace(/\/$/, ''));
    out.ollama = { ok: true, models, preferred: config.ollama.model };
  } catch (err) { out.ollama.error = err.message; }

  if (config.openaiCompatible?.enabled) {
    try {
      const res = await fetch(`${config.openaiCompatible.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${config.openaiCompatible.apiKey || process.env.KIMI_API_KEY || 'local'}` },
        signal: AbortSignal.timeout(3000)
      });
      out.openaiCompatible.ok = res.ok;
      out.openaiCompatible.label = config.openaiCompatible.label;
      out.openaiCompatible.model = config.openaiCompatible.model;
    } catch (err) { out.openaiCompatible.error = err.message; }
  }
  return out;
}

module.exports = { generate, providersStatus };
