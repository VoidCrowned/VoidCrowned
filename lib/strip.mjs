// Shared SVG strip renderer. Used by generate.mjs (Node) and the Worker,
// so it must not import anything platform-specific.

// 846 is the width of the README column on a desktop profile page, so one
// unit is one CSS pixel there. That keeps a pixel font on its native grid.
export const W = 846;
export const PAD = 30; // left/right text padding inside the window
export const ROW = 26; // height of one text row
const RADIUS = 10;

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// FNV-1a, 32 bit
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (v) => +v.toFixed(2);

// Length in terminal cells (one code point = one cell; good enough for our text).
export const cells = (s) => [...s].length;

export function truncate(s, max) {
  const a = [...s];
  return a.length <= max ? s : a.slice(0, Math.max(1, max - 1)).join('').trimEnd() + '…';
}

// How many cells fit between the left and right padding.
export const maxCols = (font) => Math.floor((W - 2 * PAD) / (font.size * font.advance));

// All characters a list of rows needs from the font.
export function textOf(rows) {
  let out = '';
  for (const r of rows) {
    if (r.t === 'text') for (const s of r.segs) if (s.s) out += s.s;
    if (r.t === 'titlebar') out += r.title;
  }
  return out;
}

// Plain-text version of the rows, for alt attributes.
export function altOf(rows) {
  return rows
    .filter((r) => r.t === 'text')
    .map((r) => r.segs.map((s) => s.s ?? ({ note: '♪', spark: '✦', bracketTop: '┌', bracketBottom: '└' }[s.icon] ?? '')).join('').trim())
    .filter(Boolean)
    .join(' / ');
}

function rowHeight(r, wm) {
  switch (r.t) {
    case 'text': return r.h ?? ROW;
    case 'rule': return 18;
    case 'gap': return r.h;
    case 'titlebar': return 36;
    case 'wordmark': return r.art.length * wm.ch + 8;
    case 'bar': return 12;
    default: throw new Error('unknown row type ' + r.t);
  }
}

function sparkPath(cx, cy, r, pinch = 0.22) {
  const p = r * pinch;
  return `M${n(cx)} ${n(cy - r)}L${n(cx + p)} ${n(cy - p)}L${n(cx + r)} ${n(cy)}L${n(cx + p)} ${n(cy + p)}L${n(cx)} ${n(cy + r)}L${n(cx - p)} ${n(cy + p)}L${n(cx - r)} ${n(cy)}L${n(cx - p)} ${n(cy - p)}Z`;
}

function notePath(cx, cy, s) {
  // quaver: head, stem, flag
  const hx = cx - s * 0.12, hy = cy + s * 0.3;
  const sx = hx + s * 0.2;
  return (
    `<ellipse cx="${n(hx)}" cy="${n(hy)}" rx="${n(s * 0.22)}" ry="${n(s * 0.17)}" transform="rotate(-20 ${n(hx)} ${n(hy)})"/>` +
    `<path d="M${n(sx)} ${n(hy)}V${n(cy - s * 0.42)}c${n(s * 0.05)} ${n(s * 0.2)} ${n(s * 0.3)} ${n(s * 0.18)} ${n(s * 0.26)} ${n(s * 0.45)}" fill="none" stroke="currentColor" stroke-width="${n(s * 0.09)}" stroke-linecap="round"/>`
  );
}

