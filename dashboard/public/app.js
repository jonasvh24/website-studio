/* Website Studio dashboard: 5-step workflow */
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
    business: null,
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
    const sel = $('#modelSelect');
    try {
      const { providers } = await api('/api/status');
      const k = providers.openaiCompatible, o = providers.ollama;
      const opts = [];
      if (k.ok) {
        opts.push(`<optgroup label="${esc(k.label)} (cloud)">${k.models.map(m => `<option value="kimi:${esc(m)}" ${m === k.preferred ? 'selected' : ''}>${esc(m)}</option>`).join('')}</optgroup>`);
      }
      if (o.ok) {
        const pref = o.models.includes(o.preferred) ? o.preferred : o.models[0];
        const note = (m) => /72b|70b/.test(m) ? ' (best local quality, about 25 min)' : /14b/.test(m) ? ' (about 5 min)' : /8b|7b/.test(m) ? ' (fast, lower quality)' : '';
        opts.push(`<optgroup label="Ollama (local)">${o.models.map(m => `<option value="ollama:${esc(m)}" ${!k.ok && m === pref ? 'selected' : ''}>${esc(m)}${note(m)}</option>`).join('')}</optgroup>`);
      }
      sel.innerHTML = opts.join('') || '<option value="">Built-in template (no model)</option>';

      if (k.ok) {
        dot.className = 'status-dot ok'; txt.textContent = `${k.label}: ${k.preferred}`;
        $('#modelLine').textContent = `${k.label} is the default builder. ${o.ok ? 'Ollama is available as a local alternative.' : ''}`;
      } else if (o.ok) {
        const pref = o.models.includes(o.preferred) ? o.preferred : o.models[0];
        dot.className = 'status-dot ok'; txt.textContent = `Ollama: ${pref}`;
        $('#modelLine').textContent = k.hasKey ? `${k.label} key set but unreachable (${k.error || 'error'}). Using Ollama.` : `Local model. Add a Kimi API key in config.local.json to use Kimi.`;
      } else {
        dot.className = 'status-dot warn'; txt.textContent = 'No model. Template mode';
        $('#modelLine').textContent = 'No model reachable. Builds will use the built-in template generator. Start Ollama or add a Kimi API key.';
      }
    } catch {
      dot.className = 'status-dot bad'; txt.textContent = 'Server unreachable';
    }
  }

  // ── Inbox (watched folders + Netlify) ─────────────────────
  async function loadInbox() {
    try {
      const st = await api('/api/inbox');
      const folders = st.folders.map(f => f.replace(/^\/Users\/[^/]+/, '~')).join(', ');
      let t = `Watching ${folders} for survey files.`;
      if (st.netlify.configured) t += st.netlify.ok === false ? ` Netlify: ${st.netlify.error}` : ` Netlify Forms connected${st.netlify.at ? ', checked ' + new Date(st.netlify.at).toLocaleTimeString() : ''}.`;
      else t += ' Netlify Forms not connected.';
      $('#inboxText').textContent = t;
    } catch { /* ignore */ }
  }

  $('#inboxSyncBtn').addEventListener('click', async () => {
    const b = $('#inboxSyncBtn'); b.disabled = true; b.textContent = 'Checking';
    try {
      const r = await api('/api/inbox/sync', { method: 'POST' });
      await loadRequests(); await loadInbox();
      toast(r.imported.length ? `${r.imported.length} new request(s) imported` : (r.netlifyError ? `Netlify: ${r.netlifyError}` : 'No new requests'), !!r.netlifyError);
    } catch (err) { toast(err.message, true); }
    finally { b.disabled = false; b.textContent = 'Check now'; }
  });

  // Poll the request list while on step 1 so auto-imported files show up.
  setInterval(() => { if (state.step === 1 && !state.building) { loadRequests(); loadInbox(); } }, 8000);

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
            <div class="sub">${esc(r.client.email)}${r.client.title ? ', ' + esc(r.client.title) : ''}${r.client.location ? ', ' + esc(r.client.location) : ''}</div>
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
    state.business = null;
    renderList();
  }

  async function importObjects(items, sourceLabel) {
    if (!items.length) return toast('Nothing to import', true);
    const { imported, errors } = await api('/api/requests', { method: 'POST', body: JSON.stringify(items) });
    await loadRequests();
    toast(`${imported.length} request(s) imported from ${sourceLabel}${errors.length ? `, ${errors.length} skipped` : ''}`, imported.length === 0);
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
  $('#refreshBtn').addEventListener('click', () => { loadRequests(); loadStatus(); loadInbox(); });

  $('#localStorageBtn').addEventListener('click', async () => {
    let list = [];
    try { list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { /* ignore */ }
    if (!Array.isArray(list) || !list.length) {
      return toast('No saved requests in this browser. Fill in the survey at /survey/ on this origin, or import the JSON file.', true);
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
    let v = empty ? 'Not provided' : esc(value);
    if (!empty && link) v = `<a href="${esc(value)}" target="_blank" rel="noopener">${esc(value)}</a>`;
    if (!empty && label === 'Email') v = `<a href="mailto:${esc(value)}">${esc(value)}</a>`;
    return `<dt>${label}</dt><dd class="${empty ? 'empty-val' : ''}">${v}</dd>`;
  }

  function renderReview() {
    const r = state.current, c = r.client, w = r.website, s = r.social;
    $('#reviewName').textContent = c.fullName;
    $('#reviewSub').textContent = `${w.type || 'Website'}. Submitted ${fmtDate(r.submittedAt)}. Received via ${r.importSource || 'import'}. ${r.builds?.length || 0} build(s)`;

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
          <dt>Type</dt><dd>${esc(w.type || 'Not provided')}</dd>
          <dt>Styles</dt><dd>${(w.stylePreferences || []).length ? `<span class="chip-row">${w.stylePreferences.map(x => `<span class="chip-static">${esc(x)}</span>`).join('')}</span>` : '<span class="empty-val">Not provided</span>'}</dd>
          <dt>Color</dt><dd>${w.colorPreference ? `${colorHex ? `<span class="swatch" style="background:${colorHex}"></span>` : ''}${esc(w.colorPreference)}` : '<span class="empty-val">Not provided</span>'}</dd>
        </dl>
      </div>
      <div class="review-block">
        <h3>Extra notes</h3>
        <p class="prose ${r.extraNotes ? '' : 'empty-val'}">${esc(r.extraNotes || 'None')}</p>
      </div>
      <div class="review-block">
        <h3>Domain</h3>
        <dl class="kv">
          ${kv('Existing domain', r.domain?.name)}
          ${kv('Registrar / host', r.domain?.registrar)}
          <dt>DNS access</dt><dd>${r.domain?.name ? (r.domain?.canGiveAccess ? 'Client can give access' : 'Client has not confirmed access') : '<span class="empty-val">Not provided</span>'}</dd>
        </dl>
      </div>
      <div class="review-block">
        <h3>Client files (${(r.files || []).length})</h3>
        ${(r.files || []).length ? `<div class="file-grid">${r.files.map(f => `
          <div class="file-tile" title="${esc(f.name)}">
            ${f.kind === 'image' && f.stored ? `<img src="/uploads/${esc(r.id)}/${esc(f.name)}" alt="">` : `<div class="doc">${esc((f.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 5))}</div>`}
            <div class="fname">${esc(f.name)}${f.stored ? '' : ' (not received)'}</div>
          </div>`).join('')}</div>` : '<span class="empty-val">None</span>'}
      </div>
      <div class="review-block full" id="bizBlock">
        <h3>Business listing</h3>
        <div id="bizBody"><span class="empty-val">Loading</span></div>
      </div>`;
    renderBusiness();
  }

  // ── Business lookup (Google Places) ───────────────────────
  async function renderBusiness() {
    const r = state.current, bz = r.business || {};
    const body = $('#bizBody');
    if (!body) return;
    let info;
    try { info = await api(`/api/requests/${r.id}/business`); }
    catch (err) { body.innerHTML = `<span class="empty-val">${esc(err.message)}</span>`; return; }
    state.business = info.business;

    const surveyLine = `<dl class="kv">
        ${kv('Name (survey)', bz.name)}
        ${kv('Location (survey)', bz.location)}
        <dt>Public data</dt><dd>${bz.usePublicData === false ? 'Client declined use of reviews and photos' : 'Client allowed use of public reviews and photos'}</dd>
      </dl>`;

    if (bz.usePublicData === false) { body.innerHTML = surveyLine; return; }

    if (!info.configured) {
      body.innerHTML = `${surveyLine}
        <p class="biz-note">No Google Places API key configured. Add <code>googlePlaces.apiKey</code> to <code>dashboard/config.json</code> to pull reviews and photos.</p>`;
      return;
    }

    const b = info.business;
    if (b) {
      body.innerHTML = `${surveyLine}
        <div class="biz-attached">
          <div class="biz-head">
            <div>
              <div class="biz-name">${esc(b.name)} <span class="tag green">Attached</span></div>
              <div class="sub">${esc(b.type || '')}${b.type ? '. ' : ''}${esc(b.address)}</div>
              <div class="sub">${b.rating ? `Rating ${esc(b.rating)} / 5 from ${esc(b.reviewCount)} reviews. ` : ''}${b.reviews.length} review(s) and ${b.photos.length} photo(s) will be used.</div>
            </div>
            <div class="toolbar">
              <button class="btn btn-sm" id="bizChangeBtn">Change</button>
              <button class="btn btn-sm btn-ghost" id="bizRemoveBtn">Remove</button>
            </div>
          </div>
          ${b.photos.length ? `<div class="biz-photos">${b.photos.map(p => `<img src="/business/${esc(r.id)}/photos/${esc(p.file)}" alt="">`).join('')}</div>` : ''}
          ${b.reviews.length ? `<div class="biz-reviews">${b.reviews.map(rv => `<div class="biz-review"><strong>${esc(rv.author)}</strong> <span class="stars">${'&#9733;'.repeat(Math.round(rv.rating || 0))}</span><p>${esc(rv.text)}</p></div>`).join('')}</div>` : ''}
        </div>`;
      $('#bizChangeBtn').onclick = () => bizSearchUI(body, surveyLine);
      $('#bizRemoveBtn').onclick = async () => {
        await api(`/api/requests/${r.id}/business`, { method: 'DELETE' });
        toast('Business data removed'); renderBusiness();
      };
      return;
    }
    bizSearchUI(body, surveyLine);
  }

  function bizSearchUI(body, surveyLine) {
    const r = state.current, bz = r.business || {};
    const q = [bz.name, bz.location].filter(Boolean).join(', ');
    body.innerHTML = `${surveyLine}
      <div class="biz-search">
        <input type="text" id="bizQuery" value="${esc(q)}" placeholder="Business name, city">
        <button class="btn btn-sm btn-primary" id="bizFindBtn">Find business</button>
      </div>
      <div id="bizResults"></div>`;
    const run = async () => {
      const query = $('#bizQuery').value.trim();
      if (!query) return toast('Enter a business name', true);
      const btn = $('#bizFindBtn'); btn.disabled = true; btn.textContent = 'Searching';
      $('#bizResults').innerHTML = '';
      try {
        const { candidates } = await api(`/api/business/search?q=${encodeURIComponent(query)}`);
        if (!candidates.length) { $('#bizResults').innerHTML = '<p class="biz-note">No matching listing found. Try adding the city or street.</p>'; return; }
        $('#bizResults').innerHTML = `<div class="biz-cands">${candidates.map(c => `
          <div class="biz-cand">
            <div>
              <div class="biz-name">${esc(c.name)}</div>
              <div class="sub">${esc(c.type || '')}${c.type ? '. ' : ''}${esc(c.address)}</div>
              <div class="sub">${c.rating ? `Rating ${esc(c.rating)} / 5, ${esc(c.reviewCount)} reviews` : 'No rating yet'}</div>
            </div>
            <button class="btn btn-sm btn-primary" data-place="${esc(c.placeId)}">Use this</button>
          </div>`).join('')}</div>`;
        $$('#bizResults [data-place]').forEach(b => b.onclick = async () => {
          b.disabled = true; b.textContent = 'Fetching reviews and photos';
          try {
            await api(`/api/requests/${r.id}/business`, { method: 'POST', body: JSON.stringify({ placeId: b.dataset.place }) });
            toast('Business data attached'); renderBusiness();
          } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Use this'; }
        });
      } catch (err) { $('#bizResults').innerHTML = `<p class="biz-note">${esc(err.message)}</p>`; }
      finally { btn.disabled = false; btn.textContent = 'Find business'; }
    };
    $('#bizFindBtn').onclick = run;
    $('#bizQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    if (q && !state.business) run();  // auto-search on first visit when the survey gave a name
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
    const bz = state.business;
    const nFiles = (r.files || []).filter(f => f.stored).length;
    const parts = [];
    if (bz && r.business?.usePublicData !== false) parts.push(`Business listing: ${bz.name}, ${bz.reviews.length} review(s), ${bz.photos.length} photo(s).`);
    else if (r.business?.name) parts.push('No business listing attached. Go back to Review to find it, or build without it.');
    if (nFiles) parts.push(`${nFiles} client file(s) will be used.`);
    $('#bizLine').textContent = parts.join(' ');
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
    btn.innerHTML = `<span class="spinner"></span><span>Generating</span>`;
    $('#buildBackBtn').disabled = true;
    $('#progressWrap').hidden = false;
    $('#buildLog').innerHTML = '';
    const bar = $('#progressBar');
    bar.classList.add('indeterminate');
    bar.firstElementChild.style.width = '0%';
    log('Starting build');

    const started = Date.now();
    let chars = 0, lastLogged = 0;

    try {
      const res = await fetch(`/api/requests/${state.current.id}/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: state.feedback, model: $('#modelSelect').value || undefined })
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
            // Typical output is 12-18k chars; show approximate progress.
            bar.classList.remove('indeterminate');
            bar.firstElementChild.style.width = `${Math.min(95, (chars / 16000) * 100)}%`;
            if (chars - lastLogged >= 2000) { lastLogged = chars; log(`Generated ${chars.toLocaleString()} characters`); }
          }
          if (ev === 'done') done = payload;
        }
      }
      if (!done) throw new Error('Build ended without a result');

      bar.classList.remove('indeterminate');
      bar.firstElementChild.style.width = '100%';
      const b = done.build;
      log(`Done in ${(b.durationMs / 1000).toFixed(1)}s via ${b.provider} (${b.model}). Saved as version ${b.version}`, 'ok');
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
      `<option value="${b.version}">v${b.version} (${b.provider}${b.feedback ? ', rebuild' : ''})</option>`).join('');
    sel.value = String(state.version);
    const b = r.builds.find(x => x.version === state.version);
    $('#previewSub').textContent = `${r.client.fullName}. Version ${b.version} of ${r.builds.length}. Built ${fmtDate(b.createdAt)}`;
    $('#previewMeta').textContent = `${b.provider} / ${b.model}, ${Object.values(b.sizes || {}).reduce((a, n) => a + n, 0).toLocaleString()} bytes`;
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
    $('#deliverSub').textContent = `${r.client.fullName}. Version ${state.version}. Client email: ${r.client.email}`;
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
    $('#emailLabel').textContent = 'Download starting. Send this website to';
    $('#emailValue').textContent = email;
    $('#emailSub').textContent = `${r.client.fullName}. Preparing ZIP for version ${state.version}`;
    $('#mailtoBtn').href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent('Your website files')}&body=${encodeURIComponent('Hi ' + r.client.fullName.split(' ')[0] + ',\n\nThe website files are attached as a ZIP. Unzip it and open index.html to preview, or upload the files to any web host.\n\nRegards')}`;
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

      $('#emailLabel').textContent = 'Download complete. Send this website to';
      $('#emailSub').textContent = `${r.client.fullName}. ${filename} (${(blob.size / 1024).toFixed(1)} KB)`;
      toast(`ZIP downloaded. Send it to ${email}`);
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
    await Promise.all([loadRequests(), loadStatus(), loadInbox()]);
  })();
})();
