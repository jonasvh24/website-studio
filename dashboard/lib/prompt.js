'use strict';
/**
 * Turns a survey request into a generation prompt, and parses the
 * model's multi-file output back into { 'index.html', 'styles.css', 'script.js' }.
 */

const FILES = ['index.html', 'styles.css', 'script.js'];

function line(label, value) {
  return value ? `- ${label}: ${value}` : null;
}

function buildPrompt(req, feedback) {
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
${rebuild}
REQUIREMENTS
- Produce exactly three files: index.html, styles.css, script.js. Nothing else.
- index.html must link "styles.css" and "script.js" with relative paths, include <meta name="viewport">, a <title> with the client's name, and semantic HTML5 sections (header/nav, hero, about, work or services, contact, footer).
- Use ALL the client's real information (name, title, bio, location, social links, email). Never invent a different name. Use short realistic placeholder copy only where information is missing, and mark it clearly with "[Add ...]".
- Only link to social profiles the client actually provided.
- Honour the style preferences and color preference. Derive a coherent palette (CSS custom properties in :root) from the color preference.
- Mobile-first, responsive with media queries, accessible (labels, alt text, focus states), fast (no frameworks, no external JS libraries, no CDN scripts). Google Fonts via <link> is allowed.
- script.js: mobile nav toggle, smooth scrolling, subtle scroll-reveal animations, current year in footer. Must be vanilla JS with no errors.
- styles.css: complete and polished. Tasteful spacing, typography hierarchy, hover/focus states, a hero with real visual impact.
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
