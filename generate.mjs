#!/usr/bin/env node
// Renders assets/*.svg, README.md and worker/src/generated.mjs from config.json.
//
//   node generate.mjs             fetch recent activity, write everything
//   node generate.mjs --offline   skip the GitHub API, use data/recent.json
//   node generate.mjs --preview   also write preview/index.html
//   node generate.mjs --check     self-test, prints JSON, writes nothing
//   --now=2026-01-31T12:00:00Z    pretend it is another day (for testing)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fontkit from 'fontkit';
import subsetFont from 'subset-font';
import { W, renderStrip, kvRow, nowRows, textOf, altOf, truncate, cells, maxCols, VALUE_COL, esc } from './lib/strip.mjs';
import { fetchRecent, mergeRecent, displayRepo } from './lib/recent.mjs';
import { bucket } from './lib/time.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const at = (...p) => path.join(ROOT, ...p);
const args = new Set(process.argv.slice(2));
const argValue = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const CHECK = args.has('--check');
const OFFLINE = args.has('--offline') || CHECK;
const NOW = argValue('now') ? new Date(argValue('now')) : new Date();

const config = JSON.parse(fs.readFileSync(at('config.json'), 'utf8'));

// config.theme maps roles to names from config.palette. Resolve them once, so
// the renderer and the Worker only ever see hex values.
const colour = (name) => {
  if (!(name in config.palette)) throw new Error(`config.theme uses "${name}", which is not in config.palette`);
  return config.palette[name];
};
const theme = Object.fromEntries(
  Object.entries(config.theme).map(([role, v]) => [role, Array.isArray(v) ? v.map(colour) : colour(v)]),
);

// --- fonts -------------------------------------------------------------------

const missingGlyphs = new Set();

function loadFont(name) {
  const def = config.fonts[name];
  if (!def) throw new Error(`config.font "${name}" is not in config.fonts`);
  const buffer = fs.readFileSync(at(def.file));
  const fk = fontkit.create(buffer);
  // cell width rounded to 1/100 px, so a pixel font lands on whole pixels
  const advance = Math.round((fk.glyphForCodePoint(0x4d).advanceWidth / fk.unitsPerEm) * def.size * 100) / 100 / def.size;
  return { name, family: def.family, size: def.size, advance, buffer, fk };
}

async function subset(font, text) {
  const chars = [...new Set([...text])].filter((c) => c !== ' ').sort();
  for (const c of chars) if (!font.fk.hasGlyphForCodePoint(c.codePointAt(0))) missingGlyphs.add(c);
  if (!chars.length) return '';
  const out = await subsetFont(font.buffer, chars.join(''), { targetFormat: 'woff2', noLayoutClosure: true });
  return Buffer.from(out).toString('base64');
}

// Wider subset for the Worker: track titles are not known in advance.
function workerGlyphs() {
  let s = '';
  for (let c = 0x20; c < 0x7f; c++) s += String.fromCodePoint(c);
  for (let c = 0xa0; c < 0x180; c++) if (c !== 0xad) s += String.fromCodePoint(c); // no soft hyphen
  return s + '–—…‘’“”·•';
}

// --- recent activity ---------------------------------------------------------

async function loadRecent() {
  const file = at('data/recent.json');
  const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  if (OFFLINE) return { list: stored, changed: false, error: null };
  let fetched = null;
  let error = null;
  try {
    fetched = await fetchRecent({
      user: config.user,
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      exclude: config.recent.exclude,
      count: config.recent.count,
    });
  } catch (e) {
    error = e.message; // keep showing the last known list
  }
  const list = mergeRecent(fetched, stored, config.recent.count);
  const changed = JSON.stringify(list) !== JSON.stringify(stored);
  return { list, changed, error };
}

// --- rows --------------------------------------------------------------------

