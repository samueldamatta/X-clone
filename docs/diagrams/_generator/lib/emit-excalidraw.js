/**
 * Emits a valid Excalidraw v2 scene (`.excalidraw`) from a resolved scene.
 *
 * Two properties matter as much as correctness here:
 *
 *  1. DETERMINISM. Every id, seed and nonce is derived from a fixed PRNG and the
 *     timestamp is a constant, so re-running the generator on an unchanged scene
 *     produces a byte-identical file. Without this, every build would show up as
 *     a huge meaningless diff and the file would be unreviewable in a PR.
 *
 *  2. EDITABILITY. Labels are *bound* to their boxes and each box is grouped with
 *     its subtitle, so dragging a service in excalidraw.com moves the whole thing
 *     and arrows stay attached. A diagram you cannot comfortably edit by hand is
 *     just a picture.
 */

import { EXCALIDRAW_THEME as T } from './palette.js';
import { measureText } from './scene.js';

/** Fixed clock: determinism beats a real timestamp nobody reads. */
const UPDATED = 1735689600000; // 2025-01-01T00:00:00Z

/** Deterministic PRNG (mulberry32) — same scene in, same numbers out. */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABEL_SIZE = 16;
const SUB_SIZE = 12;
const FRAME_LABEL_SIZE = 14;
const LINE_HEIGHT = 1.25;

/** Excalidraw font ids: 1 = hand-drawn (Excalifont), 2 = normal, 3 = code. */
const FONT_HAND = 1;
const FONT_CODE = 3;

