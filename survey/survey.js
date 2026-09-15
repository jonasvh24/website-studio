/* Website Request Survey — collects answers, saves JSON, downloads it. */
(function () {
  'use strict';

  const STORAGE_KEY = 'website_requests';
  const form = document.getElementById('surveyForm');
  const success = document.getElementById('success');
  const desc = document.getElementById('description');
  const counter = document.getElementById('descCounter');
  const swatch = document.getElementById('colorSwatch');
  const colorText = document.getElementById('colorPreference');

  let lastRequest = null;

  // ── Small helpers ───────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const val = (name) => (form.elements[name]?.value || '').trim();

  function slugify(str) {
    return String(str)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'request';
  }

  function makeId() {
    const rnd = Math.random().toString(36).slice(2, 8);
    return `req_${Date.now().toString(36)}_${rnd}`;
  }

  function isEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  }

  function setInvalid(name, invalid) {
    const el = form.elements[name];
    const field = el?.closest('.field');
    if (field) field.classList.toggle('invalid', invalid);
    return !invalid;
  }

  // ── Live UI bits ────────────────────────────────────────────
  desc.addEventListener('input', () => {
    counter.textContent = `${desc.value.length} characters`;
  });

  swatch.addEventListener('input', () => {
    // Only overwrite the text if it's empty or already a hex value.
    if (!colorText.value || /^#?[0-9a-f]{3,8}$/i.test(colorText.value.trim())) {
      colorText.value = swatch.value;
    }
  });

  // Clear error state as the user fixes fields
  form.addEventListener('input', (e) => {
    const field = e.target.closest('.field');
    if (field?.classList.contains('invalid')) field.classList.remove('invalid');
  });

  // ── Build the request object ────────────────────────────────
  function collect() {
    const styles = [...form.querySelectorAll('input[name="stylePreferences"]:checked')].map(i => i.value);
    const type = form.querySelector('input[name="websiteType"]:checked')?.value || 'Other';

    return {
      id: makeId(),
      submittedAt: new Date().toISOString(),
      version: 1,
      client: {
        fullName: val('fullName'),
        email: val('email').toLowerCase(),
        location: val('location'),
        title: val('title'),
        bio: val('bio')
      },
      website: {
        type,
        description: val('description'),
        stylePreferences: styles,
        colorPreference: val('colorPreference')
      },
      social: {
        github: val('github'),
        linkedin: val('linkedin'),
        twitter: val('twitter'),
        currentWebsite: val('currentWebsite')
      },
      extraNotes: val('extraNotes'),
      meta: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        source: 'public-survey'
      }
    };
  }

  function validate() {
    let ok = true;
    ok = setInvalid('fullName', val('fullName').length < 2) && ok;
    ok = setInvalid('email', !isEmail(val('email'))) && ok;
    ok = setInvalid('description', val('description').length < 20) && ok;

    if (!ok) {
      const first = form.querySelector('.field.invalid input, .field.invalid textarea');
      first?.focus();
      first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return ok;
  }

  // ── Persistence ─────────────────────────────────────────────
  function fileNameFor(req) {
    const date = req.submittedAt.slice(0, 10);
    return `website-request_${slugify(req.client.fullName)}_${date}.json`;
  }

  function download(req) {
    const json = JSON.stringify(req, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileNameFor(req);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function saveLocal(req) {
    try {
      const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      const list = Array.isArray(existing) ? existing : [];
      list.push(req);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      return true;
    } catch (err) {
      console.warn('localStorage unavailable:', err);
      return false;
    }
  }

  // ── Submit ──────────────────────────────────────────────────
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!validate()) return;

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Saving…';

    const req = collect();
    lastRequest = req;

    saveLocal(req);
    download(req);

    $('#successName').textContent = req.client.fullName;
    $('#successEmail').textContent = req.client.email;
    $('#successFile').textContent = fileNameFor(req);

    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ behavior: 'smooth', block: 'start' });

    btn.disabled = false;
    btn.querySelector('span').textContent = 'Submit request';
  });

  $('#downloadAgain').addEventListener('click', () => lastRequest && download(lastRequest));

  $('#newRequest').addEventListener('click', () => {
    form.reset();
    counter.textContent = '0 characters';
    success.hidden = true;
    form.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