// "text {highlighted} text" → segments
function valueSegs(value) {
  return value
    .split(/(\{[^}]*\})/)
    .filter(Boolean)
    .map((part) => (part.startsWith('{') ? { s: part.slice(1, -1), c: 'ref' } : { s: part, c: 'value' }));
}

function buildItems(font, recent) {
  const rule = () => ({ row: { t: 'rule', w: config.dividerWidth } });
  const [user, host] = config.host.split('@');
  const items = [
    { row: { t: 'titlebar', title: config.titlebar } },
    { row: { t: 'gap', h: 12 } },
    { row: { t: 'text', segs: [{ s: '┌', c: 'promptGlyph' }, { s: ' ' + config.prompt.path, c: 'promptPath' }] } },
    { row: { t: 'text', segs: [{ s: '└', c: 'promptGlyph' }, { s: ' ' + config.prompt.command, c: 'command' }] } },
    { row: { t: 'gap', h: 14 } },
    { row: { t: 'wordmark', art: config.wordmark } },
    { row: { t: 'gap', h: 12 } },
    { row: { t: 'text', segs: [{ s: '  ' }, { s: user, c: 'user' }, { s: '@', c: 'at' }, { s: host, c: 'host' }] } },
  ];

  for (const section of config.sections) {
    items.push(rule());
    for (const r of section) items.push({ name: r.key, link: r.link, row: kvRow(r.key, valueSegs(r.value)) });
  }

  items.push(rule());
  if (!recent.length) {
    items.push({ name: 'recent', row: kvRow('recent', [{ s: config.recent.emptyLine, c: 'dim' }]) });
  } else {
    const shown = recent.map((e) => ({
      ...e,
      label: truncate(displayRepo(e.repo, config.user), maxCols(font) - VALUE_COL - 24),
      when: bucket(e.at, NOW, config.timezone),
    }));
    const repoW = Math.max(...shown.map((e) => cells(e.label))) + 2;
    const refW = Math.max(...shown.map((e) => cells(e.ref))) + 2;
    shown.forEach((e, i) => {
      items.push({
        name: `recent-${i + 1}`,
        link: e.url,
        row: kvRow(
          i === 0 ? 'recent' : '',
          [{ s: e.label.padEnd(repoW), c: 'value' }, { s: e.ref.padEnd(refW), c: 'ref' }, { s: e.when, c: 'dim' }],
          { bullet: true },
        ),
      });
    });
  }

  items.push(rule());
  items.push({ name: 'now', link: config.nowPlaying.link, now: true, rows: nowRows(font, null, config.nowPlaying.placeholder) });
  items.push(rule());
  items.push({
    row: {
      t: 'text',
      segs: [{ s: '  ' }, { icon: 'spark', c: 'footerIcon' }, { s: ' ' + config.footer, c: 'footer' }, { s: ' ' }, { cursor: true, c: 'cursor' }],
    },
    name: 'footer',
  });
  items.push({ row: { t: 'gap', h: 16 } });
  return items;
}

// Every linked row is its own strip; everything between links is merged into
// one strip, so there are as few joins as possible.
function groupStrips(items) {
  const strips = [];
  let open = null;
  for (const it of items) {
    if (it.link) {
      open = null;
      strips.push({ name: it.name, href: it.link, rows: it.rows ?? [it.row], now: it.now });
    } else {
      if (!open) strips.push((open = { name: null, href: config.profileUrl, rows: [] }));
      open.rows.push(it.row);
      if (!open.name && it.name) open.name = it.name;
    }
  }
  strips.forEach((s, i) => {
    if (i === 0) s.cap = 'top';
    if (i === strips.length - 1) s.cap = 'bottom';
    const name = i === 0 ? 'head' : s.name ?? 'rule';
    s.file = `${String(i + 1).padStart(2, '0')}-${name}.svg`;
    s.alt = altOf(s.rows);
  });
  return strips;
}

