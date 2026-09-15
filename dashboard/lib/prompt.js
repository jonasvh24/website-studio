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

function buildPrompt(req, feedback, business) {
  const c = req.client || {};
  const w = req.website || {};
  const s = req.social || {};

  const brief = [
    line('Full name', c.fullName),
    line('Email (for contact section)', c.email),
    line('Location', c.location),
    line('Professional title / role', c.title),
    line('Short bio', c.bio),
    line('Website type', w.type),
    line('Style preferences', (w.stylePreferences || []).join(', ')),
    line('Color preference', w.colorPreference),
    line('GitHub', s.github),
    line('LinkedIn', s.linkedin),
    line('Twitter / X', s.twitter),
    line('Current website', s.currentWebsite),
    line('Extra notes', req.extraNotes)
  ].filter(Boolean).join('\n');

  const rebuild = feedback
    ? `\n\nTHIS IS A REBUILD. The previous version was rejected. Apply this feedback carefully:\n"""\n${feedback}\n"""\n`
    : '';

  return `You are a senior front-end engineer and designer. Build a complete, modern, fully responsive personal website for the client below.

CLIENT BRIEF
${brief}

WHAT THE CLIENT WANTS (their own words)
"""
${w.description || ''}
"""
${businessSection(business)}${rebuild}
REQUIREMENTS
- Produce exactly three files: index.html, styles.css, script.js. Nothing else.
- index.html must link "styles.css" and "script.js" with relative paths, include <meta name="viewport">, a <title> with the client's name, and semantic HTML5 sections (header/nav, hero, about, work or services, contact, footer).
- Use ALL the client's real information (name, title, bio, location, social links, email). Never invent a different name. Use short realistic placeholder copy only where information is missing, and mark it clearly with "[Add ...]".
- Only link to social profiles the client actually provided.
- If BUSINESS DATA is present: show the rating, address, phone and opening hours in a contact section, quote the reviews as testimonials, and use the listed photos. Never invent reviews, ratings or photos.
- Honour the style preferences and color preference. Derive a coherent palette (CSS custom properties in :root) from the color preference.
- Mobile-first, responsive with media queries, accessible (labels, alt text, focus states), fast (no frameworks, no external JS libraries, no CDN scripts). Google Fonts via <link> is allowed.
- script.js: mobile nav toggle, smooth scrolling, subtle scroll-reveal animations, current year in footer. Must be vanilla JS with no errors.
- styles.css: complete and polished. Tasteful spacing, typography hierarchy, hover/focus states, a hero with real visual impact.
- Write plain, direct copy. No em dashes, no exclamation marks, no filler phrases like "passionate about", "crafted with care", "let's build something amazing", "elevate", "seamless", "journey". Short sentences.
- No decorative gradients or glow effects unless the client asked for them. No emoji.
- No lorem ipsum. No markdown fences inside file contents. No explanations.

OUTPUT FORMAT (strict)
Output the three files, each preceded by a marker line, exactly like this:

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
