'use strict';
/**
 * Optional headless-browser check for a built site. Needs puppeteer-core
 * (npm install in dashboard/) and an installed Chrome/Chromium/Edge.
 * Renders desktop and mobile, reports JS errors, failed resources and
 * horizontal overflow, and saves screenshots next to the build.
 *
 * browserCheck(dir) → { available, errors[], warnings[], screenshots: { desktop, mobile } }
 */
const fs = require('fs');
const path = require('path');

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

function findChrome() {
  return CHROME_PATHS.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

function loadPuppeteer() {
  try { return require('puppeteer-core'); } catch { return null; }
}

function isAvailable() {
  return !!(loadPuppeteer() && findChrome());
}

async function browserCheck(dir, opts = {}) {
  const puppeteer = loadPuppeteer();
  const chrome = findChrome();
  if (!puppeteer || !chrome) return { available: false, errors: [], warnings: [], screenshots: {} };

  const errors = [], warnings = [], screenshots = {};
  const url = 'file://' + path.join(dir, 'index.html');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const views = [
      ['desktop', { width: 1280, height: 900 }],
      ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }]
    ];
    for (const [name, vp] of views) {
      const page = await browser.newPage();
      const seen = new Set();
      page.on('pageerror', e => errors.push(`${name}: JavaScript error: ${e.message.split('\n')[0]}`));
      page.on('requestfailed', r => { const u = r.url(); if (!/favicon/.test(u) && !seen.has(u)) { seen.add(u); errors.push(`${name}: failed to load ${u.slice(0, 100)}`); } });
      page.on('response', r => { const u = r.url(); if (r.status() >= 400 && !/favicon/.test(u) && !seen.has(u)) { seen.add(u); errors.push(`${name}: ${r.status()} for ${u.slice(0, 100)}`); } });
      await page.setViewport(vp);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: opts.timeout || 30000 });
      // What a visitor sees: at several scroll positions, wait for animations, then measure
      const m = await page.evaluate(async () => {
        const w = document.documentElement.clientWidth;
        const out = { overflow: null, hidden: 0, hiddenAt: [], tinyText: 0, h: document.body.scrollHeight };
        if (document.documentElement.scrollWidth > w + 1) {
          const bad = [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.right > w + 1 && r.width > 0; });
          out.overflow = bad.slice(0, 3).map(el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''}`).join(', ') || 'unknown element';
        }
        const max = Math.max(0, document.body.scrollHeight - window.innerHeight);
        const stops = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(max * f));
        for (const y of stops) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 900));
          let n = 0;
          for (const el of document.querySelectorAll('section, article, h1, h2, h3, p, li, img')) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
            const cs = getComputedStyle(el);
            if (cs.opacity === '0' || cs.visibility === 'hidden') n++;
            if (/^(p|li)$/i.test(el.tagName) && parseFloat(cs.fontSize) < 12 && el.textContent.trim().length > 20) out.tinyText++;
          }
          if (n) { out.hidden += n; out.hiddenAt.push(`${Math.round(y / (max || 1) * 100)}%`); }
        }
        window.scrollTo(0, 0);
        await new Promise(r => setTimeout(r, 400));
        return out;
      });
      if (m.overflow) errors.push(`${name}: page scrolls horizontally (${m.overflow} extends past the viewport)`);
      if (m.hidden) errors.push(`${name}: ${m.hidden} content block(s) invisible while on screen (scroll position ${m.hiddenAt.join(', ')}); reveal animation never shows them`);
      if (m.tinyText) warnings.push(`${name}: text under 12px`);
      if (m.h < vp.height * 1.5) warnings.push(`${name}: page is very short (${m.h}px)`);

      const file = `screenshot-${name}.png`;
      await page.screenshot({ path: path.join(dir, file), fullPage: true, captureBeyondViewport: true });
      screenshots[name] = file;
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return { available: true, errors: [...new Set(errors)], warnings, screenshots };
}

module.exports = { browserCheck, isAvailable };