async function build(fontName, recent) {
  const font = loadFont(fontName);
  const strips = groupStrips(buildItems(font, recent));
  for (const s of strips) {
    const b64 = await subset(font, textOf(s.rows));
    s.svg = renderStrip({
      id: s.file,
      theme,
      font: { family: font.family, size: font.size, advance: font.advance, b64 },
      rows: s.rows,
      cap: s.cap,
      stars: config.starDensity,
      title: s.alt,
    });
  }
  return { font, strips };
}

// --- outputs -----------------------------------------------------------------

function readme(strips, { align = config.readme?.align ?? 'left', prefix = 'assets/' } = {}) {
  const imgs = strips
    .map((s) => {
      const src = s.now && config.nowPlaying.workerUrl ? config.nowPlaying.workerUrl : prefix + s.file;
      return `<a href="${esc(s.href)}"><img src="${esc(src)}" width="100%" align="${align}" alt="${esc(s.alt)}"></a>`;
    })
    .join('');
  return (
    '<!-- Generated by generate.mjs from config.json. Do not edit by hand: see docs/HOW-IT-WORKS.md -->\n' +
    `<p>${imgs}</p>\n`
  );
}

async function workerModule(font) {
  // Only what the font really has; anything else falls back to a system font.
  const b64 = await subset(font, [...workerGlyphs()].filter((c) => font.fk.hasGlyphForCodePoint(c.codePointAt(0))).join(''));
  const data = {
    theme,
    font: { family: font.family, size: font.size, advance: font.advance, b64 },
    discordId: config.nowPlaying.discordId,
    idle: config.nowPlaying.idle,
    stars: config.starDensity,
  };
  return '// Generated by generate.mjs from config.json. Do not edit by hand.\n' + `export default ${JSON.stringify(data, null, 2)};\n`;
}