function wordmark(art, x0, y0, wm) {
  const { cw, ch } = wm;
  let rects = '';
  let lines = '';
  art.forEach((line, r) => {
    const chars = [...line];
    const y = y0 + r * ch;
    let run = -1;
    for (let c = 0; c <= chars.length; c++) {
      const k = chars[c];
      if (k === '█') {
        if (run < 0) run = c;
        continue;
      }
      if (run >= 0) {
        rects += `M${n(x0 + run * cw)} ${n(y)}h${n((c - run) * cw)}v${n(ch + 0.4)}h${n(-(c - run) * cw)}z`;
        run = -1;
      }
      if (!k || k === ' ') continue;
      const l = x0 + c * cw, cx = l + cw / 2, rgt = l + cw, cy = y + ch / 2, b = y + ch;
      const seg = {
        '║': `M${n(cx)} ${n(y)}V${n(b)}`,
        '═': `M${n(l)} ${n(cy)}H${n(rgt)}`,
        '╔': `M${n(rgt)} ${n(cy)}H${n(cx)}V${n(b)}`,
        '╗': `M${n(l)} ${n(cy)}H${n(cx)}V${n(b)}`,
        '╚': `M${n(cx)} ${n(y)}V${n(cy)}H${n(rgt)}`,
        '╝': `M${n(cx)} ${n(y)}V${n(cy)}H${n(l)}`,
      }[k];
      if (seg) lines += seg;
    }
  });
  return (
    `<path d="${lines}" fill="none" stroke="${wm.shadow}" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<path d="${rects}" fill="url(#g)" shape-rendering="crispEdges"/>`
  );
}

/**
 * Render one strip of the terminal window.
 *
 * o.id      stable name, part of the star seed
 * o.theme   colours from config
 * o.font    { family, size, advance, b64 }  (b64 = subsetted woff2, may be empty)
 * o.rows    list of rows, see rowHeight() for the types
 * o.cap     'top' | 'bottom' | undefined: where the window's rounded end goes
 * o.stars   density multiplier (0 = none)
 */
