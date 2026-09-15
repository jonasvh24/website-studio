/* Website Studio dashboard — 5-step workflow */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const STORAGE_KEY = 'website_requests';

  const state = {
    step: 1,
    requests: [],
    current: null,       // selected request (with builds)
    version: null,       // selected build version for preview
    feedback: '',        // rebuild feedback carried into the build step
    building: false,
    maxStep: 1           // furthest step reachable
  };

  // ── UI helpers ────────────────────────────────────────────
  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const initials = (name) => (name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // ── Steps ─────────────────────────────────────────────────
  function goto(step) {
    if (step > 1 && !state.current) return toast('Select a request first', true);
    if (step >= 4 && !(state.current?.builds?.length)) return toast('Build the website first', true);
    if (state.building && step !== 3) return toast('A build is in progress', true);

    state.step = step;
    state.maxStep = Math.max(state.maxStep, step);
    for (let i = 1; i <= 5; i++) $(`#panel-${i}`).hidden = i !== step;

    $$('#stepper .step').forEach(el => {
      const n = Number(el.dataset.step);
      el.classList.toggle('active', n === step);
      const reachable = n === 1 || (state.current && n <= 3) || (state.current?.builds?.length && n <= 5);
      el.classList.toggle('done', n !== step && !!reachable);
    });

    if (step === 2) renderReview();
    if (step === 3) renderBuild();
    if (step === 4) renderPreview();
    if (step === 5) renderDeliver();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('#stepper').addEventListener('click', (e) => {
    const el = e.target.closest('.step');
    if (el?.classList.contains('done')) goto(Number(el.dataset.step));
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (b) goto(Number(b.dataset.goto));
  });

  // ── Model status ──────────────────────────────────────────
  async function loadStatus() {
    const pill = $('#modelStatus');
    const dot = $('.status-dot', pill), txt = pill.lastElementChild;
    try {
      const { providers } = await api('/api/status');
      if (providers.ollama.ok) {
        const m = providers.ollama.models.includes(providers.ollama.preferred) ? providers.ollama.preferred : providers.ollama.models[0];
        dot.className = 'status-dot ok'; txt.textContent = `Ollama · ${m}`;
        $('#modelLine').textContent = `Model: Ollama / ${m} · ${providers.ollama.models.length} model(s) available locally`;
      } else if (providers.openaiCompatible.ok) {
        dot.className = 'status-dot ok'; txt.textContent = `${providers.openaiCompatible.label} · ${providers.openaiCompatible.model}`;
        $('#modelLine').textContent = `Ollama offline → using ${providers.openaiCompatible.label}`;
      } else {
        dot.className = 'status-dot warn'; txt.textContent = 'No model · template mode';
        $('#modelLine').textContent = 'No local model reachable — builds will use the built-in template generator. Start Ollama for AI builds.';
      }
    } catch {
      dot.className = 'status-dot bad'; txt.textContent = 'Server unreachable';
    }
  }

  // ── Step 1: requests ──────────────────────────────────────
  async function loadRequests() {
    state.requests = await api('/api/requests');
    renderList();
  }

  function renderList() {
    const list = $('#reqList');
    $('#reqEmpty').hidden = state.requests.length > 0;
    list.innerHTML = state.requests.map(r => {
      const built = r.builds?.length || 0;
      return `
        <div class="req-card ${state.current?.id === r.id ? 'selected' : ''}" data-id="${esc(r.id)}">
          <div class="avatar">${esc(initials(r.client.fullName))}</div>
          <div>
            <div class="name">${esc(r.client.fullName)}
              <span class="tag">${esc(r.website.type || 'Website')}</span>
              ${built ? `<span class="tag green">${built} build${built > 1 ? 's' : ''}</span>` : ''}
            </div>
            <div class="sub">${esc(r.client.email)}${r.client.title ? ' · ' + esc(r.client.title) : ''}${r.client.location ? ' · ' + esc(r.client.location) : ''}</div>
          </div>
          <div class="meta">Submitted<br>${esc(fmtDate(r.submittedAt))}</div>
        </div>`;
    }).join('');
  }

  $('#reqList').addEventListener('click', async (e) => {
    const card = e.target.closest('.req-card');
    if (!card) return;
    await selectRequest(card.dataset.id);
    goto(2);
  });

  async function selectRequest(id) {
    state.current = await api(`/api/requests/${id}`);
    state.version = state.current.builds?.at(-1)?.version || null;
    state.feedback = '';
    renderList();
  }

  async function importObjects(items, sourceLabel) {
    if (!items.length) return toast('Nothing to import', true);
    const { imported, errors } = await api('/api/requests', { method: 'POST', body: JSON.stringify(items) });
    await loadRequests();
    toast(`${imported.length} request(s) imported from ${sourceLabel}${errors.length ? ` · ${errors.length} skipped` : ''}`, imported.length === 0);
  }

  async function importFiles(files) {
    const items = [];
    for (const f of files) {
      try {
        const json = JSON.parse(await f.text());
        (Array.isArray(json) ? json : [json]).forEach(x => items.push(x));
      } catch { toast(`${f.name} is not valid JSON`, true); }
    }
    await importObjects(items, `${files.length} file(s)`);
  }

  $('#importBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
  $('#refreshBtn').addEventListener('click', () => { loadRequests(); loadStatus(); });

  $('#localStorageBtn').addEventListener('click', async () => {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { /* ignore */ }
    if (!Array.isArray(list) || !list.length) {
      return toast('No "website_requests" found in this browser. Fill the survey at /survey/ on this origin, or import the JSON file.', true);
    }
    await importObjects(list, 'browser storage');
  });

  // Drag & drop anywhere on the page
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) dz.classList.remove('over'); }));
  document.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.name.endsWith('.json'));
    if (files.length) { goto(1); importFiles(files); }
  });

  // ── Step 2: review ────────────────────────────────────────
  function kv(label, value, { link = false } = {}) {
    const empty = !value || (Array.isArray(value) && !value.length);
    let v = empty ? '—' : esc(value);
    if (!empty && link) v = `<a href="${esc(value)}" target="_blank" rel="noopener">${esc(value)}</a>`;
    if (!empty && label === 'Email') v = `<a href="mailto:${esc(value)}">${esc(value)}</a>`;
    return `<dt>${label}</dt><dd class="${empty ? 'empty-val' : ''}">${v}</dd>`;
  }

  function renderReview() {
    const r = state.current, c = r.client, w = r.website, s = r.social;
    $('#reviewName').textContent = c.fullName;
    $('#reviewSub').textContent = `${w.type || 'Website'} · submitted ${fmtDate(r.submittedAt)} · ${r.builds?.length || 0} build(s)`;

    const colorHex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(w.colorPreference || '')?.[0];

    $('#reviewGrid').innerHTML = `
      <div class="review-block">
        <h3>Client</h3>
        <dl class="kv">
          ${kv('Full name', c.fullName)}
          ${kv('Email', c.email)}
          ${kv('Location', c.location)}
          ${kv('Title / role', c.title)}
        </dl>
      </div>
      <div class="review-block">
        <h3>Links</h3>
        <dl class="kv">
          ${kv('GitHub', s.github, { link: true })}
          ${kv('LinkedIn', s.linkedin, { link: true })}
          ${kv('Twitter / X', s.twitter, { link: true })}
          ${kv('Current site', s.currentWebsite, { link: true })}
        </dl>
      </div>
      <div class="review-block full">
        <h3>Short bio</h3>
        <p class="prose ${c.bio ? '' : 'empty-val'}">${esc(c.bio || 'No bio provided')}</p>
      </div>
      <div class="review-block full">
        <h3>Website description</h3>
        <p class="prose">${esc(w.description)}</p>
      </div>
      <div class="review-block">
        <h3>Type &amp; style</h3>
        <dl class="kv">
          <dt>Type</dt><dd>${esc(w.type || '—')}</dd>
          <dt>Styles</dt><dd>${(w.stylePreferences || []).length ? `<span class="chip-row">${w.stylePreferences.map(x => `<span class="chip-static">${esc(x)}</span>`).join('')}</span>` : '<span class="empty-val">—</span>'}</dd>
          <dt>Color</dt><dd>${w.colorPreference ? `${colorHex ? `<span class="swatch" style="background:${colorHex}"></span>` : ''}${esc(w.colorPreference)}` : '<span class="empty-val">—</span>'}</dd>
        </dl>
      </div>
      <div class="review-block">
        <h3>Extra notes</h3>
        <p class="prose ${r.extraNotes ? '' : 'empty-val'}">${esc(r.extraNotes || 'None')}</p>
      </div>`;
  }

  $('#deleteBtn').addEventListener('click', async () => {
    if (!confirm(`Delete the request from ${state.current.client.fullName} and all its builds?`)) return;
    await api(`/api/requests/${state.current.id}`, { method: 'DELETE' });
    state.current = null; state.version = null;
    await loadRequests();
    toast('Request deleted');
    goto(1);
  });

  // ── Step 3: build ─────────────────────────────────────────
  function renderBuild() {
    const r = state.current;
    const n = r.builds?.length || 0;
    $('#buildTitle').textContent = n ? `Rebuild website for ${r.client.fullName}` : `Build website for ${r.client.fullName}`;
    $('#buildDesc').textContent = n
      ? `Version ${n} exists. Building again creates version ${n + 1}; earlier versions stay available in the preview.`
      : 'The local model will generate a complete responsive site (HTML + CSS + JS) from everything the client provided.';
    $('#feedbackBox').hidden = !state.feedback;
    $('#feedbackText').textContent = state.feedback;
    $('#buildBtn').querySelector('span').textContent = n ? 'Rebuild Website' : 'Build Website';
    if (!state.building) { $('#progressWrap').hidden = true; $('#buildLog').innerHTML = ''; }
  }

  function log(msg, cls = '') {
    const el = $('#buildLog');
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  $('#buildBtn').addEventListener('click', startBuild);

  async function startBuild() {
    if (state.building) return;
    state.building = true;
    const btn = $('#buildBtn');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span><span>Generating…</span>`;
    $('#buildBackBtn').disabled = true;
    $('#progressWrap').hidden = false;
    $('#buildLog').innerHTML = '';
    const bar = $('#progressBar');
    bar.classList.add('indeterminate');
    bar.firstElementChild.style.width = '0%';
    log('Starting build…');

    const started = Date.now();
    let chars = 0, lastLogged = 0;

    try {
      const res = await fetch(`/api/requests/${state.current.id}/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: state.feedback })
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', done = null;

      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (!ev || !data) continue;
          const payload = JSON.parse(data);
          if (ev === 'status') log(payload.message);
          if (ev === 'progress') {
            chars = payload.chars;
            // Typical output is ~12–18k chars; show determinate-ish progress.
            bar.classList.remove('indeterminate');
            bar.firstElementChild.style.width = `${Math.min(95, (chars / 16000) * 100)}%`;
            if (chars - lastLogged >= 2000) { lastLogged = chars; log(`Generated ${chars.toLocaleString()} characters…`); }
          }
          if (ev === 'done') done = payload;
        }
      }
      if (!done) throw new Error('Build ended without a result');

      bar.classList.remove('indeterminate');
      bar.firstElementChild.style.width = '100%';
      const b = done.build;
      log(`Done in ${(b.durationMs / 1000).toFixed(1)}s via ${b.provider} (${b.model}) → version ${b.version}`, 'ok');
      b.warnings?.forEach(w => log(w, 'warn'));

      state.current = await api(`/api/requests/${state.current.id}`);
      state.version = b.version;
      state.feedback = '';
      await loadRequests();
      toast(`Version ${b.version} built in ${((Date.now() - started) / 1000).toFixed(0)}s`);
      state.building = false;
      setTimeout(() => goto(4), 500);
    } catch (err) {
      log(`Build failed: ${err.message}`, 'warn');
      toast(`Build failed: ${err.message}`, true);
      state.building = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg><span>Build Website</span>`;
      $('#buildBackBtn').disabled = false;
    }
  }

  // ── Step 4: preview ───────────────────────────────────────
  function previewUrl() { return `/builds/${state.current.id}/v${state.version}/index.html`; }

  function renderPreview() {
    const r = state.current;
    const sel = $('#versionSelect');
    sel.innerHTML = r.builds.map(b =>
      `<option value="${b.version}">v${b.version} · ${b.provider}${b.feedback ? ' · rebuild' : ''}</option>`).join('');
    sel.value = String(state.version);
    const b = r.builds.find(x => x.version === state.version);
    $('#previewSub').textContent = `${r.client.fullName} · version ${b.version} of ${r.builds.length} · built ${fmtDate(b.createdAt)}`;
    $('#previewMeta').textContent = `${b.provider} / ${b.model} · ${Object.values(b.sizes || {}).reduce((a, n) => a + n, 0).toLocaleString()} bytes`;
    const url = previewUrl();
    $('#previewUrl').textContent = location.origin + url;
    $('#openTabBtn').href = url;
    $('#previewFrame').src = url + '?t=' + Date.now();
  }

  $('#versionSelect').addEventListener('change', (e) => { state.version = Number(e.target.value); renderPreview(); });
  $('#deviceSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#deviceSeg button').forEach(x => x.classList.toggle('on', x === b));
    const f = $('#previewFrame');
    f.className = 'preview-frame' + (b.dataset.device === 'desktop' ? '' : ' ' + b.dataset.device);
  });

  // ── Step 5: deliver ───────────────────────────────────────
  function renderDeliver() {
    const r = state.current;
    $('#deliverSub').textContent = `${r.client.fullName} · version ${state.version} · client email: ${r.client.email}`;
    $('#emailBanner').hidden = true;
    $('#rebuildFeedback').value = '';
  }

  $('#rebuildBtn').addEventListener('click', () => {
    state.feedback = $('#rebuildFeedback').value.trim();
    goto(3);
  });

  $('#transferBtn').addEventListener('click', async () => {
    const r = state.current, email = r.client.email;
    const banner = $('#emailBanner');
    banner.hidden = false;
    $('#emailLabel').textContent = 'Download starting · send this website to';
    $('#emailValue').textContent = email;
    $('#emailSub').textContent = `${r.client.fullName} · preparing ZIP for version ${state.version}…`;
    $('#mailtoBtn').href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Your new website is ready, ${r.client.fullName.split(' ')[0]}!`)}&body=${encodeURIComponent('Hi,\n\nYour website is attached as a ZIP. Unzip it and open index.html to preview, or upload the files to any static host.\n\nBest regards')}`;
    banner.scrollIntoView({ behavior: 'smooth', block: 'center' });

    try {
      const res = await fetch(`/api/requests/${r.id}/zip?v=${state.version}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const blob = await res.blob();
      const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'website.zip';
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);

      $('#emailLabel').textContent = 'Download complete · send this website to';
      $('#emailSub').textContent = `${r.client.fullName} · ${filename} (${(blob.size / 1024).toFixed(1)} KB)`;
      toast(`ZIP downloaded — send it to ${email}`);
    } catch (err) {
      $('#emailLabel').textContent = 'Download failed';
      $('#emailSub').textContent = err.message;
      toast(`Download failed: ${err.message}`, true);
    }
  });

  $('#copyEmailBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.current.client.email); toast('Email copied'); }
    catch { toast('Could not copy', true); }
  });

  // ── Init ──────────────────────────────────────────────────
  (async () => {
    goto(1);
    await Promise.all([loadRequests(), loadStatus()]);
  })();
})();
