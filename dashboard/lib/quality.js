'use strict';
/**
 * Quality gate for generated sites.
 *   autoFix(files, ctx)  → { files, fixes[] }   deterministic repairs
 *   check(files, ctx)    → { ok, score, errors[], warnings[] }
 *
 * ctx: { request, assets: [filenames available under assets/], provider }
 */

const vm = require('vm');

function stripTags(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function autoFix(files, ctx) {
  const fixes = [];
  let html = files['index.html'] || '';
  let css = files['styles.css'] || '';
  let js = files['script.js'] || '';

  // Strip markdown fences that slipped through
  for (const [k, v] of [['html', html], ['css', css], ['js', js]]) {
    if (/^\s*```/.test(v) || /```\s*$/.test(v)) fixes.push(`removed code fences from ${k}`);
  }
  html = html.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '');
  css = css.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '');
  js = js.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '');

  // Em and en dashes in visible text
  const dashCount = (html.match(/[—–]/g) || []).length;
  if (dashCount) { html = html.replace(/\s*—\s*/g, ', ').replace(/–/g, '-'); fixes.push(`replaced ${dashCount} dash character(s)`); }

  // No doctype
  if (!/<!doctype html/i.test(html)) { html = '<!DOCTYPE html>\n' + html; fixes.push('added doctype'); }

  // Viewport
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">`);
    fixes.push('added viewport meta');
  }

  // Charset
  if (!/<meta[^>]+charset/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n  <meta charset="UTF-8">`);
    fixes.push('added charset meta');
  }

  // Stylesheet and script links
  if (!/<link[^>]+href=["'](\.\/)?styles\.css["']/i.test(html)) {
    html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="styles.css">\n</head>');
    fixes.push('linked styles.css');
  }
  if (!/<script[^>]+src=["'](\.\/)?script\.js["']/i.test(html)) {
    html = html.replace(/<\/body>/i, '  <script src="script.js"></script>\n</body>');
    fixes.push('linked script.js');
  }

  // External scripts (CDNs) are not allowed
  const ext = html.match(/<script[^>]+src=["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>/gi) || [];
  if (ext.length) { for (const t of ext) html = html.replace(t, ''); fixes.push(`removed ${ext.length} external script tag(s)`); }

  // Broken asset references → drop the <img> tag
  const assets = new Set(ctx.assets || []);
  const imgRe = /<img\b[^>]*\bsrc=["']assets\/([^"']+)["'][^>]*>/gi;
  let broken = 0;
  html = html.replace(imgRe, (tag, file) => {
    if (assets.has(decodeURIComponent(file))) return tag;
    broken++; return '';
  });
  if (broken) fixes.push(`removed ${broken} image tag(s) pointing to files that do not exist`);
  css = css.replace(/url\((["']?)(?:\.\/)?assets\/([^"')]+)\1\)/gi, (m, q, file) => assets.has(decodeURIComponent(file)) ? m : 'none');

  // External images (placeholder services etc.) → inline SVG placeholder with the same label
  let extImgs = 0;
  html = html.replace(/<img\b([^>]*)\bsrc=["'](https?:\/\/[^"']+)["']([^>]*)>/gi, (tag, a, url, b) => {
    if (/fonts\.gstatic|googleapis/.test(url)) return tag;
    extImgs++;
    const label = (/text=([^&]+)/.exec(url)?.[1] || 'Image').replace(/\+/g, ' ').slice(0, 30);
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='450'><rect width='100%' height='100%' fill='%23242424'/><text x='50%' y='50%' fill='%23888' font-family='sans-serif' font-size='28' text-anchor='middle' dominant-baseline='middle'>${label.replace(/[<>&']/g, '')}</text></svg>`;
    return `<img${a}src="data:image/svg+xml;utf8,${svg}"${b}>`;
  });
  if (extImgs) fixes.push(`replaced ${extImgs} external image(s) with local placeholders`);

  // Safety net for off-canvas menus and oversized media on small screens
  if (!/overflow-x\s*:\s*(hidden|clip)/.test(css)) {
    css += '\nhtml, body { overflow-x: hidden; }\nimg, video, svg { max-width: 100%; height: auto; }\n';
    fixes.push('added overflow and media safety rules');
  }

  // Lorem ipsum
  if (/lorem ipsum/i.test(html)) { html = html.replace(/lorem ipsum[^<]*/gi, '[Add text]'); fixes.push('replaced lorem ipsum'); }

  // Footer year hook without JS support
  if (!/prefers-reduced-motion/.test(css)) {
    css += '\n@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }\n}\n';
    fixes.push('added reduced-motion rule');
  }

  // Safety net: content must never stay invisible because a reveal animation failed to run
  if (!/__wsRevealGuard/.test(js)) {
    js += `

// Reveal guard: if any content block is still fully transparent after it has been on screen, show it.
(function __wsRevealGuard() {
  var sel = 'section, article, header, footer, h1, h2, h3, p, li, img, figure, .card, [class*="reveal"], [class*="fade"], [class*="animate"]';
  function inView(r) { return r.bottom > 0 && r.top < (window.innerHeight || 800) && r.width > 0; }
  function sweep() {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      var el = els[i], r = el.getBoundingClientRect();
      if (!inView(r)) continue;
      var cs = getComputedStyle(el);
      if (cs.opacity === '0' || cs.visibility === 'hidden') {
        el.style.transition = 'opacity .4s ease, transform .4s ease';
        el.style.opacity = '1'; el.style.visibility = 'visible'; el.style.transform = 'none';
      }
    }
  }
  var t; function schedule() { clearTimeout(t); t = setTimeout(sweep, 700); }
  window.addEventListener('load', function () { setTimeout(sweep, 900); });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  setTimeout(sweep, 1500);
})();
`;
    fixes.push('added reveal guard');
  }

  return { files: { 'index.html': html, 'styles.css': css, 'script.js': js }, fixes };
}

