#!/usr/bin/env node
'use strict';
/**
 * Website Studio: local dashboard server. Zero dependencies.
 *
 *   node server.js            → http://localhost:4321
 *
 * Routes
 *   GET  /                          dashboard UI
 *   GET  /survey/                   local copy of the public survey (same origin → shared localStorage)
 *   GET  /api/status                provider status
 *   GET  /api/requests              list requests
 *   POST /api/requests              import one request or an array (JSON body)
 *   DELETE /api/requests/:id        remove a request (and its builds)
 *   POST /api/requests/:id/build    build a site (SSE stream)  body: { feedback?: string }
 *   GET  /api/requests/:id/builds   list build versions
 *   GET  /builds/:id/v:N/*          serve a build for preview
 *   GET  /api/requests/:id/zip?v=N  download a build as ZIP
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createZip } = require('./lib/zip');
const { buildPrompt, parseOutput, FILES } = require('./lib/prompt');
const { generateSite } = require('./lib/template');
const llm = require('./lib/llm');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SURVEY = path.join(ROOT, '..', 'survey');
const DATA = path.join(ROOT, 'data');
const REQUESTS = path.join(DATA, 'requests');
const BUILDS = path.join(DATA, 'builds');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = Number(process.env.PORT || config.port || 4321);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

for (const d of [REQUESTS, BUILDS]) fs.mkdirSync(d, { recursive: true });

// ── helpers ─────────────────────────────────────────────────────────
const safeId = (id) => /^[\w\-]{1,80}$/.test(id);

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    ...headers
  });
  res.end(data);
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function serveStatic(res, baseDir, rel) {
  let p = path.normalize(path.join(baseDir, rel));
  if (!p.startsWith(baseDir)) return send(res, 403, 'Forbidden');
  try {
    let st = await fsp.stat(p);
    if (st.isDirectory()) { p = path.join(p, 'index.html'); st = await fsp.stat(p); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

function slugify(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'client';
}

// ── requests store ──────────────────────────────────────────────────
function normalizeRequest(raw) {
  // Accept the survey shape; tolerate flat shapes from hand-edited files.
  const r = { ...raw };
  r.client = r.client || { fullName: r.fullName, email: r.email, location: r.location, title: r.title, bio: r.bio };
  r.website = r.website || { type: r.websiteType, description: r.description, stylePreferences: r.stylePreferences || [], colorPreference: r.colorPreference };
  r.social = r.social || { github: r.github, linkedin: r.linkedin, twitter: r.twitter, currentWebsite: r.currentWebsite };
  r.extraNotes = r.extraNotes || '';
  if (!r.client.fullName || !r.client.email) throw new Error('Request needs client.fullName and client.email');
  if (!r.id || !safeId(r.id)) r.id = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  r.submittedAt = r.submittedAt || new Date().toISOString();
  r.importedAt = r.importedAt || new Date().toISOString();
  return r;
}

async function listRequests() {
  const names = (await fsp.readdir(REQUESTS)).filter(n => n.endsWith('.json'));
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(await fsp.readFile(path.join(REQUESTS, n), 'utf8'))); } catch { /* skip bad file */ }
  }
  for (const r of out) r.builds = await listBuilds(r.id);
  out.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
  return out;
}

async function getRequest(id) {
  if (!safeId(id)) return null;
  try { return JSON.parse(await fsp.readFile(path.join(REQUESTS, `${id}.json`), 'utf8')); } catch { return null; }
}

async function saveRequest(r) {
  await fsp.writeFile(path.join(REQUESTS, `${r.id}.json`), JSON.stringify(r, null, 2));
}

async function listBuilds(id) {
  const dir = path.join(BUILDS, id);
  try {
    const vs = (await fsp.readdir(dir)).filter(n => /^v\d+$/.test(n));
    const out = [];
    for (const v of vs) {
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(dir, v, 'build.json'), 'utf8')); } catch { /* ignore */ }
      out.push({ version: Number(v.slice(1)), ...meta });
    }
    return out.sort((a, b) => a.version - b.version);
  } catch { return []; }
}

// ── build (SSE) ─────────────────────────────────────────────────────
const activeBuilds = new Map(); // id → AbortController

