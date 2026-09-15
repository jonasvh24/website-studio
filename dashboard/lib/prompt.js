'use strict';
/**
 * Turns a survey request into a generation prompt, and parses the
 * model's multi-file output back into { 'index.html', 'styles.css', 'script.js' }.
 */

const FILES = ['index.html', 'styles.css', 'script.js'];

function line(label, value) {
  return value ? `- ${label}: ${value}` : null;
}

function businessSection(b) {
  if (!b) return '';
  const lines = [
    `- Business name: ${b.name}`,
    b.type ? `- Category: ${b.type}` : null,
    b.summary ? `- Summary: ${b.summary}` : null,
    b.address ? `- Address: ${b.address}` : null,
    b.phone ? `- Phone: ${b.phone}` : null,
    b.website ? `- Existing website: ${b.website}` : null,
    b.mapsUrl ? `- Google Maps: ${b.mapsUrl}` : null,
    b.rating ? `- Google rating: ${b.rating} / 5 from ${b.reviewCount} reviews` : null,
    b.hours?.length ? `- Opening hours:\n${b.hours.map(h => `    ${h}`).join('\n')}` : null
  ].filter(Boolean).join('\n');

  const reviews = (b.reviews || []).map((r, i) =>
    `${i + 1}. ${r.author} (${r.rating}/5${r.when ? ', ' + r.when : ''}): "${r.text.replace(/\s+/g, ' ')}"`).join('\n');

  const photos = (b.photos || []).map((p, i) =>
    `- assets/${p.file}${p.width && p.height ? ` (${p.width}x${p.height})` : ''}${p.credit ? `, photo by ${p.credit}` : ''}`).join('\n');

  return `

BUSINESS DATA (from the public Google Business listing; use it)
${lines}
${reviews ? `\nCUSTOMER REVIEWS (real, quote them verbatim in a testimonials section with author name and star rating)\n${reviews}` : ''}
${photos ? `\nPHOTOS (already saved next to index.html; use them with <img src="assets/..."> in the hero and a gallery. Add descriptive alt text. Do not link to external image URLs.)\n${photos}` : ''}
`;
}

function uploadsSection(uploads) {
  if (!uploads || !uploads.length) return '';
  const images = uploads.filter(f => f.kind === 'image');
  const docs = uploads.filter(f => f.kind !== 'image');
  const lines = [];
  if (images.length) {
    lines.push('CLIENT PHOTOS (already saved next to index.html; use every one of them with <img src="assets/..."> and descriptive alt text; a file named like a logo goes in the header):');
    for (const f of images) lines.push(`- assets/${f.name}${f.width && f.height ? ` (${f.width}x${f.height})` : ''}`);
  }
  if (docs.length) {
    lines.push('CLIENT DOCUMENTS (link to them where relevant, e.g. a menu or price list as a download button):');
    for (const f of docs) lines.push(`- assets/${f.name} (${f.type || 'file'})`);
  }
  return `\n\n${lines.join('\n')}\n`;
}

function typeGuidance(type, description) {
  const t = (type || '').toLowerCase();
  const d = (description || '').toLowerCase();
  const out = [];
  if (t.includes('business') || /shop|salon|barber|restaurant|cafe|bakery|clinic|garage|studio|store|agency|company/.test(d)) {
    out.push('Business site: hero with the business name, a one-line promise and a primary call to action; services or menu section with 4 to 8 items and prices where the brief gives them (otherwise "[Add price]"); why-choose-us section with 3 points; reviews section; location and hours; contact section with a prominent call-to-action button.');
  }
  if (/book|booking|appointment|reserve|reservation/.test(d)) {
    out.push('Booking: add a clearly visible "Book now" button in the header and hero. It must be a mailto: link to the client email with a subject like "Booking request" and a prefilled body asking for name, phone, preferred date and time, and service. Repeat the button in the contact section.');
  }
  if (t.includes('portfolio') || t.includes('creator') || t.includes('freelancer')) {
    out.push('Portfolio: hero with name and role, selected work grid with at least 4 project cards (title, short description, tags), about section with the bio, skills or services list, contact section.');
  }
  if (t.includes('landing')) {
    out.push('Landing page: one clear offer above the fold, benefit grid, how-it-works in 3 steps, social proof, FAQ with 4 to 6 questions (details/summary), final call to action.');
  }
  if (!out.length) out.push('Include: hero, about, services or work, reviews or highlights, contact, footer.');
  return out.join('\n');
}

