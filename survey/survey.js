/* Website request form: collects answers, saves JSON, downloads it. */
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
  const CFG = Object.assign({ remote: 'auto', endpoint: '', contactEmail: '', maxFiles: 12, maxImageEdge: 1600, maxFileBytes: 3 * 1024 * 1024 }, window.SURVEY_CONFIG || {});
  const files = [];   // { name, type, size, dataUrl, kind }

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

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

  // ── Files ───────────────────────────────────────────────────
  const fileInput = document.getElementById('fileInput');
  const fileDrop = document.getElementById('fileDrop');
  const fileList = document.getElementById('fileList');
  const fileError = document.getElementById('fileError');

  function showFileError(msg) {
    fileError.textContent = msg;
    fileError.style.display = msg ? 'block' : 'none';
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  // Resize images in the browser so the JSON stays small.
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const max = CFG.maxImageEdge;
        let { width, height } = img;
        const scale = Math.min(1, max / Math.max(width, height));
        width = Math.round(width * scale); height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const keepPng = file.type === 'image/png' && file.size < 400 * 1024; // small PNGs (logos) keep transparency
        resolve({ dataUrl: keepPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.82), width, height, type: keepPng ? 'image/png' : 'image/jpeg' });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
      img.src = url;
    });
  }

  async function addFiles(list) {
    showFileError('');
    for (const f of list) {
      if (files.length >= CFG.maxFiles) { showFileError(`You can add up to ${CFG.maxFiles} files.`); break; }
      if (files.some(x => x.name === f.name && x.size === f.size)) continue;
      try {
        if (f.type.startsWith('image/')) {
          const r = await shrinkImage(f);
          const name = f.name.replace(/\.[^.]+$/, '') + (r.type === 'image/png' ? '.png' : '.jpg');
          files.push({ name, type: r.type, size: Math.round(r.dataUrl.length * 0.75), width: r.width, height: r.height, dataUrl: r.dataUrl, kind: 'image' });
        } else {
          if (f.size > CFG.maxFileBytes) { showFileError(`${f.name} is larger than ${Math.round(CFG.maxFileBytes / 1048576)} MB and was skipped.`); continue; }
          files.push({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataUrl: await readAsDataUrl(f), kind: 'document' });
        }
      } catch (err) {
        showFileError(`${f.name}: ${err.message}`);
      }
    }
    renderFiles();
  }

  function renderFiles() {
    fileList.innerHTML = files.map((f, i) => `
      <div class="file-item">
        ${f.kind === 'image' ? `<img src="${f.dataUrl}" alt="">` : `<div class="doc">${(f.name.split('.').pop() || 'FILE').toUpperCase().slice(0, 5)}</div>`}
        <div class="fname" title="${f.name}">${f.name}</div>
        <button type="button" class="rm" data-i="${i}" aria-label="Remove ${f.name}">&times;</button>
      </div>`).join('');
  }

  fileDrop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => fileDrop.addEventListener(ev, (e) => { e.preventDefault(); fileDrop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => fileDrop.addEventListener(ev, (e) => { e.preventDefault(); fileDrop.classList.remove('over'); }));
  fileDrop.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));
  fileList.addEventListener('click', (e) => {
    const b = e.target.closest('.rm');
    if (b) { files.splice(Number(b.dataset.i), 1); renderFiles(); }
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
      business: {
        name: val('businessName'),
        location: val('businessLocation'),
        usePublicData: !!form.querySelector('input[name="usePublicData"]:checked')
      },
      domain: {
        name: val('domainName').replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
        registrar: val('domainRegistrar'),
        canGiveAccess: !!form.querySelector('input[name="domainAccess"]:checked')
      },
      files: files.map(f => ({ name: f.name, type: f.type, size: f.size, width: f.width, height: f.height, kind: f.kind, dataUrl: f.dataUrl })),
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

  // ── Remote delivery ─────────────────────────────────────────
  const onNetlify = /\.netlify\.app$/i.test(location.hostname);
  const useNetlify = CFG.remote === 'netlify' || (CFG.remote === 'auto' && onNetlify);
  const MAX_REMOTE_BYTES = 6 * 1024 * 1024;

  // Returns the payload to send remotely; drops files if the body would be too large.
  function remotePayload(req) {
    let payload = JSON.stringify(req);
    if (payload.length > MAX_REMOTE_BYTES) {
      payload = JSON.stringify({ ...req, files: req.files.map(f => ({ ...f, dataUrl: undefined })), filesOmitted: true });
    }
    return payload;
  }

  async function sendRemote(req) {
    if (useNetlify) {
      const body = new URLSearchParams({
        'form-name': 'website-request',
        name: req.client.fullName,
        email: req.client.email,
        business: req.business.name || '',
        request_id: req.id,
        payload: remotePayload(req)
      });
      const res = await fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!res.ok) throw new Error(`Netlify returned ${res.status}`);
      return 'netlify';
    }
    if (CFG.endpoint) {
      const res = await fetch(CFG.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: remotePayload(req) });
      if (!res.ok) throw new Error(`Endpoint returned ${res.status}`);
      return 'endpoint';
    }
    return null;
  }

  // ── Payment (PayPal Smart Buttons) ─────────────────────────
  const PAY = Object.assign({ enabled: false, provider: 'paypal', clientId: '', amount: '250.00', currency: 'EUR', description: 'Website build', sandbox: false }, CFG.payment || {});
  const payPanel = document.getElementById('payment');
  const fmtMoney = (a, c) => `${Number(a).toFixed(2)} ${c}`;
  let pendingRequest = null;
  let paypalLoaded = null;

  if (PAY.enabled) {
    $('#feeAmount').textContent = fmtMoney(PAY.amount, PAY.currency);
    $('#feeInline').textContent = fmtMoney(PAY.amount, PAY.currency);
  } else {
    $('#submitNote').textContent = 'Submitting saves a JSON file to your device and sends your request to us.';
    $('#submitBtn').querySelector('span').textContent = 'Submit request';
  }

  function loadPayPal() {
    if (paypalLoaded) return paypalLoaded;
    paypalLoaded = new Promise((resolve, reject) => {
      if (window.paypal) return resolve(window.paypal);
      const sc = document.createElement('script');
      const host = PAY.sandbox ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com';
      sc.src = `${host}/sdk/js?client-id=${encodeURIComponent(PAY.clientId)}&currency=${encodeURIComponent(PAY.currency)}&intent=capture&disable-funding=credit`;
      sc.onload = () => resolve(window.paypal);
      sc.onerror = () => reject(new Error('Could not load PayPal'));
      document.head.appendChild(sc);
    });
    return paypalLoaded;
  }

  async function showPayment(req) {
    pendingRequest = req;
    form.hidden = true;
    payPanel.hidden = false;
    $('#payClient').textContent = `${req.client.fullName} (${req.client.email})`;
    $('#payStatus').textContent = '';
    payPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const box = $('#paypalButtons');
    if (!PAY.clientId) {
      box.innerHTML = '<div class="pay-notice">Online payment is not set up yet. Please contact us to complete your order.</div>';
      return;
    }
    box.innerHTML = '';
    try {
      const paypal = await loadPayPal();
      paypal.Buttons({
        style: { layout: 'vertical', color: 'black', shape: 'rect', label: 'pay', height: 48 },
        createOrder: (data, actions) => actions.order.create({
          intent: 'CAPTURE',
          purchase_units: [{
            reference_id: req.id,
            custom_id: req.id,
            description: PAY.description,
            amount: { currency_code: PAY.currency, value: String(PAY.amount) }
          }],
          application_context: { shipping_preference: 'NO_SHIPPING', brand_name: 'Website request' }
        }),
        onApprove: async (data, actions) => {
          $('#payStatus').textContent = 'Confirming payment';
          const details = await actions.order.capture();
          const cap = details.purchase_units?.[0]?.payments?.captures?.[0] || {};
          req.payment = {
            provider: 'paypal',
            status: cap.status || details.status || 'COMPLETED',
            orderId: details.id || data.orderID,
            captureId: cap.id || '',
            amount: cap.amount?.value || String(PAY.amount),
            currency: cap.amount?.currency_code || PAY.currency,
            payerEmail: details.payer?.email_address || '',
            payerName: [details.payer?.name?.given_name, details.payer?.name?.surname].filter(Boolean).join(' '),
            paidAt: cap.create_time || new Date().toISOString(),
            sandbox: !!PAY.sandbox
          };
          await finishSubmission(req);
        },
        onCancel: () => { $('#payStatus').textContent = 'Payment cancelled. You can try again or go back to the form.'; },
        onError: (err) => { console.error(err); $('#payStatus').textContent = 'Payment failed. Please try again or contact us.'; }
      }).render('#paypalButtons');
    } catch (err) {
      box.innerHTML = `<div class="pay-notice">${escapeHtml(err.message)}. Please try again later or contact us.</div>`;
    }
  }

  $('#payBack').addEventListener('click', () => {
    payPanel.hidden = true;
    form.hidden = false;
    $('#submitBtn').disabled = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // ── Submit ──────────────────────────────────────────────────
  async function finishSubmission(req) {
    lastRequest = req;
    saveLocal(req);

    let sent = null, sendError = null;
    try { sent = await sendRemote(req); } catch (err) { sendError = err; console.warn('Remote send failed:', err); }

    download(req);

    $('#successName').textContent = req.client.fullName;
    $('#successEmail').textContent = req.client.email;
    $('#successFile').textContent = fileNameFor(req);
    const emailNote = CFG.contactEmail ? ` Email it to ${CFG.contactEmail}.` : ' Email it to us.';
    if (sent) {
      $('#successMain').innerHTML = `Thanks, <strong>${escapeHtml(req.client.fullName)}</strong>. Your request has been sent.`;
      $('#successSub').innerHTML = `A copy, <code>${escapeHtml(fileNameFor(req))}</code>, has been downloaded to your device. We will reply to <strong>${escapeHtml(req.client.email)}</strong>.`;
    } else {
      $('#successMain').innerHTML = `Thanks, <strong>${escapeHtml(req.client.fullName)}</strong>. Your request file has been downloaded.`;
      $('#successSub').innerHTML = `${sendError ? 'Automatic sending did not work, so please' : 'Please'} send <code>${escapeHtml(fileNameFor(req))}</code> to us.${escapeHtml(emailNote)} We will reply to <strong>${escapeHtml(req.client.email)}</strong>.`;
    }
    const sp = $('#successPay');
    if (req.payment) {
      sp.hidden = false;
      sp.innerHTML = `Payment of <strong>${escapeHtml(fmtMoney(req.payment.amount, req.payment.currency))}</strong> received. PayPal order <code>${escapeHtml(req.payment.orderId)}</code>. A receipt is sent by PayPal.`;
    } else { sp.hidden = true; }

    payPanel.hidden = true;
    form.hidden = true;
    success.hidden = false;
    success.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const btn = $('#submitBtn');
    btn.disabled = false;
    btn.querySelector('span').textContent = PAY.enabled ? 'Continue to payment' : 'Submit request';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate()) return;

    const btn = $('#submitBtn');
    btn.disabled = true;

    const req = collect();
    if (PAY.enabled) {
      await showPayment(req);
      return;
    }
    btn.querySelector('span').textContent = 'Sending';
    await finishSubmission(req);
  });

  $('#downloadAgain').addEventListener('click', () => lastRequest && download(lastRequest));

  $('#newRequest').addEventListener('click', () => {
    form.reset();
    files.length = 0; renderFiles();
    counter.textContent = '0 characters';
    pendingRequest = null;
    success.hidden = true;
    payPanel.hidden = true;
    form.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
