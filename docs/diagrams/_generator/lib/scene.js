/**
 * The shared scene model.
 *
 * A scene is plain data: nodes (boxes), frames (labelled containers) and edges
 * (arrows). Both emitters — Excalidraw and SVG — consume this same structure, so
 * the two outputs can never drift apart in content, only in rendering style.
 *
 * Geometry is resolved HERE rather than in either emitter, for the same reason:
 * an arrow must land on the same pixel in both outputs.
 */

/** Average glyph width as a fraction of font size, for the sans stack we use. */
const GLYPH_RATIO = 0.55;

/** Gap between a box edge and the arrow tip, so arrows never touch the border. */
const ARROW_GAP = 6;

export function measureText(text, fontSize) {
  return text.length * fontSize * GLYPH_RATIO;
}

/** Centre point of a node. */
function centre(n) {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

/**
 * Point on one side of a box. `t` slides along that side (0 = start, 1 = end,
 * 0.5 = middle) so several arrows can leave the same face without overlapping.
 */
function sidePoint(n, side, t = 0.5) {
  switch (side) {
    case 'top':
      return { x: n.x + n.w * t, y: n.y - ARROW_GAP };
    case 'bottom':
      return { x: n.x + n.w * t, y: n.y + n.h + ARROW_GAP };
    case 'left':
      return { x: n.x - ARROW_GAP, y: n.y + n.h * t };
    case 'right':
      return { x: n.x + n.w + ARROW_GAP, y: n.y + n.h * t };
    default:
      throw new Error(`unknown side: ${side}`);
  }
}

const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/**
 * Pick which faces an edge should leave from and arrive at. Explicit
 * `fromSide`/`toSide` on the edge always win — the automatic choice below is a
 * default, not a constraint.
 */
function resolveSides(a, b, edge) {
  if (edge.fromSide && edge.toSide) return { from: edge.fromSide, to: edge.toSide };

  // Separation beats the dominant axis. In a layered diagram two boxes in
  // different bands must connect vertically even when they are far apart
  // horizontally — otherwise an arrow from the gateway down to the leftmost
  // service leaves sideways and arrives in the wrong face. Only when the boxes
  // genuinely overlap on both axes do we fall back to comparing centres.
  let from;
  if (b.y >= a.y + a.h) from = 'bottom';
  else if (a.y >= b.y + b.h) from = 'top';
  else if (b.x >= a.x + a.w) from = 'right';
  else if (a.x >= b.x + b.w) from = 'left';
  else {
    const ca = centre(a);
    const cb = centre(b);
    const dx = cb.x - ca.x;
    const dy = cb.y - ca.y;
    if (Math.abs(dy) >= Math.abs(dx)) from = dy > 0 ? 'bottom' : 'top';
    else from = dx > 0 ? 'right' : 'left';
  }

  from = edge.fromSide ?? from;
  const to = edge.toSide ?? OPPOSITE[from];
  return { from, to };
}

/**
 * Turn the declarative scene into concrete geometry.
 *
 * Returns the scene with every edge carrying resolved `points` (absolute
 * coordinates) plus a label anchor. Nodes and frames are returned untouched —
 * they are already absolute by construction.
 */
export function resolveScene(scene) {
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));

  const edges = (scene.edges ?? []).map((edge) => {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a) throw new Error(`edge references unknown node "${edge.from}"`);
    if (!b) throw new Error(`edge references unknown node "${edge.to}"`);

    const sides = resolveSides(a, b, edge);
    const start = sidePoint(a, sides.from, edge.fromT ?? 0.5);
    const end = sidePoint(b, sides.to, edge.toT ?? 0.5);

    // Orthogonal-ish routing: when the two anchors are not aligned we insert a
    // single elbow, which reads far better in a layered architecture diagram
    // than a diagonal cutting across other boxes.
    let points = [start, end];
    const vertical = sides.from === 'top' || sides.from === 'bottom';
    const misaligned = vertical
      ? Math.abs(start.x - end.x) > 2
      : Math.abs(start.y - end.y) > 2;

    if (misaligned && edge.route !== 'straight') {
      // `elbow` places the turn as a fraction of the gap (0 = hug the source,
      // 1 = hug the target). Arrows fanning out of one box would otherwise all
      // turn on the same line, stacking their horizontal runs — and their
      // labels — on top of each other. Giving each a lane separates them.
      const t = edge.elbow ?? 0.5;
      const mid = vertical
        ? start.y + (end.y - start.y) * t
        : start.x + (end.x - start.x) * t;
      points = vertical
        ? [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end]
        : [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
    }

    const midIndex = Math.floor((points.length - 1) / 2);
    const p1 = points[midIndex];
    const p2 = points[midIndex + 1] ?? p1;

    return {
      ...edge,
      points,
      labelAt: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
    };
  });

  return { ...scene, edges };
}

/**
 * Lay out `count` boxes evenly across a horizontal band.
 * Used by the scene definitions so column maths lives in one place.
 */
export function row({ count, left, right, y, h, gap = 28 }) {
  const span = right - left;
  const w = (span - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({
    x: left + i * (w + gap),
    y,
    w,
    h,
  }));
}
