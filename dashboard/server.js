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
 *   GET  /api/business/search?q=    Google Places candidates for a business
 *   POST /api/requests/:id/business { placeId }  fetch reviews + photos, attach to request
 *   DELETE /api/requests/:id/business            detach business data
 *   GET  /business/:id/*            serve fetched business photos
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { createZip } = require('./lib/zip');
const { buildPrompt, parseOutput, FILES } = require('./lib/prompt');
const { generateSite } = require('./lib/template');
const llm = require('./lib/llm');
const places = require('./lib/places');
const { Inbox } = require('./lib/inbox');
const paypal = require('./lib/paypal');
const quality = require('./lib/quality');
const { browserCheck, isAvailable: browserAvailable } = require('./lib/browsercheck');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SURVEY = path.join(ROOT, '..', 'survey');
const DATA = path.join(ROOT, 'data');
const REQUESTS = path.join(DATA, 'requests');
const BUILDS = path.join(DATA, 'builds');
const BUSINESS = path.join(DATA, 'business');
const UPLOADS = path.join(DATA, 'uploads');

// config.json is committed; config.local.json (git-ignored) overrides it, e.g. for API keys.
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
try {
  const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8'));
  for (const [k, v] of Object.entries(local)) {
    config[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(config[k] || {}), ...v } : v;
  }
} catch { /* no local overrides */ }
const PORT = Number(process.env.PORT || config.port || 4321);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8'
};

for (const d of [REQUESTS, BUILDS, BUSINESS, UPLOADS]) fs.mkdirSync(d, { recursive: true });

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
  r.business = r.business || { name: r.businessName || '', location: r.businessLocation || '', usePublicData: r.usePublicData !== false };
  r.domain = r.domain || { name: r.domainName || '', registrar: r.domainRegistrar || '', canGiveAccess: !!r.domainAccess };
  r.files = Array.isArray(r.files) ? r.files : [];
  r.payment = r.payment && typeof r.payment === 'object' ? r.payment : null;
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

const safeFileName = (n) => String(n || 'file').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'file';

/** Normalize, unpack embedded files to data/uploads/<id>/, save. Returns the stored request. */
async function importRequest(raw, meta = {}) {
  const r = normalizeRequest(raw);
  const existing = await getRequest(r.id);
  if (existing) return existing;               // already imported (same id)
  const dir = path.join(UPLOADS, r.id);
  const files = [];
  const used = new Set();
  for (const f of r.files) {
    if (!f || !f.name) continue;
    let name = safeFileName(f.name);
    while (used.has(name)) name = name.replace(/(\.[^.]*)?$/, (ext) => `_${used.size}${ext}`);
    used.add(name);
    const entry = { name, type: f.type || '', size: f.size || 0, width: f.width, height: f.height, kind: f.kind || (String(f.type).startsWith('image/') ? 'image' : 'document') };
    const m = /^data:([^;]+);base64,(.+)$/s.exec(f.dataUrl || '');
    if (m) {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, name), Buffer.from(m[2], 'base64'));
      entry.stored = true;
    } else {
      entry.stored = false;                      // metadata only (files omitted by sender)
    }
    files.push(entry);
  }
  r.files = files;
  if (r.payment && paypal.isConfigured(config)) {
    try {
      const v = await paypal.verifyPayment(config, r.payment, { amount: config.paypal?.expectedAmount, currency: config.paypal?.expectedCurrency });
      r.payment = { ...r.payment, verified: v.verified, verifiedAt: new Date().toISOString(), verifyReason: v.reason || '', verifiedStatus: v.status || '' };
    } catch (err) {
      r.payment = { ...r.payment, verified: null, verifyReason: err.message };
    }
  }
  r.importedAt = new Date().toISOString();
  r.importSource = meta.source || 'api';
  if (meta.file) r.importFile = meta.file;
  if (meta.submissionId) r.netlifySubmissionId = meta.submissionId;
  await saveRequest(r);
  return r;
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

// ── business data (Google Places) ───────────────────────────────────
const bizFile = (id) => path.join(BUSINESS, id, 'business.json');
const bizPhotoDir = (id) => path.join(BUSINESS, id, 'photos');

async function getBusiness(id) {
  try { return JSON.parse(await fsp.readFile(bizFile(id), 'utf8')); } catch { return null; }
}

