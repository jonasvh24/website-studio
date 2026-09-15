'use strict';
/**
 * Deterministic fallback generator. Used when no model is reachable, or
 * to fill in files the model forgot (e.g. it only returned index.html).
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pickAccent(pref) {
  const hex = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(pref || '');
  if (hex) return hex[0].length === 4
    ? '#' + hex[1].split('').map(c => c + c).join('')
    : hex[0];
  const p = (pref || '').toLowerCase();
  const table = [
    ['gold', '#d4a017'], ['yellow', '#facc15'], ['orange', '#f97316'], ['red', '#ef4444'],
    ['pink', '#ec4899'], ['purple', '#8b5cf6'], ['violet', '#a78bfa'], ['blue', '#3b82f6'],
    ['navy', '#1e3a8a'], ['teal', '#14b8a6'], ['cyan', '#06b6d4'], ['green', '#22c55e'],
    ['emerald', '#10b981'], ['black', '#111827'], ['white', '#e5e7eb'], ['grey', '#9ca3af'], ['gray', '#9ca3af']
  ];
  for (const [k, v] of table) if (p.includes(k)) return v;
  return '#ffd400';
}

function isDark(req) {
  const s = (req.website?.stylePreferences || []).map(x => x.toLowerCase());
  if (s.includes('light')) return false;
  if (s.includes('dark')) return true;
  return true;
}

function firstName(full) {
  return (full || 'there').trim().split(/\s+/)[0];
}

function generateSite(req) {
  const c = req.client || {}, w = req.website || {}, s = req.social || {};
  const name = c.fullName || 'Your Name';
  const title = c.title || `${w.type || 'Personal'} Website`;
  const accent = pickAccent(w.colorPreference);
  const dark = isDark(req);
  const bio = c.bio || `[Add a short bio for ${name}]`;
  const desc = w.description || '';
  const fn = firstName(name);

  const socials = [
    ['GitHub', s.github], ['LinkedIn', s.linkedin], ['Twitter / X', s.twitter], ['Website', s.currentWebsite]
  ].filter(([, url]) => url);

  const socialLinks = socials.map(([label, url]) =>
    `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('\n          ');

  const cards = [
    ['Who I am', bio],
    ['What I do', title],
    ['Based in', c.location || '[Add location]']
  ].map(([h, p]) => `
        <article class="card reveal">
          <h3>${esc(h)}</h3>
          <p>${esc(p)}</p>
        </article>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(name)} | ${esc(title)}</title>
  <meta name="description" content="${esc(bio.slice(0, 150))}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <nav class="nav container" aria-label="Main">
      <a class="brand" href="#top">${esc(fn)}<span class="dot">.</span></a>
      <button class="nav-toggle" aria-label="Toggle menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
      <ul class="nav-links">
        <li><a href="#about">About</a></li>
        <li><a href="#work">Work</a></li>
        <li><a href="#contact">Contact</a></li>
      </ul>
    </nav>
  </header>

  <main id="top">
    <section class="hero container">
      <p class="eyebrow reveal">${esc(title)}${c.location ? `, ${esc(c.location)}` : ''}</p>
      <h1 class="reveal"><span class="accent">${esc(name)}</span></h1>
      <p class="lead reveal">${esc(bio)}</p>
      <div class="hero-actions reveal">
        <a class="btn btn-primary" href="#work">Work</a>
        <a class="btn" href="#contact">Contact</a>
      </div>
    </section>

    <section id="about" class="section container">
      <h2 class="reveal">About</h2>
      <div class="cards">${cards}
      </div>
    </section>

    <section id="work" class="section container">
      <h2 class="reveal">Work</h2>
      <p class="section-intro reveal">${esc(desc || '[Describe your work, services or projects here]')}</p>
      <div class="cards">
        <article class="card reveal"><h3>[Project one]</h3><p>[Add a short description of a project, service or highlight.]</p></article>
        <article class="card reveal"><h3>[Project two]</h3><p>[Add a short description of a project, service or highlight.]</p></article>
        <article class="card reveal"><h3>[Project three]</h3><p>[Add a short description of a project, service or highlight.]</p></article>
      </div>
    </section>

    <section id="contact" class="section container contact">
      <h2 class="reveal">Contact</h2>
      <p class="reveal">Email:
        <a href="mailto:${esc(c.email || '')}">${esc(c.email || '[Add email]')}</a>.</p>
      ${socials.length ? `<div class="socials reveal">
          ${socialLinks}
        </div>` : ''}
    </section>
  </main>

  <footer class="footer container">
    <p>&copy; <span id="year"></span> ${esc(name)}. All rights reserved.</p>
  </footer>

  <script src="script.js"></script>
</body>
</html>
`;

  const css = dark ? darkCss(accent) : lightCss(accent);
  return { 'index.html': html, 'styles.css': css, 'script.js': baseJs() };
}

function baseCss(vars) {
  return `${vars}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.container { width: min(1100px, 92%); margin: 0 auto; }

.site-header {
  position: sticky; top: 0; z-index: 20;
  background: var(--header);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
}
.nav { display: flex; align-items: center; justify-content: space-between; height: 68px; }
.brand { font-weight: 800; font-size: 20px; color: var(--text); letter-spacing: -0.02em; }
.brand .dot { color: var(--accent); }
.nav-links { list-style: none; display: flex; gap: 28px; margin: 0; padding: 0; }
.nav-links a { color: var(--text-2); font-weight: 500; font-size: 15px; }
.nav-links a:hover { color: var(--text); text-decoration: none; }
.nav-toggle { display: none; background: none; border: 0; cursor: pointer; padding: 8px; }
.nav-toggle span { display: block; width: 24px; height: 2px; margin: 5px 0; background: var(--text); border-radius: 2px; transition: .2s; }

.hero { padding: 120px 0 90px; max-width: 800px; }
.eyebrow { color: var(--accent); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; font-size: 13px; margin: 0 0 16px; }
.hero h1 { font-size: clamp(40px, 7vw, 72px); line-height: 1.02; letter-spacing: -0.03em; margin: 0 0 22px; font-weight: 800; }
.accent { color: var(--accent); }
.lead { font-size: 19px; color: var(--text-2); max-width: 640px; margin: 0 0 32px; }
.hero-actions { display: flex; gap: 14px; flex-wrap: wrap; }

.btn {
  display: inline-flex; align-items: center; padding: 14px 24px;
  border-radius: 12px; font-weight: 600; font-size: 15px;
  border: 1px solid var(--line); color: var(--text); background: var(--card);
  transition: border-color .15s, background .15s;
}
.btn:hover { border-color: var(--accent); text-decoration: none; }
.btn-primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }

.section { padding: 70px 0; border-top: 1px solid var(--line); }
.section h2 { font-size: 34px; letter-spacing: -0.02em; margin: 0 0 24px; }
.section-intro { color: var(--text-2); max-width: 720px; font-size: 17px; margin: 0 0 32px; white-space: pre-line; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 26px; transition: border-color .2s; }
.card:hover { border-color: var(--accent); }
.card h3 { margin: 0 0 8px; font-size: 18px; }
.card p { margin: 0; color: var(--text-2); }

.contact p { font-size: 18px; color: var(--text-2); }
.socials { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
.socials a { padding: 10px 16px; border-radius: 999px; border: 1px solid var(--line); color: var(--text); font-weight: 500; }
.socials a:hover { border-color: var(--accent); text-decoration: none; }

.footer { padding: 40px 0; color: var(--text-3); font-size: 14px; border-top: 1px solid var(--line); }

.reveal { opacity: 0; transform: translateY(18px); transition: opacity .6s ease, transform .6s ease; }
.reveal.in { opacity: 1; transform: none; }

@media (max-width: 760px) {
  .nav-toggle { display: block; }
  .nav-links {
    position: absolute; top: 68px; left: 0; right: 0;
    flex-direction: column; gap: 0; background: var(--bg);
    border-bottom: 1px solid var(--line); display: none;
  }
  .nav-links.open { display: flex; }
  .nav-links li { padding: 16px 4%; border-top: 1px solid var(--line); }
  .hero { padding: 80px 0 60px; }
}
`;
}

function darkCss(accent) {
  return baseCss(`:root {
  --bg: #0b0f1e;
  --card: rgba(255,255,255,0.04);
  --header: rgba(11,15,30,0.75);
  --line: rgba(255,255,255,0.10);
  --text: #eef0ff;
  --text-2: #b1b6d4;
  --text-3: #7d83a8;
  --accent: ${accent};
  --on-accent: #0a0a0a;
}`);
}

function lightCss(accent) {
  return baseCss(`:root {
  --bg: #fafafc;
  --card: #ffffff;
  --header: rgba(250,250,252,0.8);
  --line: rgba(15,20,40,0.10);
  --text: #101425;
  --text-2: #4b5068;
  --text-3: #8a8fa8;
  --accent: ${accent};
  --on-accent: #ffffff;
}`);
}

function baseJs() {
  return `// Mobile navigation
const toggle = document.querySelector('.nav-toggle');
const links = document.querySelector('.nav-links');
if (toggle && links) {
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
}

// Scroll reveal
const reveals = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  reveals.forEach(el => io.observe(el));
} else {
  reveals.forEach(el => el.classList.add('in'));
}

// Footer year
const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();
`;
}

module.exports = { generateSite };
