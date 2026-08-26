/**
 * Emits a standalone SVG from a resolved scene, once per theme.
 *
 * Why two files instead of one with `prefers-color-scheme`: GitHub renders README
 * images inside an <img> tag, and an <img>-embedded SVG cannot see the host page's
 * colour scheme — a media query inside it would always resolve to light. The
 * README therefore uses <picture> with two sources, which GitHub does honour.
 *
 * Everything is inline and uses generic font families only: GitHub sanitises SVG
 * and blocks external resources, so a webfont reference would silently fall back.
 */

import { THEMES } from './palette.js';

const SANS = "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const n = (v) => Math.round(v * 100) / 100;

/**
 * Guard against the one mistake this emitter is structurally prone to: an
 * attribute value containing a raw double quote, which silently closes the
 * attribute and produces a file that looks fine in a diff and fails to render.
 * (It has happened once already — a font stack with "Segoe UI" in it.)
 * Inside any tag the double-quote count must be even.
 */
function assertWellFormed(lines) {
  lines.forEach((line, i) => {
    if (!line.startsWith('<')) return;
    const quotes = (line.match(/"/g) ?? []).length;
    if (quotes % 2 !== 0) {
      throw new Error(
        `unbalanced quotes in emitted SVG (line ${i + 1}) — an attribute value ` +
          `almost certainly contains a raw double quote:\n  ${line.slice(0, 160)}`
      );
    }
  });
}

export function emitSvg(scene, themeName) {
  const T = THEMES[themeName];
  const out = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" ` +
      `width="${scene.width}" height="${scene.height}" role="img" ` +
      `aria-label="${esc(scene.title)}" font-family="${SANS}">`
  );

  // Arrowheads must be defined per colour: SVG markers do not inherit stroke.
  out.push('<defs>');
  for (const [key, colour] of [['edge', T.edge], ['accent', T.edgeAccent]]) {
    out.push(
      `<marker id="ah-${key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" ` +
        `markerHeight="7" orient="auto-start-reverse">` +
        `<path d="M0,0 L10,5 L0,10 z" fill="${colour}"/></marker>`
    );
  }
  out.push('</defs>');

  out.push(`<rect width="100%" height="100%" fill="${T.page}"/>`);

  if (scene.title) {
    out.push(
      `<text x="40" y="46" font-size="22" font-weight="600" fill="${T.ink}">${esc(scene.title)}</text>`
    );
  }
  if (scene.subtitle) {
    out.push(`<text x="40" y="70" font-size="13" fill="${T.inkMuted}">${esc(scene.subtitle)}</text>`);
  }

  // --- Frames ---------------------------------------------------------------
  for (const f of scene.frames ?? []) {
    out.push(
      `<rect x="${n(f.x)}" y="${n(f.y)}" width="${n(f.w)}" height="${n(f.h)}" rx="12" ` +
        `fill="none" stroke="${T.frame}" stroke-width="1" stroke-dasharray="6 5"/>`
    );
    out.push(
      `<text x="${n(f.x + 14)}" y="${n(f.y - 8)}" font-size="13" font-weight="600" ` +
        `letter-spacing="0.08em" fill="${T.inkMuted}">${esc(f.label.toUpperCase())}</text>`
    );
  }

  // --- Edges (below nodes, so arrows tuck under the boxes) -------------------
  for (const e of scene.edges ?? []) {
    const colour = e.accent ? T.edgeAccent : T.edge;
    const marker = e.accent ? 'ah-accent' : 'ah-edge';
    const d = e.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(p.x)},${n(p.y)}`).join(' ');
    out.push(
      `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${e.accent ? 2.2 : 1.4}" ` +
        `stroke-linejoin="round" stroke-linecap="round"` +
        `${e.style === 'dashed' ? ' stroke-dasharray="7 5"' : ''} ` +
        `marker-end="url(#${marker})"${e.bidirectional ? ` marker-start="url(#${marker})"` : ''}/>`
    );
  }

  // --- Nodes ----------------------------------------------------------------
  for (const node of scene.nodes) {
    const tone = T.kinds[node.kind] ?? T.kinds.store;
    out.push(
      `<rect x="${n(node.x)}" y="${n(node.y)}" width="${n(node.w)}" height="${n(node.h)}" rx="10" ` +
        `fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="1.6"/>`
    );

    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;
    const labelY = node.sub ? cy - 6 : cy;

    out.push(
      `<text x="${n(cx)}" y="${n(labelY)}" dy="0.35em" text-anchor="middle" font-size="15" ` +
        `font-weight="600" fill="${tone.text}">${esc(node.label)}</text>`
    );
    if (node.sub) {
      out.push(
        `<text x="${n(cx)}" y="${n(cy + 14)}" dy="0.35em" text-anchor="middle" font-size="11.5" ` +
          `font-family="${MONO}" fill="${tone.stroke}">${esc(node.sub)}</text>`
      );
    }
  }

  // --- Edge labels last, on a plate so they stay readable over the line ------
  for (const e of scene.edges ?? []) {
    if (!e.label) continue;
    const colour = e.accent ? T.edgeAccent : T.inkMuted;
    const w = e.label.length * 6.4 + 12;
    out.push(
      `<rect x="${n(e.labelAt.x - w / 2)}" y="${n(e.labelAt.y - 9)}" width="${n(w)}" height="18" ` +
        `rx="5" fill="${T.page}" stroke="none"/>`
    );
    out.push(
      `<text x="${n(e.labelAt.x)}" y="${n(e.labelAt.y)}" dy="0.35em" text-anchor="middle" ` +
        `font-size="11" font-family="${MONO}" fill="${colour}">${esc(e.label)}</text>`
    );
  }

  // --- Annotations ----------------------------------------------------------
  for (const note of scene.notes ?? []) {
    const size = note.size ?? 12.5;
    const colour = note.tone === 'accent' ? T.edgeAccent : T.inkMuted;
    const anchor = note.align === 'center' ? 'middle' : note.align === 'right' ? 'end' : 'start';
    const lines = note.text.split('\n');
    out.push(`<text x="${n(note.x)}" y="${n(note.y + size)}" font-size="${size}" fill="${colour}" text-anchor="${anchor}">`);
    lines.forEach((line, i) => {
      out.push(
        `<tspan x="${n(note.x)}"${i ? ` dy="${size * 1.45}"` : ''}>${esc(line)}</tspan>`
      );
    });
    out.push('</text>');
  }

  out.push('</svg>');

  assertWellFormed(out);
  return out.join('\n');
}