async function attachBusiness(id, placeId) {
  await fsp.mkdir(path.join(BUSINESS, id), { recursive: true });
  const data = await places.details(config, placeId, bizPhotoDir(id));
  await fsp.writeFile(bizFile(id), JSON.stringify(data, null, 2));
  return data;
}

// Write site files plus assets (business photos, client uploads) into a directory.
async function materialize(dir, files, id, business, uploads) {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), content);
  if (business?.photos?.length || uploads.length) {
    await fsp.mkdir(path.join(dir, 'assets'), { recursive: true });
    for (const ph of (business?.photos || [])) await fsp.copyFile(path.join(bizPhotoDir(id), ph.file), path.join(dir, 'assets', ph.file)).catch(() => {});
    for (const f of uploads) await fsp.copyFile(path.join(UPLOADS, id, f.name), path.join(dir, 'assets', f.name)).catch(() => {});
  }
}

// ── build (SSE) ─────────────────────────────────────────────────────
const activeBuilds = new Map(); // id → AbortController

async function handleBuild(req, res, id) {
  const request = await getRequest(id);
  if (!request) return send(res, 404, { error: 'Request not found' });

  let body = {};
  try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* ignore */ }
  const feedback = (body.feedback || '').trim();
  const modelOverride = typeof body.model === 'string' && /^[\w.:\-\/]+$/.test(body.model) ? body.model : null;

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
  const business = request.business?.usePublicData === false ? null : await getBusiness(id);
  const uploads = (request.files || []).filter(f => f.stored);
  const assets = [...(business?.photos || []).map(p => p.file), ...uploads.map(f => f.name)];
  const basePrompt = buildPrompt(request, feedback, business, uploads);
  const ctx = { request, assets, reviews: business?.reviews || [] };
  let files, provider = 'template', model = 'built-in', warnings = [], report = null, attempts = 0, fixes = [], bestDir = null, screenshots = {};

  // One generation pass: model → parse → fill gaps → auto-fix → check
  const generateOnce = async (promptText) => {
    attempts++;
    const { text, provider: p, model: m } = await llm.generate(promptText, {
      config, modelOverride,
      signal: ac.signal,
      onStatus: (message) => emit('status', { message }),
      onToken: (_t, total) => emit('progress', { chars: total })
    });
    emit('status', { message: 'Parsing generated files' });
    let parsed = parseOutput(text);
    let fullText = text;
    // Truncated stream (no END marker or files missing): regenerate before grading, up to 2 extra tries
    for (let tries = 0; !parsed.complete && tries < 2 && !ac.signal.aborted; tries++) {
      emit('status', { message: `Output was incomplete (${parsed.missing.length ? 'missing ' + parsed.missing.join(', ') : 'no end marker'}). Regenerating.` });
      const again = await llm.generate(promptText, { config, modelOverride, signal: ac.signal, onStatus: (message) => emit('status', { message }), onToken: (_t, total) => emit('progress', { chars: total }) });
      const p2 = parseOutput(again.text);
      if (p2.complete || Object.keys(p2.files).length > Object.keys(parsed.files).length) { parsed = p2; fullText = again.text; }
    }
    let out = parsed.files;
    const w = [];
    if (parsed.missing.length) {
      const fallback = generateSite(request, business, uploads);
      for (const f of parsed.missing) out[f] = fallback[f];
      w.push(`Model did not return ${parsed.missing.join(', ')}; filled from template.`);
    }
    out = Object.fromEntries(FILES.map(f => [f, out[f]]));
    await fsp.writeFile(path.join(BUILDS, id, `last-raw-output-${attempts}.txt`), fullText).catch(() => {});
    const fixed = quality.autoFix(out, ctx);
    const rep = quality.check(fixed.files, ctx);
    // Render in a real browser (desktop + mobile) when Chrome is available
    const attemptDir = path.join(BUILDS, id, `.attempt-${attempts}`);
    await materialize(attemptDir, fixed.files, id, business, uploads);
    let shots = {};
    if (browserAvailable()) {
      emit('status', { message: 'Rendering in Chrome (desktop and mobile)' });
      try {
        const br = await browserCheck(attemptDir);
        rep.errors.push(...br.errors);
        rep.warnings.push(...br.warnings);
        rep.ok = rep.ok && br.errors.length === 0;
        rep.score = Math.max(0, rep.score - br.errors.length * 15 - br.warnings.length * 4);
        shots = br.screenshots;
      } catch (err) { rep.warnings.push(`Browser check failed: ${err.message}`); }
    }
    // Brief coverage: a short second pass listing requested items the page lacks
    let missing = [];
    try {
      emit('status', { message: 'Reviewing the page against the brief' });
      const review = await llm.generate(quality.coveragePrompt(request, fixed.files['index.html']), { config, modelOverride, signal: ac.signal, onToken: () => {}, onStatus: () => {} });
      missing = quality.parseCoverage(review.text);
    } catch (err) { if (ac.signal.aborted) throw err; }
    rep.missing = missing;
    rep.score = Math.max(0, rep.score - missing.length * 8);
    rep.ok = rep.ok && missing.length === 0;
    return { files: fixed.files, provider: p, model: m, warnings: w, fixes: fixed.fixes, report: rep, dir: attemptDir, screenshots: shots };
  };

  try {
    emit('status', { message: 'Contacting model' });
    await fsp.mkdir(path.join(BUILDS, id), { recursive: true });
    let best = await generateOnce(basePrompt);
    emit('status', { message: `Quality check: ${best.report.score}/100, ${best.report.errors.length} error(s), ${best.report.warnings.length} warning(s), ${best.report.missing.length} item(s) missing from the brief` });

    // One retry if hard checks failed or the brief is not fully covered.
    if (!best.report.ok && !ac.signal.aborted) {
      emit('status', { message: 'Asking the model for a corrected version.' });
      const issues = [...best.report.errors.map(e => `- ${e}`), ...best.report.missing.map(m => `- Missing from the brief: ${m}`)];
      const retryPrompt = basePrompt + `\n\nYOUR PREVIOUS ATTEMPT HAD THESE PROBLEMS. Fix every one of them, keep everything else that was good, and output the complete three files again:\n${issues.join('\n')}\n`;
      try {
        const second = await generateOnce(retryPrompt);
        emit('status', { message: `Retry quality check: ${second.report.score}/100, ${second.report.errors.length} error(s), ${second.report.missing.length} missing` });
        if (second.report.score >= best.report.score) best = second;
      } catch (err) {
        if (ac.signal.aborted) throw err;
        emit('status', { message: `Retry failed (${err.message}). Keeping first version.` });
      }
    }
    ({ files, provider, model, warnings, fixes, report, dir: bestDir, screenshots } = best);
    if (fixes.length) warnings.push(`Auto-fixed: ${fixes.join('; ')}.`);
  } catch (err) {
    if (ac.signal.aborted) { clearInterval(ping); return res.end(); }
    if (!err.noModel) console.error('[build]', err);
    emit('status', { message: `${err.message}. Using the built-in template generator.` });
    files = generateSite(request, business, uploads);
    const fixed = quality.autoFix(files, ctx);
    files = fixed.files;
    report = quality.check(files, ctx);
    warnings.push(`No model output (${err.message}). Built with the template generator instead.`);
  }

  // Persist as new version
  const versions = await listBuilds(id);
  const version = (versions.at(-1)?.version || 0) + 1;
  const dir = path.join(BUILDS, id, `v${version}`);
  if (bestDir) await fsp.rename(bestDir, dir);
  else await materialize(dir, files, id, business, uploads);
  // Clean up other attempts
  for (const n of await fsp.readdir(path.join(BUILDS, id)).catch(() => [])) {
    if (n.startsWith('.attempt-')) await fsp.rm(path.join(BUILDS, id, n), { recursive: true, force: true });
  }

  const meta = {
    version, provider, model, feedback, warnings,
    business: business ? { name: business.name, rating: business.rating, reviews: business.reviews.length, photos: business.photos.length } : null,
    uploads: uploads.length,
    attempts,
    quality: report,
    screenshots,
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
  try {
    for (const f of await fsp.readdir(path.join(dir, 'assets'))) {
      entries.push({ name: `assets/${f}`, data: await fsp.readFile(path.join(dir, 'assets', f)) });
    }
  } catch { /* no assets */ }
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
- assets/      photos (if any)

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

// ── inbox (watched folders + Netlify Forms) ─────────────────────────
const inbox = new Inbox({ config, dataDir: DATA, importRequest });

// ── router ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // API
    if (p === '/api/status' && req.method === 'GET') {
      return send(res, 200, { ok: true, providers: await llm.providersStatus(config), places: places.isConfigured(config), paypalVerify: paypal.isConfigured(config), config: { ollamaModel: config.ollama.model, port: PORT } });
    }
    if (p === '/api/requests' && req.method === 'GET') return send(res, 200, await listRequests());
    if (p === '/api/inbox' && req.method === 'GET') return send(res, 200, inbox.status());
    if (p === '/api/inbox/sync' && req.method === 'POST') {
      const fromFolders = await inbox.scanFolders();
      let fromNetlify = [], netlifyError = null;
      if (inbox.netlifyConfigured()) { try { fromNetlify = await inbox.syncNetlify(); } catch (err) { netlifyError = err.message; } }
      return send(res, 200, { imported: [...fromFolders, ...fromNetlify], netlifyError, status: inbox.status() });
    }
    if (p === '/api/requests' && req.method === 'POST') {
      let json;
      try { json = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
      const items = Array.isArray(json) ? json : [json];
      const imported = [], errors = [];
      for (const raw of items) {
        try { const r = await importRequest(raw, { source: 'upload' }); imported.push(r.id); }
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
        await fsp.rm(path.join(BUSINESS, id), { recursive: true, force: true });
        await fsp.rm(path.join(UPLOADS, id), { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
    }
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)\/verify-payment$/)) && req.method === 'POST') {
      const r = await getRequest(m[1]);
      if (!r) return send(res, 404, { error: 'Request not found' });
      if (!r.payment) return send(res, 400, { error: 'No payment recorded on this request' });
      if (!paypal.isConfigured(config)) return send(res, 400, { error: 'PayPal credentials not configured. Add paypal.clientId and paypal.clientSecret to config.local.json.' });
      const v = await paypal.verifyPayment(config, r.payment, { amount: config.paypal?.expectedAmount, currency: config.paypal?.expectedCurrency });
      r.payment = { ...r.payment, verified: v.verified, verifiedAt: new Date().toISOString(), verifyReason: v.reason || '', verifiedStatus: v.status || '' };
      await saveRequest(r);
      return send(res, 200, { payment: r.payment });
    }
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)\/build$/)) && req.method === 'POST') return handleBuild(req, res, m[1]);
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)\/builds$/)) && req.method === 'GET') return send(res, 200, await listBuilds(m[1]));
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)\/zip$/)) && req.method === 'GET') return handleZip(res, m[1], url.searchParams.get('v'));

    if (p === '/api/business/search' && req.method === 'GET') {
      if (!places.isConfigured(config)) return send(res, 400, { error: 'Google Places API key is not configured. Add googlePlaces.apiKey to config.json.' });
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 400, { error: 'Missing q' });
      return send(res, 200, { candidates: await places.search(config, q) });
    }
    if ((m = p.match(/^\/api\/requests\/([\w\-]+)\/business$/))) {
      const id = m[1];
      if (!(await getRequest(id))) return send(res, 404, { error: 'Request not found' });
      if (req.method === 'GET') return send(res, 200, { business: await getBusiness(id), configured: places.isConfigured(config) });
      if (req.method === 'POST') {
        if (!places.isConfigured(config)) return send(res, 400, { error: 'Google Places API key is not configured. Add googlePlaces.apiKey to config.json.' });
        let body = {}; try { body = JSON.parse(await readBody(req)); } catch { /* ignore */ }
        if (!body.placeId) return send(res, 400, { error: 'Missing placeId' });
        return send(res, 200, { business: await attachBusiness(id, body.placeId) });
      }
      if (req.method === 'DELETE') { await fsp.rm(path.join(BUSINESS, id), { recursive: true, force: true }); return send(res, 200, { ok: true }); }
    }

    // Static: builds, survey, dashboard
    if (p.startsWith('/builds/')) return serveStatic(res, BUILDS, decodeURIComponent(p.slice('/builds/'.length)));
    if (p.startsWith('/business/')) return serveStatic(res, BUSINESS, decodeURIComponent(p.slice('/business/'.length)));
    if (p.startsWith('/uploads/')) return serveStatic(res, UPLOADS, decodeURIComponent(p.slice('/uploads/'.length)));
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
  inbox.start();
  console.log(`\n  Website Studio dashboard\n  http://localhost:${PORT}\n  survey (local copy): http://localhost:${PORT}/survey/\n  Ollama: ${config.ollama.baseUrl} (${config.ollama.model})\n  Watching for survey files in: ${inbox.folders.join(', ')}\n  Netlify Forms inbox: ${inbox.netlifyConfigured() ? 'configured' : 'not configured'}\n`);
});
