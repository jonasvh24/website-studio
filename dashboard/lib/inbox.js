'use strict';
/**
 * Inbox: brings survey submissions into the dashboard automatically.
 *
 *   1. Watched folders (default ~/Downloads and data/inbox): any
 *      website-request_*.json that appears is imported. A ledger keeps track
 *      of what was already imported, so files are never touched or moved.
 *   2. Netlify Forms: if netlify.token and netlify.siteId are configured,
 *      submissions of the "website-request" form are pulled from the API.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const FORM_NAME = 'website-request';

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

class Inbox {
  constructor({ config, dataDir, importRequest, log = console.log }) {
    this.config = config;
    this.importRequest = importRequest;
    this.log = log;
    this.ledgerFile = path.join(dataDir, 'inbox-ledger.json');
    this.inboxDir = path.join(dataDir, 'inbox');
    fs.mkdirSync(this.inboxDir, { recursive: true });
    this.folders = [...new Set([this.inboxDir, ...((config.inbox && config.inbox.watchFolders) || ['~/Downloads']).map(expand)])];
    this.ledger = this.loadLedger();
    this.lastNetlify = { at: null, ok: null, error: null, imported: 0 };
    this.timer = null;
  }

  loadLedger() {
    try { return JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8')); } catch { return { files: {}, netlify: {} }; }
  }

  async saveLedger() {
    await fsp.writeFile(this.ledgerFile, JSON.stringify(this.ledger, null, 2));
  }

  netlifyConfigured() {
    const n = this.config.netlify || {};
    return !!((n.token || process.env.NETLIFY_AUTH_TOKEN) && (n.siteId || process.env.NETLIFY_SITE_ID));
  }

  status() {
    return {
      folders: this.folders,
      netlify: { configured: this.netlifyConfigured(), ...this.lastNetlify },
      importedFiles: Object.keys(this.ledger.files).length,
      importedSubmissions: Object.keys(this.ledger.netlify).length
    };
  }

  start() {
    const every = (this.config.inbox && this.config.inbox.pollSeconds) || 5;
    const netlifyEvery = (this.config.netlify && this.config.netlify.pollSeconds) || 60;
    let tick = 0;
    const run = async () => {
      try { await this.scanFolders(); } catch (err) { this.log('[inbox] folder scan failed:', err.message); }
      if (this.netlifyConfigured() && tick % Math.max(1, Math.round(netlifyEvery / every)) === 0) {
        try { await this.syncNetlify(); } catch (err) { this.log('[inbox] netlify sync failed:', err.message); }
      }
      tick++;
    };
    run();
    this.timer = setInterval(run, every * 1000);
    this.timer.unref();
  }

  /** Import new survey files from watched folders. Returns ids imported. */
  async scanFolders() {
    const imported = [];
    for (const dir of this.folders) {
      let names;
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!/^website-request_.*\.json$/i.test(name)) continue;
        const full = path.join(dir, name);
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        const key = full;
        const seen = this.ledger.files[key];
        if (seen && seen.mtime === st.mtimeMs && seen.size === st.size) continue;
        // Skip files still being written (modified in the last second)
        if (Date.now() - st.mtimeMs < 1000) continue;
        try {
          const raw = JSON.parse(await fsp.readFile(full, 'utf8'));
          const items = Array.isArray(raw) ? raw : [raw];
          for (const item of items) {
            const r = await this.importRequest(item, { source: 'folder', file: full });
            imported.push(r.id);
          }
          this.ledger.files[key] = { mtime: st.mtimeMs, size: st.size, at: new Date().toISOString() };
          this.log(`[inbox] imported ${name}`);
        } catch (err) {
          this.ledger.files[key] = { mtime: st.mtimeMs, size: st.size, error: err.message };
          this.log(`[inbox] skipped ${name}: ${err.message}`);
        }
      }
    }
    if (imported.length) await this.saveLedger();
    return imported;
  }

  /** Pull submissions from Netlify Forms. Returns ids imported. */
  async syncNetlify() {
    const n = this.config.netlify || {};
    const token = n.token || process.env.NETLIFY_AUTH_TOKEN;
    const siteId = n.siteId || process.env.NETLIFY_SITE_ID;
    if (!token || !siteId) throw new Error('Netlify token or siteId not configured');
    const headers = { Authorization: `Bearer ${token}` };
    const api = 'https://api.netlify.com/api/v1';

    try {
      const formsRes = await fetch(`${api}/sites/${siteId}/forms`, { headers, signal: AbortSignal.timeout(15000) });
      if (!formsRes.ok) throw new Error(`Netlify forms HTTP ${formsRes.status}`);
      const forms = await formsRes.json();
      const form = forms.find(f => f.name === (n.formName || FORM_NAME));
      if (!form) throw new Error(`Form "${n.formName || FORM_NAME}" not found on site (submit once after deploying so Netlify registers it)`);

      const subsRes = await fetch(`${api}/forms/${form.id}/submissions?per_page=100`, { headers, signal: AbortSignal.timeout(20000) });
      if (!subsRes.ok) throw new Error(`Netlify submissions HTTP ${subsRes.status}`);
      const subs = await subsRes.json();

      const imported = [];
      for (const sub of subs) {
        if (this.ledger.netlify[sub.id]) continue;
        try {
          const payload = JSON.parse(sub.data?.payload || '{}');
          const r = await this.importRequest(payload, { source: 'netlify', submissionId: sub.id, receivedAt: sub.created_at });
          this.ledger.netlify[sub.id] = { id: r.id, at: new Date().toISOString() };
          imported.push(r.id);
        } catch (err) {
          this.ledger.netlify[sub.id] = { error: err.message, at: new Date().toISOString() };
          this.log(`[inbox] netlify submission ${sub.id} skipped: ${err.message}`);
        }
      }
      if (imported.length) { await this.saveLedger(); this.log(`[inbox] imported ${imported.length} Netlify submission(s)`); }
      this.lastNetlify = { at: new Date().toISOString(), ok: true, error: null, imported: imported.length, total: subs.length };
      return imported;
    } catch (err) {
      this.lastNetlify = { at: new Date().toISOString(), ok: false, error: err.message, imported: 0 };
      throw err;
    }
  }
}

module.exports = { Inbox };