export function renderStrip(o) {
  const { theme, font, rows } = o;
  const cw = font.size * font.advance;
  const wm = { cw: 0, ch: 16, shadow: theme.wordmarkShadow };

  let y = 0;
  let body = '';
  const boxes = []; // areas stars must avoid
  let defs = '';
  const gradient = (id, stops, x1, x2) => {
    defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n(x1)}" y1="0" x2="${n(x2)}" y2="0">${stops
      .map((c, i, a) => `<stop offset="${n(i / (a.length - 1))}" stop-color="${c}"/>`)
      .join('')}</linearGradient>`;
  };
  let needCursor = false;
  let barAnim = '';

  for (const r of rows) {
    const h = rowHeight(r, wm);
    if (r.t === 'titlebar') {
      const cy = y + h / 2;
      body += `<path d="M0.5 ${h}V${RADIUS + 0.5}a${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} -${RADIUS}H${W - RADIUS - 0.5}a${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} ${RADIUS}V${h}z" fill="${theme.bar}"/>`;
      body += `<path d="M1 ${h - 0.5}H${W - 1}" stroke="${theme.border}"/>`;
      theme.dots.forEach((c, i) => {
        body += `<circle cx="${22 + i * 18}" cy="${cy}" r="5" fill="${c}" opacity=".85"/>`;
      });
      const tw = cells(r.title) * cw;
      body += `<text x="${Math.round((W - tw) / 2)}" y="${Math.round(cy + font.size * 0.35)}" fill="${theme.title}" textLength="${n(tw)}" lengthAdjust="spacing">${esc(r.title)}</text>`;
      boxes.push([0, y, W, y + h]);
    } else if (r.t === 'text') {
      const base = Math.round(y + h / 2 + font.size * 0.35); // whole pixels: keeps pixel fonts sharp
      let col = r.indent ?? 0;
      const startCol = col;
      for (const s of r.segs) {
        const x = n(PAD + col * cw);
        const colour = theme[s.c] ?? theme.value;
        if (s.icon) {
          const cx = x + cw / 2, cy = y + h / 2;
          if (s.icon === 'spark') body += `<path d="${sparkPath(cx, cy, font.size * 0.42)}" fill="${colour}"/>`;
          if (s.icon === 'bracketTop' || s.icon === 'bracketBottom') {
            // One continuous prompt bracket, drawn as rectangles on whole pixels
            // so the two rows join and stay sharp with a pixel font.
            const t = Math.max(1, Math.round(font.size / 14));
            const bx = Math.round(x + cw / 2 - t / 2), by = Math.round(cy - t / 2), arm = Math.round(x + cw) - bx;
            const d = s.icon === 'bracketTop'
              ? `M${bx} ${y + h}V${by}h${arm}v${t}h${-(arm - t)}V${y + h}z`
              : `M${bx} ${y}V${by + t}h${arm}v${-t}h${-(arm - t)}V${y}z`;
            body += `<path d="${d}" fill="${colour}" shape-rendering="crispEdges"/>`;
          }
          if (s.icon === 'note') body += `<g fill="${colour}" color="${colour}">${notePath(cx, cy, font.size)}</g>`;
          col += 1;
        } else if (s.cursor) {
          needCursor = true;
          body += `<rect class="c" x="${x}" y="${n(y + h / 2 - font.size * 0.62)}" width="${n(cw * 0.95)}" height="${n(font.size * 1.24)}" fill="${colour}"/>`;
          col += 1;
        } else if (s.s) {
          // Never let a <text> start or end with a space: collapsed whitespace
          // plus textLength would stretch the letters.
          const len = cells(s.s);
          const inner = s.s.trim();
          if (inner) {
            const lead = cells(s.s) - cells(s.s.trimStart());
            body += `<text x="${n(x + lead * cw)}" y="${base}" fill="${colour}" textLength="${n(cells(inner) * cw)}" lengthAdjust="spacing">${esc(inner)}</text>`;
          }
          col += len;
        }
      }
      boxes.push([PAD + startCol * cw - 6, y, PAD + col * cw + 6, y + h]);
    } else if (r.t === 'rule') {
      const ly = n(Math.round(y + h / 2) + 0.5);
      body += `<path d="M${PAD} ${ly}h${n((r.w ?? 28) * cw)}" stroke="${theme.faint}"/>`;
      boxes.push([PAD - 6, y, PAD + (r.w ?? 28) * cw + 6, y + h]);
    } else if (r.t === 'wordmark') {
      // starts at the same indent as the text rows and fills the rest of the width
      const cols = Math.max(...r.art.map((l) => cells(l)));
      const x0 = n(PAD + 2 * cw);
      wm.cw = Math.floor(Math.min((W - PAD - x0) / cols, wm.ch * 0.58)); // whole pixels per cell
      gradient('g', theme.wordmark, x0, x0 + cols * wm.cw);
      body += wordmark(r.art, x0, y + 4, wm);
      boxes.push([x0 - 6, y, x0 + cols * wm.cw + 6, y + h]);
    } else if (r.t === 'bar') {
      const x = n(PAD + (r.indent ?? 0) * cw);
      const w = n(Math.min(r.w ?? 40, maxCols(font) - (r.indent ?? 0)) * cw);
      gradient('p', theme.progress, x, x + w);
      const by = n(y + 2);
      const p = Math.min(1, Math.max(0, r.progress ?? 0));
      body += `<rect x="${x}" y="${by}" width="${w}" height="3" rx="1.5" fill="${theme.faint}"/>`;
      body += `<rect class="p" x="${x}" y="${by}" width="${w}" height="3" rx="1.5" fill="url(#p)" style="transform-origin:${x}px 0;transform:scaleX(${n(p)})"/>`;
      if (r.remainingMs > 0 && p < 1) {
        barAnim = `@keyframes p{to{transform:scaleX(1)}}.p{animation:p ${Math.round(r.remainingMs)}ms linear forwards}`;
      }
      boxes.push([x - 6, y, x + w + 6, y + h]);
    }
    y += h;
  }
  const H = y;

  // --- stars -------------------------------------------------------------
  let stars = '';
  const density = o.stars ?? 1;
  if (density > 0) {
    const rand = rng(hash(o.id + '|' + JSON.stringify(rows)));
    const count = Math.round(((W * H) / 10500) * density);
    const marginY = Math.min(6, H / 2 - 1);
    for (let i = 0; i < count; i++) {
      let sx = 0, sy = 0, ok = false;
      for (let t = 0; t < 24 && !ok; t++) {
        sx = 16 + rand() * (W - 32);
        sy = marginY + rand() * (H - 2 * marginY);
        ok = !boxes.some(([a, b, c, d]) => sx > a - 6 && sx < c + 6 && sy > b - 2 && sy < d + 2);
      }
      const kind = rand(), colour = theme.stars[Math.floor(rand() * theme.stars.length)];
      const op = n(0.35 + rand() * 0.5), delay = n(rand() * 6), dur = n(3 + rand() * 4);
      if (!ok) continue;
      const attrs = `class="s" opacity="${op}" style="animation-delay:-${delay}s;animation-duration:${dur}s"`;
      const size = Math.min(marginY, 4.5);
      if (kind < 0.45) stars += `<circle ${attrs} cx="${n(sx)}" cy="${n(sy)}" r="${kind < 0.25 ? 0.9 : 1.4}" fill="${colour}"/>`;
      else if (kind < 0.7) stars += `<path ${attrs} d="${sparkPath(sx, sy, size)}" fill="${colour}"/>`;
      else if (kind < 0.88) stars += `<path ${attrs} d="${sparkPath(sx, sy, size * 0.9, 0.3)}" fill="none" stroke="${colour}" stroke-width=".8"/>`;
      else stars += `<path ${attrs} d="M${n(sx - 2.5)} ${n(sy)}h5M${n(sx)} ${n(sy - 2.5)}v5" stroke="${colour}" stroke-width=".9" stroke-linecap="round"/>`;
    }
  }

  // --- window background and border ---------------------------------------
  // A rounded rectangle that overshoots every edge without a cap, so the
  // strips join without the border or the background ending early.
  const top = o.cap === 'top' ? 0.5 : -30;
  const bottom = o.cap === 'bottom' ? H - 0.5 : H + 30;
  const frame = `<rect x="0.5" y="${top}" width="${W - 1}" height="${bottom - top}" rx="${RADIUS}" fill="${theme.bg}" stroke="${theme.border}"/>`;

  // --- styles --------------------------------------------------------------
  let css = '';
  if (font.b64) css += `@font-face{font-family:"${font.family}";src:url(data:font/woff2;base64,${font.b64}) format("woff2")}`;
  css += `text{font-family:"${font.family}",ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:${font.size}px;white-space:pre}`;
  let motion = '';
  if (stars) motion += `@keyframes t{50%{opacity:.12}}.s{animation:t 5s ease-in-out infinite}`;
  if (needCursor) motion += `@keyframes c{50%{opacity:0}}.c{animation:c 1.1s steps(1) infinite}`;
  motion += barAnim;
  if (motion) css += `@media (prefers-reduced-motion:no-preference){${motion}}`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">` +
    (o.title ? `<title>${esc(o.title)}</title>` : '') +
    `<style>${css}</style>${defs ? `<defs>${defs}</defs>` : ''}${frame}${stars}${body}</svg>\n`
  );
}

