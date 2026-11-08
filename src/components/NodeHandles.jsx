import { memo } from 'react';
import { Handle, Position } from 'reactflow';

/**
 * Four connection points (top / right / bottom / left).
 *
 * Every handle is `type="source"`: the canvas runs in ConnectionMode.Loose,
 * where a source handle also accepts incoming connections. So each point works
 * as both "in" and "out" — the drag direction decides which end gets the arrow.
 *
 * The ids are stored in edge.sourceHandle / edge.targetHandle.
 */
const HANDLE_SIDES = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
];

const NodeHandles = memo(({ color }) => (
  <>
    {HANDLE_SIDES.map(({ id, position }) => (
      <Handle
        key={id}
        id={id}
        type="source"
        position={position}
        className="osint-handle"
        style={{ '--handle-color': color }}
      />
    ))}
  </>
));

NodeHandles.displayName = 'NodeHandles';

export default NodeHandles;
