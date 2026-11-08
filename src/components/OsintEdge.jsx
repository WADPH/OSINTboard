import { memo, useContext, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
} from 'reactflow';
import { EdgeUIContext } from './edgeContext';

const LABEL_MAX_LENGTH = 80;

/** Inline input for an edge label; mounted only while editing. */
function EdgeLabelEditor({ initial, onDone }) {
  const [draft, setDraft] = useState(initial);
  const doneRef = useRef(false); // blur fires after Enter/Escape — finish once

  const finish = (save) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(save ? draft.trim() : null);
  };

  return (
    <input
      className="osint-edge-label-input"
      value={draft}
      maxLength={LABEL_MAX_LENGTH}
      placeholder="Relationship…"
      size={Math.max(10, draft.length + 1)}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

/**
 * Smooth-step edge with an editable relationship label
 * ("works at", "owns", "called"…). Double-click the edge or its label to edit.
 */
const OsintEdge = memo(
  ({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
    markerStart,
    label,
    selected,
    interactionWidth,
  }) => {
    const { editingEdgeId, setEditingEdgeId } = useContext(EdgeUIContext);
    const { setEdges } = useReactFlow();
    const editing = editingEdgeId === id;

    const [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: 8,
    });

    // value === null → cancelled; '' → label removed
    const handleDone = (value) => {
      if (value !== null) {
        setEdges((eds) =>
          eds.map((e) => (e.id === id ? { ...e, label: value || undefined } : e))
        );
      }
      setEditingEdgeId(null);
    };

    const edgeStyle = selected ? { ...style, stroke: 'var(--accent)' } : style;

    return (
      <>
        <BaseEdge
          path={path}
          style={edgeStyle}
          markerEnd={markerEnd}
          markerStart={markerStart}
          interactionWidth={interactionWidth ?? 24}
        />
        {(editing || label) && (
          <EdgeLabelRenderer>
            <div
              className={`osint-edge-label nodrag nopan ${selected ? 'osint-edge-label--selected' : ''} ${editing ? 'osint-edge-label--editing' : ''}`}
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingEdgeId(id);
              }}
              title={editing ? undefined : `${label}\n(double-click to edit)`}
            >
              {editing ? (
                <EdgeLabelEditor
                  initial={typeof label === 'string' ? label : ''}
                  onDone={handleDone}
                />
              ) : (
                label
              )}
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }
);

OsintEdge.displayName = 'OsintEdge';

export default OsintEdge;