function check(files, ctx) {
  const errors = [], warnings = [];
  const html = files['index.html'] || '';
  const css = files['styles.css'] || '';
  const js = files['script.js'] || '';
  const text = stripTags(html);
  const req = ctx.request || {};
  const c = req.client || {};

  // Hard requirements
  if (html.length < 2500) errors.push(`index.html is very small (${html.length} bytes)`);
  if (css.length < 2500) errors.push(`styles.css is very small (${css.length} bytes)`);
  if (!/<html[^>]*\blang=/i.test(html)) warnings.push('html element has no lang attribute');
  if (!/<title>[^<]{2,}<\/title>/i.test(html)) errors.push('missing <title>');
  const h1s = (html.match(/<h1\b/gi) || []).length;
  if (h1s !== 1) errors.push(`expected exactly one h1, found ${h1s}`);
  const sections = (html.match(/<section\b/gi) || []).length;
  if (sections < 3) errors.push(`only ${sections} <section> element(s)`);
  const lower = text.toLowerCase();
  const firstName = (c.fullName || '').toLowerCase().split(' ')[0];
  const bizName = (req.business?.name || '').toLowerCase();
  if (firstName && !lower.includes(firstName) && !(bizName && lower.includes(bizName))) errors.push('client name (or business name) does not appear on the page');
  if (c.email && !html.toLowerCase().includes(c.email.toLowerCase())) errors.push('client email does not appear on the page');
  if (/lorem ipsum/i.test(html)) errors.push('lorem ipsum present');
  if (/<script[^>]+src=["']https?:/i.test(html)) errors.push('external script tag present');
  if (/<img[^>]+src=["']https?:\/\/(?!fonts)/i.test(html)) errors.push('external image URL present');
  try { new vm.Script(js); } catch (e) { errors.push(`script.js syntax error: ${e.message}`); }
  if (!/@media/.test(css)) errors.push('styles.css has no media queries');

  // Placeholders and copy quality
  const placeholders = (html.match(/\[Add [^\]]*\]/g) || []).length;
  if (placeholders > 8) warnings.push(`${placeholders} placeholder markers; the client will need to fill in a lot`);
  if (/[—–]/.test(html)) warnings.push('dash characters present');
  const bangs = (text.match(/!/g) || []).length;
  if (bangs > 2) warnings.push(`${bangs} exclamation marks in copy`);
  const filler = text.match(/\b(passionate about|crafted with care|seamless|elevate|journey|unlock|game-changing|cutting-edge)\b/gi) || [];
  if (filler.length) warnings.push(`filler phrases: ${[...new Set(filler.map(f => f.toLowerCase()))].join(', ')}`);

  // Structure and accessibility
  if (!/:root\s*{/.test(css)) warnings.push('no :root custom properties');
  if (!/focus-visible|:focus/.test(css)) warnings.push('no focus styles');
  if (!/<nav\b/i.test(html)) warnings.push('no <nav> element');
  if (!/<footer\b/i.test(html)) warnings.push('no <footer> element');
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter(t => !/\balt=/i.test(t)).length;
  if (noAlt) warnings.push(`${noAlt} image(s) without alt text`);
  if (!/fonts\.googleapis\.com/.test(html)) warnings.push('no web font loaded');

  // Assets usage
  const assets = ctx.assets || [];
  const images = assets.filter(a => /\.(png|jpe?g|webp|gif|svg)$/i.test(a));
  const usedImages = images.filter(a => html.includes(`assets/${a}`) || css.includes(`assets/${a}`));
  if (images.length && usedImages.length < Math.min(images.length, 3)) warnings.push(`only ${usedImages.length} of ${images.length} available image(s) used`);
  const missingRefs = [...html.matchAll(/assets\/([^"')\s]+)/g)].map(m => decodeURIComponent(m[1])).filter(f => !assets.includes(f));
  if (missingRefs.length) errors.push(`references to missing assets: ${[...new Set(missingRefs)].join(', ')}`);

  // Social links: must not invent
  const s = req.social || {};
  const socials = { github: /github\.com/i, linkedin: /linkedin\.com/i, twitter: /(twitter\.com|x\.com)/i };
  for (const [k, re] of Object.entries(socials)) {
    if (!s[k] && re.test(html)) warnings.push(`links to ${k} although the client gave none`);
  }

  // Booking intent
  const wantsBooking = /book|booking|appointment|reserve/i.test(req.website?.description || '');
  if (wantsBooking && !/mailto:/i.test(html)) errors.push('client asked for booking but there is no mailto link');

  const score = Math.max(0, 100 - errors.length * 15 - warnings.length * 4);
  return { ok: errors.length === 0, score, errors, warnings };
}

/** Compact outline of the page for the coverage reviewer: headings, buttons, links, and a text sample. */
function outline(html) {
  const pick = (re) => [...html.matchAll(re)].map(m => stripTags(m[1]).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const heads = pick(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi);
  const buttons = pick(/<(?:a|button)[^>]*class=["'][^"']*btn[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|button)>/gi);
  const links = [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]).filter(h => /^(mailto:|tel:|https?:)/.test(h));
  const ids = [...html.matchAll(/<section[^>]*id=["']([^"']+)["']/gi)].map(m => m[1]);
  const text = stripTags(html).replace(/\s+/g, ' ').trim().slice(0, 3500);
  return `SECTIONS: ${ids.join(', ')}\nHEADINGS: ${heads.join(' | ')}\nBUTTONS: ${buttons.join(' | ')}\nLINKS: ${[...new Set(links)].join(' ')}\nTEXT: ${text}`;
}

function coveragePrompt(request, html) {
  const w = request.website || {};
  return `You are reviewing a generated website against the client's brief. Be strict but fair: only list things the client explicitly asked for that are missing, wrong, or use the wrong contact details.

CLIENT BRIEF
Type: ${w.type || ''}
Description: ${w.description || ''}
Extra notes: ${request.extraNotes || ''}
Client email: ${request.client?.email || ''}

GENERATED PAGE OUTLINE
${outline(html)}

Reply with JSON only, no prose: {"missing": ["short description of each missing or wrong item"]}
Use an empty array if everything requested is present.`;
}

function parseCoverage(text) {
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (!m) return [];
  try { const j = JSON.parse(m[0]); return Array.isArray(j.missing) ? j.missing.map(String).filter(Boolean).slice(0, 8) : []; } catch { return []; }
}

module.exports = { autoFix, check, coveragePrompt, parseCoverage };
