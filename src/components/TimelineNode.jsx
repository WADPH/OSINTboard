import { memo, useState, useMemo, useCallback, useRef } from 'react';
import { useEdges, useNodes, useReactFlow } from 'reactflow';
import NodeHandles from './NodeHandles';
import { useUpdateNodeData, useClickOutside } from './nodeHooks';
import { CustomFieldsEditor, CustomFieldsView } from './CustomFields';
import { cleanFields } from '../utils/customFields';
import { NODE_TYPE_MAP } from '../data/nodeTypes';

const TIMELINE_WIDTH = 520;

function formatDate(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function toMs(iso) {
  if (!iso) return NaN;
  return new Date(iso + 'T00:00:00').getTime();
}

const TimelineNode = memo(({ id, data, selected }) => {
  const [editing, setEditing] = useState(false);
  const [editingEntry, setEditingEntry] = useState(null);

  const [localLabel, setLocalLabel] = useState(data.label || '');
  const [localStart, setLocalStart] = useState(data.startDate || '');
  const [localEnd, setLocalEnd] = useState(data.endDate || '');
  const [fields, setFields] = useState(data.fields || []);
  const [localEntryDate, setLocalEntryDate] = useState('');

  const edges = useEdges();
  const nodes = useNodes();
  const { setEdges, getEdges, deleteElements } = useReactFlow();
  const updateData = useUpdateNodeData(id);
  const nodeRef = useRef(null);

  const color = '#4db6ac';

  const commitEdit = useCallback(() => {
    updateData({
      label: localLabel,
      startDate: localStart,
      endDate: localEnd,
      fields: cleanFields(fields),
    });
    setEditing(false);
  }, [localLabel, localStart, localEnd, fields, updateData]);

  // Ignored while editing so a double-click inside an input keeps unsaved text
  const startEditing = () => {
    if (editing) return;
    setLocalLabel(data.label || '');
    setLocalStart(data.startDate || '');
    setLocalEnd(data.endDate || '');
    setFields(data.fields || []);
    setEditing(true);
  };

  // Dismiss editing when clicking outside the node
  useClickOutside(nodeRef, editing, commitEdit);

  const handleDelete = useCallback(
    (e) => {
      e.stopPropagation();
      deleteElements({ nodes: [{ id }] });
    },
    [id, deleteElements]
  );

  const connectedEdges = useMemo(
    () => edges.filter((e) => e.target === id || e.source === id),
    [edges, id]
  );

  const entries = useMemo(() => {
    return connectedEdges
      .map((e) => {
        const otherNodeId = e.source === id ? e.target : e.source;
        const otherNode = nodes.find((n) => n.id === otherNodeId);
        if (!otherNode) return null;
        return {
          edgeId: e.id,
          nodeId: otherNodeId,
          node: otherNode,
          edgeDate: e.data?.timelineDate || '',
          nodeDate: otherNode.data?.dateValue || '',
          date: e.data?.timelineDate || otherNode.data?.dateValue || '',
        };
      })
      .filter(Boolean);
  }, [connectedEdges, nodes, id]);

  const startMs = toMs(data.startDate);
  const endMs = toMs(data.endDate);
  const hasRange = !isNaN(startMs) && !isNaN(endMs) && endMs > startMs;

  const getDatePosition = useCallback(
    (date) => {
      if (!hasRange || !date) return null;
      const d = toMs(date);
      if (isNaN(d)) return null;
      const pct = ((d - startMs) / (endMs - startMs)) * 100;
      return Math.max(0, Math.min(100, pct));
    },
    [hasRange, startMs, endMs]
  );

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') {
      setEditing(false);
      setLocalLabel(data.label || '');
      setLocalStart(data.startDate || '');
      setLocalEnd(data.endDate || '');
      setFields(data.fields || []);
    }
  };

  const commitEntryDate = (edgeId) => {
    if (!edgeId) return;
    const allEdges = getEdges();
    setEdges(
      allEdges.map((e) => {
        if (e.id === edgeId) {
          return { ...e, data: { ...e.data, timelineDate: localEntryDate } };
        }
        return e;
      })
    );
    setEditingEntry(null);
    setLocalEntryDate('');
  };

  const entryKeyDown = (e, edgeId) => {
    if (e.key === 'Enter') commitEntryDate(edgeId);
    if (e.key === 'Escape') {
      setEditingEntry(null);
      setLocalEntryDate('');
    }
  };

  const sortedEntries = useMemo(() => {
    const placed = entries.filter((e) => e.date);
    const unplaced = entries.filter((e) => !e.date);
    placed.sort((a, b) => a.date.localeCompare(b.date));
    return { placed: placed.map((e, i) => ({ ...e, altIdx: i })), unplaced };
  }, [entries]);

  return (
    <div
      ref={nodeRef}
      className={`timeline-node ${selected ? 'timeline-node--selected' : ''}`}
      style={{
        width: TIMELINE_WIDTH,
        borderColor: color,
        boxShadow: selected
          ? `0 0 12px ${color}44, 0 0 0 1px ${color}`
          : `0 0 0 1px ${color}88`,
      }}
    >
      <NodeHandles color={color} />

      <div
        className="timeline-node-header"
        style={{ borderBottomColor: color + '66' }}
        onDoubleClick={startEditing}
      >
        <span className="timeline-node-icon">📊</span>
        {editing ? (
          <span
            className="timeline-node-header-editing"
            tabIndex={-1}
          >
            <input
              className="timeline-node-input"
              value={localLabel}
              onChange={(e) => setLocalLabel(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Timeline title…"
              autoFocus
            />
            <label className="timeline-node-date-label">
              From:
              <input
                className="timeline-node-input timeline-node-input-sm"
                type="date"
                value={localStart}
                onChange={(e) => setLocalStart(e.target.value)}
              />
            </label>
            <label className="timeline-node-date-label">
              To:
              <input
                className="timeline-node-input timeline-node-input-sm"
                type="date"
                value={localEnd}
                onChange={(e) => setLocalEnd(e.target.value)}
              />
            </label>
          </span>
        ) : (
          <span className="timeline-node-title">
            {data.label || <span className="timeline-node-placeholder">Timeline</span>}
            {data.startDate && data.endDate && (
              <span className="timeline-node-range">
                {formatDate(data.startDate)} – {formatDate(data.endDate)}
              </span>
            )}
            {(!data.startDate || !data.endDate) && (
              <span className="timeline-node-range timeline-node-range-hint">
                Double-click to set date range
              </span>
            )}
          </span>
        )}
        {editing && (
          <button
            className="node-delete-btn"
            onClick={handleDelete}
            title="Delete timeline"
          >
            🗑️
          </button>
        )}
      </div>

      <div className="timeline-node-fields">
        {editing ? (
          <CustomFieldsEditor
            nodeId={id}
            nodeType="timeline"
            fields={fields}
            onChange={setFields}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <CustomFieldsView fields={data.fields} />
        )}
      </div>

      <div className="timeline-node-bar-area">
        {hasRange ? (
          <div className="timeline-node-bar-container">
            <div className="timeline-node-bar">
              <div className="timeline-node-bar-track" />
              <div className="timeline-node-bar-endpoints">
                <span>{formatDate(data.startDate)}</span>
                <span>{formatDate(data.endDate)}</span>
              </div>
              {sortedEntries.placed.map((entry) => {
                const pct = getDatePosition(entry.date);
                const def =
                  NODE_TYPE_MAP[entry.node?.data?.nodeType] ||
                  NODE_TYPE_MAP.note;
                const side = entry.altIdx % 2 === 0 ? 'above' : 'below';
                if (pct === null) return null;
                return (
                  <div
                    key={entry.edgeId}
                    className={`timeline-node-entry timeline-node-entry--${side}`}
                    style={{ left: `${pct}%` }}
                    onClick={() => {
                      if (!entry.nodeDate) {
                        setEditingEntry(entry.edgeId);
                        setLocalEntryDate(entry.edgeDate || '');
                      }
                    }}
                    title={formatDate(entry.date)}
                  >
                    <div className="timeline-node-entry-label-text">
                      <span className="timeline-node-entry-name">
                        {entry.node?.data?.label || '(empty)'}
                      </span>
                      <span className="timeline-node-entry-date-tag">
                        {formatDate(entry.date)}
                      </span>
                    </div>
                    <div className="timeline-node-entry-dot-row">
                      <div
                        className="timeline-node-entry-dot"
                        style={{ background: def.color }}
                      />
                    </div>
                    <span className="timeline-node-entry-icon">
                      {def.icon}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="timeline-node-no-range">
            {editing ? (
              <span className="timeline-node-range-hint">
                Set start and end dates above
              </span>
            ) : (
              <span className="timeline-node-range-hint">
                Double-click header to set date range
              </span>
            )}
          </div>
        )}

        {sortedEntries.unplaced.length > 0 && (
          <div className="timeline-node-unplaced">
            <span className="timeline-node-unplaced-label">Unplaced entries</span>
            <div className="timeline-node-unplaced-grid">
              {sortedEntries.unplaced.map((entry) => {
                const def =
                  NODE_TYPE_MAP[entry.node?.data?.nodeType] ||
                  NODE_TYPE_MAP.note;
                return (
                  <div
                    key={entry.edgeId}
                    className="timeline-node-unplaced-card"
                    onClick={() => {
                      setEditingEntry(entry.edgeId);
                      setLocalEntryDate(entry.edgeDate || '');
                    }}
                  >
                    <span className="timeline-conn-icon">{def.icon}</span>
                    <span className="timeline-conn-label">
                      {entry.node?.data?.label || '(empty)'}
                    </span>
                    <span className="timeline-node-unplaced-date-btn">Set date</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {editingEntry && (
          <div className="timeline-node-entry-editor">
            <input
              className="timeline-node-input"
              type="date"
              value={localEntryDate}
              onChange={(e) => setLocalEntryDate(e.target.value)}
              onBlur={() => commitEntryDate(editingEntry)}
              onKeyDown={(e) => entryKeyDown(e, editingEntry)}
              autoFocus
            />
          </div>
        )}

        {entries.length === 0 && (
          <div className="timeline-node-empty">
            Connect other nodes to this timeline to add entries
          </div>
        )}

        {hasRange && sortedEntries.placed.length === 0 && entries.length > 0 && (
          <div className="timeline-node-empty">
            Set dates on connected nodes or click unplaced entries to position them on the timeline
          </div>
        )}
      </div>

    </div>
  );
});

TimelineNode.displayName = 'TimelineNode';

export default TimelineNode;