function buildPrompt(req, feedback, business, uploads) {
  const c = req.client || {};
  const w = req.website || {};
  const s = req.social || {};
  const dm = req.domain || {};

  const brief = [
    line('Full name', c.fullName),
    line('Email (for contact section and mailto links)', c.email),
    line('Location', c.location),
    line('Professional title / role', c.title),
    line('Short bio', c.bio),
    line('Website type', w.type),
    line('Style preferences', (w.stylePreferences || []).join(', ')),
    line('Color preference', w.colorPreference),
    line('Existing domain (mention it in the footer if given)', dm.name),
    line('GitHub', s.github),
    line('LinkedIn', s.linkedin),
    line('Twitter / X', s.twitter),
    line('Current website', s.currentWebsite),
    line('Extra notes', req.extraNotes)
  ].filter(Boolean).join('\n');

  const rebuild = feedback
    ? `\n\nTHIS IS A REBUILD. The previous version was rejected. Apply this feedback carefully:\n"""\n${feedback}\n"""\n`
    : '';

  const styles = (w.stylePreferences || []).map(x => x.toLowerCase());
  const dark = styles.includes('dark') || (!styles.includes('light') && !styles.length);

  return `You are a senior web designer and front-end engineer at a top agency. Build a complete, production-quality, fully responsive website for the client below. The result must look like a site a paying customer would be proud of, not a template.

CLIENT BRIEF
${brief}

WHAT THE CLIENT WANTS (their own words)
"""
${w.description || ''}
"""
${businessSection(business)}${uploadsSection(uploads)}${rebuild}
STRUCTURE FOR THIS SITE
${typeGuidance(w.type, w.description)}

DESIGN SYSTEM (follow exactly)
- ${dark ? 'Dark theme: near-black background (#0b0b0c or similar), light text, one accent color derived from the color preference.' : 'Light theme: off-white background, near-black text, one accent color derived from the color preference.'} Define everything as CSS custom properties in :root (--bg, --surface, --text, --muted, --accent, --accent-contrast, --border, --radius).
- Typography: load two Google Fonts (one display font for headings, one for body) via <link>. Fluid type scale with clamp(): h1 40 to 72px, h2 28 to 44px, body 16 to 18px. Line height 1.2 for headings, 1.6 for body. Letter-spacing -0.02em on large headings.
- Spacing: sections padded 96px top and bottom on desktop, 64px on mobile. Content container max-width 1140px with 24px side padding. Consistent 8px spacing grid.
- Components: sticky header with logo text and nav that collapses to a hamburger under 800px; buttons with hover and focus-visible states; cards with border, subtle shadow and hover lift; a footer with contact details, links and copyright.
- Hero must have visual impact: large headline, supporting line, two buttons, and either a client photo, a business photo, or a CSS-only decorative shape. Never leave the hero as plain text on a plain background.
- Motion: scroll-reveal via IntersectionObserver adding a class; respect prefers-reduced-motion.
- Accessibility: semantic landmarks, one h1, labelled controls, alt text, visible focus, contrast at least 4.5:1.
- Responsive: mobile-first with breakpoints at 600px, 800px and 1100px. Nothing overflows horizontally.

CONTENT RULES
- Use ALL the client's real information. Never invent a different name, email, phone, rating, review or address. Where information is missing write short realistic copy and mark it with "[Add ...]".
- Only link to social profiles the client actually provided.
- If BUSINESS DATA is present: show rating, address, phone and opening hours; quote the reviews verbatim as testimonials with author name and star rating; use the listed photos. Never invent reviews or photos.
- Write plain, direct copy. No em dashes, no exclamation marks, no emoji, no filler phrases like "passionate about", "crafted with care", "seamless", "elevate", "journey", "unlock". Short sentences. No lorem ipsum.
- No frameworks, no external JS libraries, no CDN scripts. Vanilla JS only. Google Fonts is the only external resource.

SIZE
- styles.css should be substantial (roughly 350 to 600 lines) and complete. index.html should contain real sections with real content (roughly 200 to 350 lines). script.js handles nav toggle, smooth scrolling, scroll reveal, footer year, and any small interactions (FAQ toggles, gallery lightbox if there are photos).

OUTPUT FORMAT (strict)
Output the three files, each preceded by a marker line, exactly like this. No markdown fences, no explanations before or after.

===FILE: index.html===
<!DOCTYPE html>
...full file...
===FILE: styles.css===
...full file...
===FILE: script.js===
...full file...
===END===`;
}

/**
 * Parse "===FILE: name===" delimited output. Tolerates code fences and
 * chatter before the first marker. Returns { files, missing }.
 */
function parseOutput(text) {
  const files = {};
  const re = /===\s*FILE:\s*([\w.\-\/]+)\s*===/gi;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ name: m[1].trim(), start: m.index, end: re.lastIndex });

  const endIdx = text.search(/===\s*END\s*===/i);

  for (let i = 0; i < marks.length; i++) {
    const next = marks[i + 1];
    let stop = next ? next.start : (endIdx > marks[i].end ? endIdx : text.length);
    let body = text.slice(marks[i].end, stop);
    body = stripFences(body).trim() + '\n';
    const name = marks[i].name.split('/').pop().toLowerCase();
    if (body.trim()) files[name] = body;
  }

  // Fallback: if no markers, but there's a full HTML document, take it.
  if (!files['index.html']) {
    const html = extractHtml(text);
    if (html) files['index.html'] = html;
  }

  const missing = FILES.filter(f => !files[f]);
  return { files, missing };
}

function stripFences(s) {
  return s
    .replace(/^\s*```[a-z]*\s*\n/i, '')
    .replace(/\n\s*```\s*$/i, '')
    .replace(/```[a-z]*\n?/gi, '');
}

function extractHtml(text) {
  const start = text.search(/<!doctype html/i) >= 0 ? text.search(/<!doctype html/i) : text.search(/<html/i);
  if (start < 0) return null;
  const endTag = text.lastIndexOf('</html>');
  const end = endTag >= 0 ? endTag + 7 : text.length;
  return stripFences(text.slice(start, end)).trim() + '\n';
}

module.exports = { buildPrompt, parseOutput, FILES };