export function emitExcalidraw(scene) {
  const rng = makeRng(0xc10ffee);
  const id = (prefix) => `${prefix}-${Math.floor(rng() * 1e12).toString(36)}`;
  const seed = () => Math.floor(rng() * 2 ** 31);

  const base = () => ({
    angle: 0,
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: [],
    updated: UPDATED,
    link: null,
    locked: false,
  });

  const elements = [];

  // --- Frames first, so they sit behind everything they contain ---------------
  for (const f of scene.frames ?? []) {
    elements.push({
      ...base(),
      id: id('frame'),
      type: 'rectangle',
      x: f.x,
      y: f.y,
      width: f.w,
      height: f.h,
      strokeColor: T.frame,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'dashed',
      roughness: 0,
      roundness: { type: 3 },
    });

    elements.push({
      ...base(),
      id: id('frameLabel'),
      type: 'text',
      x: f.x + 14,
      y: f.y - FRAME_LABEL_SIZE - 8,
      width: measureText(f.label, FRAME_LABEL_SIZE),
      height: FRAME_LABEL_SIZE * LINE_HEIGHT,
      strokeColor: T.inkMuted,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      roundness: null,
      text: f.label,
      originalText: f.label,
      fontSize: FRAME_LABEL_SIZE,
      fontFamily: FONT_HAND,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: LINE_HEIGHT,
    });
  }

  // --- Nodes: rectangle + bound label + optional subtitle, grouped ------------
  for (const n of scene.nodes) {
    const tone = T.kinds[n.kind] ?? T.kinds.store;
    const groupId = id('g');
    const rectId = id('rect');
    const labelId = id('label');

    const hasSub = Boolean(n.sub);
    // Nudge the bound label up when a subtitle sits underneath, so the pair
    // reads as one centred block rather than two competing lines.
    const labelH = LABEL_SIZE * LINE_HEIGHT;
    const labelY = hasSub ? n.y + n.h / 2 - labelH + 4 : n.y + n.h / 2 - labelH / 2;

    elements.push({
      ...base(),
      id: rectId,
      type: 'rectangle',
      x: n.x,
      y: n.y,
      width: n.w,
      height: n.h,
      strokeColor: tone.stroke,
      backgroundColor: tone.fill,
      fillStyle: 'solid',
      groupIds: [groupId],
      boundElements: [{ id: labelId, type: 'text' }],
    });

    elements.push({
      ...base(),
      id: labelId,
      type: 'text',
      x: n.x + 8,
      y: labelY,
      width: n.w - 16,
      height: labelH,
      strokeColor: tone.text,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      roundness: null,
      groupIds: [groupId],
      text: n.label,
      originalText: n.label,
      fontSize: LABEL_SIZE,
      fontFamily: FONT_HAND,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: rectId,
      autoResize: false,
      lineHeight: LINE_HEIGHT,
    });

    if (hasSub) {
      const subW = measureText(n.sub, SUB_SIZE);
      elements.push({
        ...base(),
        id: id('sub'),
        type: 'text',
        x: n.x + n.w / 2 - subW / 2,
        y: labelY + labelH + 2,
        width: subW,
        height: SUB_SIZE * LINE_HEIGHT,
        strokeColor: tone.stroke,
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        roundness: null,
        groupIds: [groupId],
        text: n.sub,
        originalText: n.sub,
        fontSize: SUB_SIZE,
        fontFamily: FONT_CODE,
        textAlign: 'center',
        verticalAlign: 'top',
        containerId: null,
        autoResize: true,
        lineHeight: LINE_HEIGHT,
      });
    }

    n._rectId = rectId;
  }

  // --- Edges: arrows bound to both endpoints so they follow when boxes move ---
  for (const e of scene.edges ?? []) {
    const from = scene.nodes.find((n) => n.id === e.from);
    const to = scene.nodes.find((n) => n.id === e.to);
    const origin = e.points[0];

    const xs = e.points.map((p) => p.x);
    const ys = e.points.map((p) => p.y);
    const arrowId = id('arrow');
    const stroke = e.accent ? T.edgeAccent : T.edge;

    const arrow = {
      ...base(),
      id: arrowId,
      type: 'arrow',
      x: origin.x,
      y: origin.y,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      strokeColor: stroke,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: e.accent ? 2.5 : 1.5,
      strokeStyle: e.style === 'dashed' ? 'dashed' : 'solid',
      roughness: 0,
      roundness: { type: 2 },
      points: e.points.map((p) => [p.x - origin.x, p.y - origin.y]),
      lastCommittedPoint: null,
      startBinding: { elementId: from._rectId, focus: 0, gap: 6 },
      endBinding: { elementId: to._rectId, focus: 0, gap: 6 },
      startArrowhead: e.bidirectional ? 'arrow' : null,
      endArrowhead: 'arrow',
      elbowed: false,
      boundElements: [],
    };

    // Excalidraw keeps bindings in sync from BOTH sides; without registering the
    // arrow on each box's boundElements, dragging a box leaves the arrow behind.
    for (const box of [from, to]) {
      const rect = elements.find((el) => el.id === box._rectId);
      rect.boundElements = [...rect.boundElements, { id: arrowId, type: 'arrow' }];
    }

    if (e.label) {
      const labelId = id('edgeLabel');
      arrow.boundElements = [{ id: labelId, type: 'text' }];
      const w = measureText(e.label, SUB_SIZE);
      elements.push(arrow);
      elements.push({
        ...base(),
        id: labelId,
        type: 'text',
        x: e.labelAt.x - w / 2,
        y: e.labelAt.y - (SUB_SIZE * LINE_HEIGHT) / 2,
        width: w,
        height: SUB_SIZE * LINE_HEIGHT,
        strokeColor: stroke,
        backgroundColor: T.page,
        fillStyle: 'solid',
        roundness: null,
        text: e.label,
        originalText: e.label,
        fontSize: SUB_SIZE,
        fontFamily: FONT_CODE,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: arrowId,
        autoResize: true,
        lineHeight: LINE_HEIGHT,
      });
      continue;
    }

    elements.push(arrow);
  }

  // --- Free-standing annotations --------------------------------------------
  for (const note of scene.notes ?? []) {
    const size = note.size ?? SUB_SIZE + 1;
    elements.push({
      ...base(),
      id: id('note'),
      type: 'text',
      x: note.x,
      y: note.y,
      width: measureText(note.text, size),
      height: size * LINE_HEIGHT * note.text.split('\n').length,
      strokeColor: note.tone === 'accent' ? T.edgeAccent : T.inkMuted,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      roundness: null,
      text: note.text,
      originalText: note.text,
      fontSize: size,
      fontFamily: FONT_HAND,
      textAlign: note.align ?? 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: LINE_HEIGHT,
    });
  }

  // Internal bookkeeping must not leak into the committed file.
  for (const n of scene.nodes) delete n._rectId;

  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://github.com/samueldamatta/X-clone — generated by docs/diagrams/_generator',
    elements,
    appState: {
      gridSize: 20,
      gridStep: 5,
      gridModeEnabled: false,
      viewBackgroundColor: T.page,
    },
    files: {},
  };
}
