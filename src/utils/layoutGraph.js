/**
 * Automatic graph layout using a layered (Sugiyama-style) approach.
 * Positions nodes top-to-bottom based on edge flow, with root nodes at the top.
 */
const NODE_WIDTH = 200;
const NODE_HEIGHT = 140;
const HORIZONTAL_GAP = 50;
const VERTICAL_GAP = 80;

/**
 * Compute optimal positions for nodes based on edge flow.
 * @param {Array} nodes - Current ReactFlow nodes
 * @param {Array} edges - Current ReactFlow edges
 * @returns {Array} nodes with updated position properties
 */
export function autoLayout(nodes, edges) {
  if (nodes.length === 0) return [];

  // Build adjacency maps
  const children = new Map(); // nodeId -> [targetIds]
  const parents = new Map();  // nodeId -> [sourceIds]

  for (const n of nodes) {
    children.set(n.id, []);
    parents.set(n.id, []);
  }

  for (const e of edges) {
    if (children.has(e.source)) {
      children.get(e.source).push(e.target);
    }
    if (parents.has(e.target)) {
      parents.get(e.target).push(e.source);
    }
  }

  // Find connected components
  const visited = new Set();
  const components = [];

  for (const n of nodes) {
    if (visited.has(n.id)) continue;

    // BFS to find all nodes in this component
    const component = new Set();
    const queue = [n.id];
    component.add(n.id);
    visited.add(n.id);

    while (queue.length > 0) {
      const current = queue.shift();
      for (const child of children.get(current) || []) {
        if (!component.has(child)) {
          component.add(child);
          visited.add(child);
          queue.push(child);
        }
      }
      for (const parent of parents.get(current) || []) {
        if (!component.has(parent)) {
          component.add(parent);
          visited.add(parent);
          queue.push(parent);
        }
      }
    }

    components.push(component);
  }

  // Layout each component independently
  const positions = new Map(); // nodeId -> { x, y, layer }
  let cumulativeOffsetX = 0;

  for (const component of components) {
    const componentNodes = [...component];
    const result = layoutComponent(componentNodes, children, parents);

    // Apply horizontal offset to position components side by side
    for (const [nodeId, pos] of result) {
      positions.set(nodeId, { ...pos, x: pos.x + cumulativeOffsetX });
    }

    // Calculate width of this component for next offset
    const maxX = Math.max(...[...result.values()].map((p) => p.x));
    cumulativeOffsetX += maxX + NODE_WIDTH + HORIZONTAL_GAP * 2;
  }

  // Return updated nodes
  return nodes.map((n) => {
    const pos = positions.get(n.id);
    if (!pos) return n; // shouldn't happen
    return { ...n, position: { x: pos.x, y: pos.y } };
  });
}

/**
 * Layout a single connected component using layered approach.
 */
function layoutComponent(nodeIds, children, parents) {
  const idSet = new Set(nodeIds);
  const inComponent = (id) => idSet.has(id);

  // 1. Break cycles. Investigation graphs often have A→B + B→A or longer
  //    loops; the old "push child whenever its layer grows" BFS never
  //    terminated on them and froze the tab. A DFS drops back edges (edges to
  //    a node still on the DFS stack), leaving a DAG. Roots (no incoming
  //    edges) are visited first so the natural flow keeps its direction.
  const dagChildren = new Map(nodeIds.map((id) => [id, []]));
  const visited = new Set();
  const onStack = new Set();

  const visit = (start) => {
    // Iterative DFS — no recursion-depth limit on long chains
    const stack = [[start, 0]];
    visited.add(start);
    onStack.add(start);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const [node, i] = frame;
      const kids = (children.get(node) || []).filter(inComponent);
      if (i >= kids.length) {
        onStack.delete(node);
        stack.pop();
        continue;
      }
      frame[1] = i + 1;
      const child = kids[i];
      if (child === node || onStack.has(child)) continue; // self-loop / back edge
      dagChildren.get(node).push(child);
      if (!visited.has(child)) {
        visited.add(child);
        onStack.add(child);
        stack.push([child, 0]);
      }
    }
  };

  const isRoot = (id) => !(parents.get(id) || []).some(inComponent);
  for (const id of nodeIds) if (isRoot(id) && !visited.has(id)) visit(id);
  for (const id of nodeIds) if (!visited.has(id)) visit(id); // pure cycles

  // 2. Longest-path layering on the DAG (Kahn's algorithm): each node sits
  //    one layer below its deepest parent. Every node is processed once.
  const inDegree = new Map(nodeIds.map((id) => [id, 0]));
  for (const id of nodeIds) {
    for (const child of dagChildren.get(id)) {
      inDegree.set(child, inDegree.get(child) + 1);
    }
  }

  const layer = new Map();
  const queue = nodeIds.filter((id) => inDegree.get(id) === 0);
  for (const id of queue) layer.set(id, 0);

  for (let qi = 0; qi < queue.length; qi++) {
    const current = queue[qi];
    for (const child of dagChildren.get(current)) {
      layer.set(child, Math.max(layer.get(child) ?? 0, layer.get(current) + 1));
      inDegree.set(child, inDegree.get(child) - 1);
      if (inDegree.get(child) === 0) queue.push(child);
    }
  }

  // Group nodes by layer
  const layerGroups = new Map();
  for (const id of nodeIds) {
    const l = layer.get(id);
    if (!layerGroups.has(l)) layerGroups.set(l, []);
    layerGroups.get(l).push(id);
  }

  // Sort layers
  const sortedLayers = [...layerGroups.keys()].sort((a, b) => a - b);

  // Position nodes
  const positions = new Map();

  for (const l of sortedLayers) {
    const nodesInLayer = layerGroups.get(l);

    // Center-align nodes in each layer
    const totalWidth =
      nodesInLayer.length * NODE_WIDTH +
      (nodesInLayer.length - 1) * HORIZONTAL_GAP;

    // Center the row
    nodesInLayer.forEach((nodeId, i) => {
      // For each layer, position nodes centered around 0 (offset applied later)
      const x = i * (NODE_WIDTH + HORIZONTAL_GAP) - totalWidth / 2 + NODE_WIDTH / 2;
      const y = l * (NODE_HEIGHT + VERTICAL_GAP);

      positions.set(nodeId, { x: Math.round(x), y: Math.round(y), layer: l });
    });
  }

  return positions;
}
