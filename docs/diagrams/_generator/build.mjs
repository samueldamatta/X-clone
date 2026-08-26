#!/usr/bin/env node
/**
 * Diagram build: one layout spec in, three files out.
 *
 *   node docs/diagrams/_generator/build.mjs
 *
 * For each scene it writes, into docs/diagrams/:
 *   <name>.excalidraw   — editable scene for excalidraw.com
 *   <name>-light.svg    — README image, light theme
 *   <name>-dark.svg     — README image, dark theme
 *
 * Zero dependencies on purpose: `node build.mjs` must keep working years from
 * now without an install step, a lockfile, or a package that went unmaintained.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { emitExcalidraw } from './lib/emit-excalidraw.js';
import { emitSvg } from './lib/emit-svg.js';
import { measureText, resolveScene } from './lib/scene.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENES_DIR = join(HERE, 'scenes');
const OUT_DIR = join(HERE, '..');

/** Fail loudly on the mistakes that are easy to make while hand-editing a scene. */
function validate(scene) {
  const problems = [];
  const ids = new Set();

  for (const node of scene.nodes) {
    if (ids.has(node.id)) problems.push(`duplicate node id "${node.id}"`);
    ids.add(node.id);

    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      problems.push(`node "${node.id}" has non-finite coordinates`);
    }
    if (node.x < 0 || node.y < 0) problems.push(`node "${node.id}" starts off-canvas`);
    if (node.x + node.w > scene.width) problems.push(`node "${node.id}" overflows the canvas width`);
    if (node.y + node.h > scene.height) problems.push(`node "${node.id}" overflows the canvas height`);
  }

  for (const edge of scene.edges ?? []) {
    if (!ids.has(edge.from)) problems.push(`edge from unknown node "${edge.from}"`);
    if (!ids.has(edge.to)) problems.push(`edge to unknown node "${edge.to}"`);
  }

  // Overlap is almost always a layout slip rather than a deliberate choice.
  const list = scene.nodes;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const overlaps =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlaps) problems.push(`nodes "${a.id}" and "${b.id}" overlap`);
    }
  }

  return problems;
}

/**
 * Checks that can only run once geometry is resolved.
 *
 * The expensive mistake in a generated diagram is an arrow that visually passes
 * straight through a box it has nothing to do with: it reads as a connection
 * that does not exist, so the picture actively lies. Sampling each routed
 * segment against every unrelated node catches that deterministically, which
 * eyeballing a 1480px image does not.
 */
/**
 * Bounding boxes for every piece of free text the SVG emitter will draw.
 *
 * Overlapping labels are the failure mode that survives every other check: the
 * file is valid, the geometry is sound, and the picture is still unreadable
 * because three captions landed on top of each other. Widths use the same
 * approximation the emitter uses, so this tracks the real output.
 */
function textBoxes(scene) {
  const boxes = [];

  for (const f of scene.frames ?? []) {
    const label = f.label.toUpperCase();
    boxes.push({
      what: `frame label "${f.label}"`,
      x: f.x + 14,
      y: f.y - 8 - 13,
      w: measureText(label, 13),
      h: 13,
    });
  }

  for (const e of scene.edges ?? []) {
    if (!e.label) continue;
    const w = e.label.length * 6.4 + 12;
    boxes.push({
      what: `edge label "${e.label}" (${e.from} → ${e.to})`,
      x: e.labelAt.x - w / 2,
      y: e.labelAt.y - 9,
      w,
      h: 18,
    });
  }

  for (const note of scene.notes ?? []) {
    const size = note.size ?? 12.5;
    const lines = note.text.split('\n');
    const w = Math.max(...lines.map((l) => measureText(l, size)));
    const x = note.align === 'center' ? note.x - w / 2 : note.align === 'right' ? note.x - w : note.x;
    boxes.push({
      what: `note starting "${lines[0].slice(0, 40)}…"`,
      x,
      y: note.y,
      w,
      h: size * 1.45 * lines.length,
    });
  }

  return boxes;
}