function writeIfChanged(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function expectedFiles(strips, readmeText, workerText) {
  const files = new Map();
  for (const s of strips) files.set(`assets/${s.file}`, s.svg);
  files.set('README.md', readmeText);
  files.set('worker/src/generated.mjs', workerText);
  return files;
}

// --- preview -----------------------------------------------------------------

async function writePreview(main, recent) {
  // One block per font in config.fonts, the configured one first.
  const variants = [{ label: `${main.font.name} (what README.md uses)`, strips: main.strips, prefix: '../assets/' }];
  for (const name of Object.keys(config.fonts).filter((f) => f !== main.font.name)) {
    const other = await build(name, recent);
    for (const s of other.strips) writeIfChanged(at('preview', name, s.file), s.svg);
    variants.push({ label: name, strips: other.strips, prefix: `${name}/` });
  }
  // Ask GitHub for its own sanitised HTML, so the preview uses the markup the
  // profile page will really get. Falls back to the raw markup when offline.
  const render = (md) => {
    try {
      return execFileSync('gh', ['api', 'markdown', '-f', 'mode=gfm', '-f', `text=${md}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return md;
    }
  };
  const widths = (argValue('widths') ?? '846,830,400').split(',').map(Number);
  const rendered = variants.map((v) => ({ ...v, html: render(readme(v.strips, { prefix: v.prefix })) }));
  const blocks = widths
    .map((w) => {
      const cols = rendered
        .map((v) => `<div class="col" style="width:${w}px"><div class="tag">${esc(v.label)}</div><article class="markdown-body">${v.html}</article></div>`)
        .join('');
      return `<section><h2>${w}px${w === W ? ' (desktop profile column, 1:1)' : ''}</h2><div class="cols">${cols}</div></section>`;
    })
    .join('\n');
  const html = `<!doctype html>
<html lang="en-GB" data-color-mode="dark" data-dark-theme="dark">
<meta charset="utf-8">
<title>Profile README preview</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.8.1/github-markdown-dark.min.css">
<style>
  body { margin: 0; padding: 24px; background: #0d1117; color: #8b949e; font: 13px system-ui, sans-serif; }
  h2 { font-size: 14px; color: #e6edf3; margin: 32px 0 12px; }
  .cols { display: flex; gap: 32px; align-items: flex-start; flex-wrap: wrap; }
  .col { flex: none; }
  .tag { margin-bottom: 6px; }
  .markdown-body { background: #0d1117; }
</style>
<body>
<p>Local preview. Uses GitHub's markdown CSS and (when <code>gh</code> is available) GitHub's own sanitised HTML.</p>
${blocks}
</body>
</html>
`;
  writeIfChanged(at('preview/index.html'), html);
}

// --- main --------------------------------------------------------------------

const recent = await loadRecent();
const main = await build(config.font, recent.list);
const readmeText = readme(main.strips);
const workerText = await workerModule(main.font);
const files = expectedFiles(main.strips, readmeText, workerText);

if (CHECK) {
  const svgs = main.strips.map((s) => s.svg);
  const again = await build(config.font, recent.list);
  const stale = [...files].filter(([f, c]) => !fs.existsSync(at(f)) || fs.readFileSync(at(f), 'utf8') !== c).map(([f]) => f);
  const base = main.strips.find((s) => s.alt.includes('@6uhrmittag'));
  const sizes = svgs.map((s) => Buffer.byteLength(s));
  const result = {
    strips: main.strips.length,
    sameViewBoxWidth: svgs.every((s) => s.includes(`viewBox="0 0 ${W} `)),
    allGlyphsInFont: missingGlyphs.size === 0,
    missingGlyphs: [...missingGlyphs],
    everyStripHasLink: main.strips.every((s) => /^(https:\/\/|mailto:)/.test(s.href)),
    marvLinkCorrect: base?.href === 'https://github.com/6uhrmittag',
    oneStripPerLinkedRow: main.strips.filter((s) => s.href !== config.profileUrl).every((s) => s.rows.filter((r) => r.t === 'text').length === 1),
    capsOnlyAtEnds: main.strips.every((s, i) => (s.cap === 'top') === (i === 0) && (s.cap === 'bottom') === (i === main.strips.length - 1)),
    noWhitespaceBetweenImages: !/>\s+</.test(readmeText.split('\n')[1]),
    readmeImageCount: (readmeText.match(/<img /g) ?? []).length,
    motionOnlyWhenAllowed: svgs.every((s) => !s.includes('animation:') || s.indexOf('@media (prefers-reduced-motion:no-preference)') < s.indexOf('animation:')),
    deterministic: again.strips.every((s, i) => s.svg === svgs[i]),
    recentDistinctRepos: new Set(recent.list.map((e) => e.repo)).size === recent.list.length && recent.list.length <= config.recent.count,
    recentCount: recent.list.length,
    filesUpToDate: stale.length === 0,
    staleFiles: stale,
    totalSvgKb: +(sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(1),
    largestSvgKb: +(Math.max(...sizes) / 1024).toFixed(1),
    workerModuleKb: +(Buffer.byteLength(workerText) / 1024).toFixed(1),
    nowPlayingSource: config.nowPlaying.workerUrl || 'static placeholder',
  };
  result.ok = Object.entries(result).every(([, v]) => v !== false);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (missingGlyphs.size) {
  console.error(`Not in the font (will fall back to a system font): ${[...missingGlyphs].join(' ')}`);
}
if (recent.error) console.error(`Recent activity not refreshed: ${recent.error}`);
if (recent.changed) writeIfChanged(at('data/recent.json'), JSON.stringify(recent.list, null, 2) + '\n');

const written = [];
for (const [f, c] of files) if (writeIfChanged(at(f), c)) written.push(f);
// remove strips that no longer exist
for (const f of fs.readdirSync(at('assets'))) {
  if (f.endsWith('.svg') && !files.has(`assets/${f}`)) {
    fs.rmSync(at('assets', f));
    written.push(`assets/${f} (removed)`);
  }
}
if (args.has('--preview')) await writePreview(main, recent.list);
console.log(written.length ? `Updated:\n  ${written.join('\n  ')}` : 'Nothing changed.');