async function handleBuild(req, res, id) {
  const request = await getRequest(id);
  if (!request) return send(res, 404, { error: 'Request not found' });

  let body = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
  const feedback = (body.feedback || '').trim();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  activeBuilds.get(id)?.abort();
  const ac = new AbortController();
  activeBuilds.set(id, ac);
  req.on('close', () => ac.abort());

  const started = Date.now();
  const prompt = buildPrompt(request, feedback);
  let files, provider = 'template', model = 'built-in', warnings = [];

  try {
    emit('status', { message: 'Contacting local model' });
    const { text, provider: p, model: m } = await llm.generate(prompt, {
      config,
      signal: ac.signal,
      onStatus: (message) => emit('status', { message }),
      onToken: (_t, total) => emit('progress', { chars: total })
    });
    provider = p; model = m;

    emit('status', { message: 'Parsing generated files' });
    const parsed = parseOutput(text);
    files = parsed.files;
    if (parsed.missing.length) {
      const fallback = generateSite(request);
      for (const f of parsed.missing) files[f] = fallback[f];
      warnings.push(`Model did not return ${parsed.missing.join(', ')}; filled from template.`);
    }
    // Keep only the 3 known files (ignore hallucinated extras)
    files = Object.fromEntries(FILES.map(f => [f, files[f]]));
    await fsp.writeFile(path.join(BUILDS, id, 'last-raw-output.txt'), text).catch(() => {});
  } catch (err) {
    if (ac.signal.aborted) { clearInterval(ping); return res.end(); }
    if (!err.noModel) console.error('[build]', err);
    emit('status', { message: `${err.message}. Using the built-in template generator.` });
    files = generateSite(request);
    warnings.push(`No model output (${err.message}). Built with the template generator instead.`);
  }

  // Persist as new version
  const versions = await listBuilds(id);
  const version = (versions.at(-1)?.version || 0) + 1;
  const dir = path.join(BUILDS, id, `v${version}`);
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), content);

  const meta = {
    version, provider, model, feedback, warnings,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    sizes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.byteLength(v)]))
  };
  await fsp.writeFile(path.join(dir, 'build.json'), JSON.stringify(meta, null, 2));

  clearInterval(ping);
  activeBuilds.delete(id);
  emit('done', { build: meta, previewUrl: `/builds/${id}/v${version}/index.html` });
  res.end();
}

// ── ZIP ─────────────────────────────────────────────────────────────
async function handleZip(res, id, v) {
  const request = await getRequest(id);
  if (!request) return send(res, 404, { error: 'Request not found' });
  const builds = await listBuilds(id);
  const version = v ? Number(v) : builds.at(-1)?.version;
  if (!version || !builds.find(b => b.version === version)) return send(res, 404, { error: 'Build not found' });

  const dir = path.join(BUILDS, id, `v${version}`);
  const entries = [];
  for (const f of FILES) {
    try { entries.push({ name: f, data: await fsp.readFile(path.join(dir, f)) }); } catch { /* skip */ }
  }
  const c = request.client;
  entries.push({
    name: 'README.txt',
    data: `Website for ${c.fullName}
Built ${new Date().toISOString().slice(0, 10)}, version ${version}

HOW TO USE
1. Unzip this folder.
2. Open index.html in any browser to preview.
3. To publish, upload all files to any static host
   (Netlify, Vercel, GitHub Pages, Cloudflare Pages, or your own hosting).

FILES
- index.html   the page
- styles.css   styling
- script.js    interactions

Text marked [Add ...] is a placeholder. Replace it with your own content.
`
  });

  const zip = createZip(entries);
  const filename = `${slugify(c.fullName)}-website-v${version}.zip`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': zip.length,
    'X-Client-Email': c.email
  });
  res.end(zip);
}

// ── router ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // API
    if (p === '/api/status' && req.method === 'GET') {
      return send(res, 200, { ok: true, providers: await llm.providersStatus(config), config: { ollamaModel: config.ollama.model, port: PORT } });
    }
    if (p === '/api/requests' && req.method === 'GET') return send(res, 200, await listRequests());
    if (p === '/api/requests' && req.method === 'POST') {
      let json;
      try { json = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const items = Array.isArray(json) ? json : [json];
      const imported = [], errors = [];
      for (const raw of items) {
        try { const r = normalizeRequest(raw); await saveRequest(r); imported.push(r.id); }
        catch (err) { errors.push(err.message); }
      }
      return send(res, 200, { imported, errors });
    }

    let m;
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)$/))) {
      const id = m[1];
      if (req.method === 'GET') { const r = await getRequest(id); return r ? send(res, 200, { ...r, builds: await listBuilds(id) }) : send(res, 404, { error: 'Not found' }); }
      if (req.method === 'DELETE') {
        await fsp.rm(path.join(REQUESTS, `${id}.json`), { force: true });
        await fsp.rm(path.join(BUILDS, id), { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
    }
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)\/build$/)) && req.method === 'POST') return handleBuild(req, res, m[1]);
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)\/builds$/)) && req.method === 'GET') return send(res, 200, await listBuilds(m[1]));
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)\/zip$/)) && req.method === 'GET') return handleZip(res, m[1], url.searchParams.get('v'));

    // Static: builds, survey, dashboard
    if (p.startsWith('/builds/')) return serveStatic(res, BUILDS, decodeURIComponent(p.slice('/builds/'.length)));
    if (p === '/survey') { res.writeHead(302, { Location: '/survey/' }); return res.end(); }
    if (p.startsWith('/survey/')) return serveStatic(res, SURVEY, decodeURIComponent(p.slice('/survey/'.length)) || 'index.html');
    return serveStatic(res, PUBLIC, decodeURIComponent(p === '/' ? 'index.html' : p.slice(1)));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Website Studio dashboard\n  http://localhost:${PORT}\n  survey (local copy): http://localhost:${PORT}/survey/\n  Ollama: ${config.ollama.baseUrl} (${config.ollama.model})\n`);
});
