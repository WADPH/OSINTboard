/**
 * Edge routing helpers: handle-side selection for "auto" (floating) routing,
 * migration of edges saved before the 4-handle layout, and edge ids.
 */

export const EDGE_TYPE = 'osint';

export const EDGE_ROUTING_AUTO = 'auto';
export const EDGE_ROUTING_MANUAL = 'manual';

const ROUTING_STORAGE_KEY = 'osintboard_edge_routing';

export function loadEdgeRouting() {
  try {
    const v = localStorage.getItem(ROUTING_STORAGE_KEY);
    return v === EDGE_ROUTING_AUTO ? EDGE_ROUTING_AUTO : EDGE_ROUTING_MANUAL;
  } catch {
    return EDGE_ROUTING_MANUAL;
  }
}

export function saveEdgeRouting(mode) {
  try {
    localStorage.setItem(ROUTING_STORAGE_KEY, mode);
  } catch {
    // storage unavailable — the choice just won't persist
  }
}

let edgeCounter = 0;
/** Unique, stable edge id (independent of handles, so reconnecting keeps it). */
export const createEdgeId = () =>
  `edge_${Date.now().toString(36)}_${(++edgeCounter).toString(36)}`;

function nodeRect(node) {
  const pos = node.positionAbsolute ?? node.position;
  if (!pos || !node.width || !node.height) return null;
  return { x: pos.x, y: pos.y, w: node.width, h: node.height };
}

/**
 * Pick the facing sides of two nodes: compare the free gap between the boxes
 * horizontally vs vertically and connect along the larger one. Using gaps
 * (not raw center deltas) keeps wide nodes like the Timeline sensible.
 *
 * Returns { sourceHandle, targetHandle } or null if a node isn't measured yet.
 */
export function pickSides(sourceNode, targetNode) {
  const s = nodeRect(sourceNode);
  const t = nodeRect(targetNode);
  if (!s || !t) return null;

  const dx = t.x + t.w / 2 - (s.x + s.w / 2);
  const dy = t.y + t.h / 2 - (s.y + s.h / 2);
  const gapX = Math.abs(dx) - (s.w + t.w) / 2;
  const gapY = Math.abs(dy) - (s.h + t.h) / 2;

  if (gapX > gapY) {
    return dx >= 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom', targetHandle: 'top' }
    : { sourceHandle: 'top', targetHandle: 'bottom' };
}

/**
 * Re-route every edge to the facing sides of its nodes.
 * Returns the same array instance when nothing changed (so callers can skip
 * a state update and avoid render loops).
 */
export function routeEdges(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let changed = false;
  const next = edges.map((e) => {
    if (e.source === e.target) return e;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) return e;
    const sides = pickSides(s, t);
    if (
      !sides ||
      (sides.sourceHandle === e.sourceHandle && sides.targetHandle === e.targetHandle)
    ) {
      return e;
    }
    changed = true;
    return { ...e, ...sides };
  });
  return changed ? next : edges;
}

/**
 * Migrate edges from boards saved before nodes had 4 handles.
 * Old edges have no handle ids; in Loose connection mode they'd snap to the
 * first handle (top → top), so pin them to the old bottom → top layout.
 */
export function normalizeEdges(edges = []) {
  return edges.map((e) => ({
    ...e,
    type: EDGE_TYPE,
    sourceHandle: e.sourceHandle ?? 'bottom',
    targetHandle: e.targetHandle ?? 'top',
  }));
}