// --- row builders shared by the generator and the Worker ---------------------

const KEY_W = 9;

export function kvRow(key, valueSegs, opts = {}) {
  const segs = [{ s: '  ' }];
  if (opts.icon) {
    segs.push({ icon: opts.icon, c: 'icon' }, { s: ' ' + key.padEnd(KEY_W - 2), c: 'key' });
  } else {
    segs.push({ s: key.padEnd(KEY_W), c: 'key' });
  }
  segs.push({ s: key || opts.bullet ? '· ' : '  ', c: 'dim' }, ...valueSegs);
  return { t: 'text', segs };
}

export const VALUE_COL = 2 + KEY_W + 2;

// Rows of the now-playing strip. `track` is null when nothing plays.
export function nowRows(font, track, idleLine) {
  const room = maxCols(font) - VALUE_COL - 1;
  if (!track) return [kvRow('now', [{ s: truncate(idleLine, room), c: 'dim' }], { icon: 'note' })];
  const artist = truncate(track.artist, Math.max(12, Math.floor(room * 0.4)));
  const song = truncate(track.song, room - cells(artist) - 3);
  const rows = [kvRow('now', [{ s: song, c: 'value' }, { s: ' — ', c: 'dim' }, { s: artist, c: 'artist' }], { icon: 'note' })];
  if (track.progress != null) {
    rows.push({ t: 'bar', indent: VALUE_COL, w: 40, progress: track.progress, remainingMs: track.remainingMs });
  }
  return rows;
}