function validateGeometry(scene) {
  const problems = [];
  const byId = new Map(scene.nodes.map((node) => [node.id, node]));
  const INSET = 3; // tolerance so an arrow terminating on a border is not a hit

  for (const edge of scene.edges) {
    const endpoints = new Set([edge.from, edge.to]);

    for (let i = 0; i < edge.points.length - 1; i++) {
      const p = edge.points[i];
      const q = edge.points[i + 1];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const steps = Math.max(2, Math.ceil(len / 2));

      for (const node of scene.nodes) {
        if (endpoints.has(node.id)) continue;

        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = p.x + (q.x - p.x) * t;
          const y = p.y + (q.y - p.y) * t;
          const inside =
            x > node.x + INSET &&
            x < node.x + node.w - INSET &&
            y > node.y + INSET &&
            y < node.y + node.h - INSET;
          if (inside) {
            problems.push(`edge ${edge.from} → ${edge.to} passes through node "${node.id}"`);
            s = steps;
            break;
          }
        }
      }
    }

    // An arrow must actually reach the box it claims to point at.
    const tip = edge.points[edge.points.length - 1];
    const target = byId.get(edge.to);
    const near =
      tip.x >= target.x - 12 &&
      tip.x <= target.x + target.w + 12 &&
      tip.y >= target.y - 12 &&
      tip.y <= target.y + target.h + 12;
    if (!near) problems.push(`edge ${edge.from} → ${edge.to} does not land on its target`);
  }

  for (const note of scene.notes ?? []) {
    const size = note.size ?? 12.5;
    const widest = Math.max(...note.text.split('\n').map((l) => measureText(l, size)));
    const left = note.align === 'center' ? note.x - widest / 2 : note.align === 'right' ? note.x - widest : note.x;
    if (left < 0 || left + widest > scene.width) {
      problems.push(`note at (${note.x}, ${note.y}) overflows the canvas horizontally`);
    }
    const lines = note.text.split('\n').length;
    if (note.y + size * 1.45 * lines > scene.height) {
      problems.push(`note at (${note.x}, ${note.y}) overflows the canvas vertically`);
    }
  }

  // Text-on-text collisions, and arrows cutting through labels.
  const boxes = textBoxes(scene);

  for (const edge of scene.edges) {
    for (const box of boxes) {
      // An edge's own label necessarily sits on its line.
      if (edge.label && box.what.includes(`(${edge.from} → ${edge.to})`)) continue;

      for (let i = 0; i < edge.points.length - 1; i++) {
        const p = edge.points[i];
        const q = edge.points[i + 1];
        const steps = Math.max(2, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 2));
        let hit = false;
        for (let s = 0; s <= steps && !hit; s++) {
          const t = s / steps;
          const x = p.x + (q.x - p.x) * t;
          const y = p.y + (q.y - p.y) * t;
          hit = x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;
        }
        if (hit) {
          problems.push(`edge ${edge.from} → ${edge.to} crosses ${box.what}`);
          break;
        }
      }
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlaps =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      if (overlaps) problems.push(`${a.what} overlaps ${b.what}`);
    }
  }

  return problems;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const files = (await readdir(SCENES_DIR)).filter((f) => f.endsWith('.js')).sort();
  if (files.length === 0) throw new Error('no scenes found');

  let failed = false;

  for (const file of files) {
    const mod = await import(pathToFileURL(join(SCENES_DIR, file)).href);
    const scene = mod.default;

    const problems = validate(scene);
    if (problems.length) {
      failed = true;
      console.error(`✗ ${scene.name}`);
      for (const p of problems) console.error(`    ${p}`);
      continue;
    }

    const resolved = resolveScene(scene);

    const geometryProblems = validateGeometry(resolved);
    if (geometryProblems.length) {
      failed = true;
      console.error(`✗ ${scene.name}`);
      for (const p of geometryProblems) console.error(`    ${p}`);
      continue;
    }

    await writeFile(
      join(OUT_DIR, `${scene.name}.excalidraw`),
      `${JSON.stringify(emitExcalidraw(resolved), null, 2)}\n`
    );
    await writeFile(join(OUT_DIR, `${scene.name}-light.svg`), `${emitSvg(resolved, 'light')}\n`);
    await writeFile(join(OUT_DIR, `${scene.name}-dark.svg`), `${emitSvg(resolved, 'dark')}\n`);

    console.log(
      `✓ ${scene.name}  (${scene.nodes.length} nodes, ${(scene.edges ?? []).length} edges)`
    );
  }

  if (failed) {
    console.error('\nbuild failed — fix the scene definitions above');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
