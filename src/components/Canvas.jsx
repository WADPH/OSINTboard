import { useState, useCallback, useRef, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  reconnectEdge,
  useNodesState,
  useEdgesState,
  SelectionMode,
  MarkerType,
  BackgroundVariant,
  ConnectionMode,
  ConnectionLineType,
} from 'reactflow';
import 'reactflow/dist/style.css';

import OSINTNode from './OSINTNode';
import TimelineNode from './TimelineNode';
import MediaNode from './MediaNode';
import OsintEdge from './OsintEdge';
import { EdgeUIContext } from './edgeContext';
import { NodeStateContext } from './nodeHooks';
import QuickSearch from './QuickSearch';
import NodeContextMenu from './NodeContextMenu';
import MaigretReport from './MaigretReport';
import { autoLayout } from '../utils/layoutGraph';
import {
  EDGE_TYPE,
  EDGE_ROUTING_AUTO,
  EDGE_ROUTING_MANUAL,
  createEdgeId,
  loadEdgeRouting,
  saveEdgeRouting,
  normalizeEdges,
  routeEdges,
} from '../utils/edgeRouting';
import { startScan, getScan } from '../utils/maigretApi';
import { NODE_TYPE_MAP } from '../data/nodeTypes';

const nodeTypes = {
  osintNode: OSINTNode,
  timelineNode: TimelineNode,
  mediaNode: MediaNode,
};

const edgeTypes = {
  [EDGE_TYPE]: OsintEdge,
};

let nodeId = 0;
const getId = () => `osint_${++nodeId}`;

const defaultViewport = { x: 0, y: 0, zoom: 1 };
const SNAP_GRID = 10;
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MAX_HISTORY = 50;
const HISTORY_DEBOUNCE = 300; // ms

const INITIAL_NODES = [];
const INITIAL_EDGES = [];

// Fingerprint of what undo should care about. Ignores transient UI state
// (selection, dragging, measured size) so clicks and re-measures don't
// create history entries.
const historySignature = (nodes, edges) =>
  JSON.stringify([
    nodes.map((n) => [n.id, n.type, n.position?.x, n.position?.y, { ...n.data, media: undefined }]),
    edges.map((e) => [e.id, e.source, e.target, e.sourceHandle, e.targetHandle, e.type, e.label, e.data]),
  ]);

// Deep-clone for history snapshots (strips heavy base64 media data)
const cloneForHistory = (nodes, edges) => {
  const clonedNodes = nodes.map((n) => ({
    ...n,
    data: { ...n.data, media: undefined },
    position: { ...n.position },
  }));
  const clonedEdges = edges.map((e) => ({ ...e }));
  return { nodes: clonedNodes, edges: clonedEdges, sig: historySignature(nodes, edges) };
};

// Merge history snapshot back into live state, preserving media
const mergeSnapshot = (snapshotNodes, liveNodes) => {
  return snapshotNodes.map((sn) => {
    const live = liveNodes.find((n) => n.id === sn.id);
    return {
      ...sn,
      data: { ...sn.data, media: live?.data?.media },
    };
  });
};

const Canvas = forwardRef(function Canvas({ isMobile, pendingNodeType, onNodePlaced }, ref) {
  const [nodes, setNodes, onNodesChange] = useNodesState(INITIAL_NODES);
  const [edges, setEdges, onEdgesChange] = useEdgesState(INITIAL_EDGES);
  const reactFlowWrapper = useRef(null);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);
  const longPressTimer = useRef(null);
  const [quickSearchPos, setQuickSearchPos] = useState(null);
  const [nodeMenu, setNodeMenu] = useState(null); // {nodeId, x, y} | null
  const [reportNodeId, setReportNodeId] = useState(null); // node whose maigret popup is open
  const scanPollRef = useRef(null); // polling interval for the active scan

  // --- Edges: routing mode, label editing, connect/reconnect state ---
  const [edgeRouting, setEdgeRouting] = useState(loadEdgeRouting);
  const [editingEdgeId, setEditingEdgeId] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false); // shows all handles while dragging
  const reconnectingEdgeId = useRef(null);
  const edgeUI = useMemo(() => ({ editingEdgeId, setEditingEdgeId }), [editingEdgeId]);
  const edgeSelected = edges.some((e) => e.selected);

  // --- Undo / Redo system ---
  // History lives in refs (read by timers/handlers); `historyPos` mirrors the
  // position into state only so the Undo/Redo buttons re-render.
  //
  // The push effect must depend ONLY on nodes/edges. Depending on the history
  // index made every push re-trigger the effect, which pushed the same state
  // again every 300ms forever — undo then just stepped between identical
  // copies and the redo stack was wiped by the next push.
  const historyRef = useRef([cloneForHistory([], [])]);
  const historyIndexRef = useRef(0);
  const [historyPos, setHistoryPos] = useState({ index: 0, length: 1 });
  const isUndoRedoing = useRef(false);
  const pushTimerRef = useRef(null);

  const canUndo = historyPos.index > 0;
  const canRedo = historyPos.index < historyPos.length - 1;

  const syncHistoryPos = useCallback(() => {
    setHistoryPos({ index: historyIndexRef.current, length: historyRef.current.length });
  }, []);

  // Append a snapshot after the current position (drops the redo branch).
  // Skipped when identical to the current entry.
  const pushHistory = useCallback(
    (snapshot) => {
      const current = historyRef.current[historyIndexRef.current];
      if (current && current.sig === snapshot.sig) return;
      const next = [
        ...historyRef.current.slice(0, historyIndexRef.current + 1),
        snapshot,
      ].slice(-MAX_HISTORY);
      historyRef.current = next;
      historyIndexRef.current = next.length - 1;
      syncHistoryPos();
    },
    [syncHistoryPos]
  );

  const cancelPendingPush = useCallback(() => {
    if (pushTimerRef.current) {
      clearTimeout(pushTimerRef.current);
      pushTimerRef.current = null;
    }
  }, []);

  // Record history. Continuous edits (dragging, typing) are debounced into
  // one step once they settle. Adding/removing nodes or edges (paste,
  // duplicate, delete, connect) is a discrete action: it is recorded right
  // away as its own step — after first recording the state just before it if
  // that was still waiting in the debounce — so quick successive actions
  // don't merge into a single undo.
  const prevStateRef = useRef({ nodes, edges });
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = { nodes, edges };
    if (isUndoRedoing.current) return;

    const structural =
      prev.nodes.length !== nodes.length || prev.edges.length !== edges.length;
    if (structural) {
      if (pushTimerRef.current) {
        cancelPendingPush();
        pushHistory(cloneForHistory(prev.nodes, prev.edges));
      }
      pushHistory(cloneForHistory(nodes, edges));
      return;
    }

    cancelPendingPush();
    pushTimerRef.current = setTimeout(() => {
      pushTimerRef.current = null;
      if (isUndoRedoing.current) return;
      pushHistory(cloneForHistory(nodes, edges));
    }, HISTORY_DEBOUNCE);
  }, [nodes, edges, pushHistory, cancelPendingPush]);

  // Record changes still waiting in the debounce (e.g. Ctrl+Z right after a
  // drag) so undo/redo/layout act on the latest state, not a stale timer.
  const flushPendingPush = useCallback(() => {
    if (!pushTimerRef.current || isUndoRedoing.current) return;
    cancelPendingPush();
    pushHistory(cloneForHistory(nodes, edges));
  }, [nodes, edges, pushHistory, cancelPendingPush]);

  const restoreHistory = useCallback(
    (index) => {
      const snapshot = historyRef.current[index];
      if (!snapshot) return;
      cancelPendingPush();
      isUndoRedoing.current = true;
      setNodes(mergeSnapshot(snapshot.nodes, nodes));
      setEdges(snapshot.edges);
      historyIndexRef.current = index;
      syncHistoryPos();
      // Reset flag after React commits the update
      setTimeout(() => { isUndoRedoing.current = false; }, 0);
    },
    [nodes, setNodes, setEdges, cancelPendingPush, syncHistoryPos]
  );

  const undo = useCallback(() => {
    flushPendingPush();
    if (historyIndexRef.current <= 0) return;
    restoreHistory(historyIndexRef.current - 1);
  }, [flushPendingPush, restoreHistory]);

  const redo = useCallback(() => {
    // A real pending edit gets recorded here and drops the redo branch;
    // a pending selection-only change matches the current entry and doesn't.
    flushPendingPush();
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    restoreHistory(historyIndexRef.current + 1);
  }, [flushPendingPush, restoreHistory]);

  // Auto-layout: rearrange nodes for optimal readability
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0 || !reactFlowInstance) return;

    // Compute new layout
    const laidOut = autoLayout(nodes, edges);

    // Record pre- and post-layout states right away so undo works the instant
    // the layout is applied. The debounced push that follows sees the same
    // state and is skipped.
    flushPendingPush();
    pushHistory(cloneForHistory(laidOut, edges));

    setNodes(laidOut);

    // Fit the new layout in view after React commits
    setTimeout(() => {
      reactFlowInstance.fitView({ padding: 0.2, duration: 400 });
    }, 50);
  }, [nodes, edges, setNodes, reactFlowInstance, flushPendingPush, pushHistory]);

  // --- Copy / paste nodes (Ctrl+C / Ctrl+V) ---
  // Copies the selected nodes with everything in their data (custom fields,
  // attachments, coordinates…) plus the edges between them. Attachments are
  // shared by reference (same server file), which the media GC accounts for.
  const clipboardRef = useRef(null); // { nodes, edges } — deep copies
  const pointerRef = useRef(null); // last pointer position over the canvas
  const lastPasteRef = useRef({ at: null, repeat: 0 });

  // Deep copy of the selected nodes + the edges between them, or null
  const snapshotSelection = useCallback(() => {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length === 0) return null;
    const ids = new Set(selected.map((n) => n.id));
    return structuredClone({
      nodes: selected.map(({ id, type, position, data, style }) => ({
        id,
        type,
        position,
        data,
        style,
      })),
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    });
  }, [nodes, edges]);

  const copySelection = useCallback(() => {
    const clip = snapshotSelection();
    if (!clip) return false;
    clipboardRef.current = clip;
    lastPasteRef.current = { at: null, repeat: 0 };
    return true;
  }, [snapshotSelection]);

  // Add a copy of `clip` to the board, with fresh ids, as the new selection.
  // `atPointer`: top-left at the mouse (Ctrl+V); otherwise offset from the
  // originals (Duplicate button).
  const insertCopy = useCallback(
    (clip, { atPointer }) => {
      if (!clip || clip.nodes.length === 0 || !reactFlowInstance) return false;

      const minX = Math.min(...clip.nodes.map((n) => n.position.x));
      const minY = Math.min(...clip.nodes.map((n) => n.position.y));
      const ptr = atPointer ? pointerRef.current : null;
      let dx;
      let dy;
      if (ptr) {
        // Pasting again without moving the mouse cascades each copy
        const last = lastPasteRef.current;
        const samePlace = last.at && last.at.x === ptr.x && last.at.y === ptr.y;
        const repeat = samePlace ? last.repeat + 1 : 0;
        lastPasteRef.current = { at: ptr, repeat };
        const origin = reactFlowInstance.screenToFlowPosition(ptr);
        dx = origin.x - minX + repeat * 30;
        dy = origin.y - minY + repeat * 30;
      } else {
        dx = 40;
        dy = 40;
      }
      const snap = (v) => Math.round(v / SNAP_GRID) * SNAP_GRID;

      const idMap = new Map();
      const newNodes = clip.nodes.map((n) => {
        const id = getId();
        idMap.set(n.id, id);
        const data = structuredClone(n.data);
        // A running scan keeps updating only the original node
        if (data.maigret && data.maigret.status !== 'done') delete data.maigret;
        return {
          ...structuredClone(n),
          id,
          data,
          position: { x: snap(n.position.x + dx), y: snap(n.position.y + dy) },
          selected: true,
        };
      });
      const newEdges = clip.edges.map((e) => ({
        ...structuredClone(e),
        id: createEdgeId(),
        source: idMap.get(e.source),
        target: idMap.get(e.target),
        selected: false,
      }));

      // The copy becomes the selection, ready to be dragged
      setNodes((nds) =>
        nds.map((n) => (n.selected ? { ...n, selected: false } : n)).concat(newNodes)
      );
      setEdges((eds) =>
        eds.map((e) => (e.selected ? { ...e, selected: false } : e)).concat(newEdges)
      );
      return true;
    },
    [reactFlowInstance, setNodes, setEdges]
  );

  const pasteClipboard = useCallback(
    () => insertCopy(clipboardRef.current, { atPointer: true }),
    [insertCopy]
  );

  // Duplicate leaves the clipboard alone
  const duplicateSelection = useCallback(
    () => insertCopy(snapshotSelection(), { atPointer: false }),
    [insertCopy, snapshotSelection]
  );

  const deleteSelection = useCallback(() => {
    if (!reactFlowInstance) return;
    reactFlowInstance.deleteElements({
      nodes: nodes.filter((n) => n.selected),
      edges: edges.filter((e) => e.selected),
    });
  }, [reactFlowInstance, nodes, edges]);

  const selectAll = useCallback(() => {
    setNodes((nds) => nds.map((n) => (n.selected ? n : { ...n, selected: true })));
  }, [setNodes]);

  const clearSelection = useCallback(() => {
    setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
    setEdges((eds) => eds.map((e) => (e.selected ? { ...e, selected: false } : e)));
  }, [setNodes, setEdges]);

  const selectedCount = useMemo(() => nodes.filter((n) => n.selected).length, [nodes]);

  // Keyboard shortcuts: undo/redo/auto-layout/copy/paste
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Typing in a field: leave Ctrl+Z/C/V/… to the browser (text undo,
      // copy/paste of text) instead of acting on the board.
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const key = e.key.toLowerCase();

      if (key === 'c') {
        // Selected text (e.g. in a node) is copied as text, not as nodes
        if (window.getSelection()?.toString()) return;
        if (copySelection()) e.preventDefault();
        return;
      }
      if (key === 'v') {
        if (pasteClipboard()) e.preventDefault();
        return;
      }
      if (key === 'a') {
        // Select every node (instead of the browser selecting page text)
        e.preventDefault();
        selectAll();
        return;
      }

      // e.key is 'Z' (uppercase) while Shift is held, hence `key`
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      } else if (key === 'l') {
        e.preventDefault();
        handleAutoLayout();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, handleAutoLayout, copySelection, pasteClipboard, selectAll]);

  // Escape clears the selection (when not typing / not in a popup)
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.lightbox-overlay, .modal-overlay')) return;
      clearSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection]);

  // Expose save/load + undo/redo to parent
  useImperativeHandle(ref, () => ({
    getSnapshot() {
      return { nodes, edges };
    },
    loadSnapshot(newNodes, newEdges) {
      const maxId = newNodes.reduce((m, n) => {
        const num = parseInt(n.id.replace('osint_', ''), 10);
        return isNaN(num) ? m : Math.max(m, num);
      }, 0);
      nodeId = maxId;

      // Boards saved before 4-handle nodes have edges without handle ids
      const migratedEdges = normalizeEdges(newEdges);

      cancelPendingPush();
      isUndoRedoing.current = true;
      setNodes(newNodes);
      setEdges(migratedEdges);
      setEditingEdgeId(null);
      setTimeout(() => { isUndoRedoing.current = false; }, 0);

      // Reset history with this as the initial state
      historyRef.current = [cloneForHistory(newNodes, migratedEdges)];
      historyIndexRef.current = 0;
      syncHistoryPos();
    },
    canUndo,
    canRedo,
    undo,
    redo,
  }));

  const onConnect = useCallback(
    (params) => {
      const newEdge = {
        ...params,
        id: createEdgeId(),
        style: { stroke: '#aaa', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#aaa' },
        type: EDGE_TYPE,
        animated: false,
      };

      const sourceNode = nodes.find((n) => n.id === params.source);
      const targetNode = nodes.find((n) => n.id === params.target);

      // Propagate dateValue from source (date module → any non-date, non-timeline target)
      if (sourceNode?.data?.dateValue) {
        newEdge.data = { timelineDate: sourceNode.data.dateValue };
        if (targetNode && targetNode.data.nodeType !== 'timeline' && targetNode.data.nodeType !== 'date') {
          setNodes((nds) =>
            nds.map((n) =>
              n.id === targetNode.id
                ? { ...n, data: { ...n.data, dateValue: sourceNode.data.dateValue } }
                : n
            )
          );
        }
      }

      // Also propagate when date module is the target (connecting TO a date node)
      if (targetNode?.data?.dateValue && !sourceNode?.data?.dateValue) {
        newEdge.data = { timelineDate: targetNode.data.dateValue };
        if (sourceNode && sourceNode.data.nodeType !== 'timeline' && sourceNode.data.nodeType !== 'date') {
          setNodes((nds) =>
            nds.map((n) =>
              n.id === sourceNode.id
                ? { ...n, data: { ...n.data, dateValue: targetNode.data.dateValue } }
                : n
            )
          );
        }
      }

      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges, setNodes, nodes]
  );

  // No self-loops and no duplicate edge in the same direction between two
  // nodes (the edge being reconnected doesn't count as its own duplicate).
  const isValidConnection = useCallback(
    (conn) => {
      if (!conn.source || !conn.target || conn.source === conn.target) return false;
      return !edges.some(
        (e) =>
          e.id !== reconnectingEdgeId.current &&
          e.source === conn.source &&
          e.target === conn.target
      );
    },
    [edges]
  );

  const onConnectStart = useCallback(() => setIsConnecting(true), []);
  const onConnectEnd = useCallback(() => setIsConnecting(false), []);

  // Drag an edge's end onto another handle/node to re-attach it.
  // Dropping on empty canvas leaves the edge as it was.
  const onReconnectStart = useCallback((_event, edge) => {
    reconnectingEdgeId.current = edge.id;
    setIsConnecting(true);
  }, []);

  const onReconnect = useCallback(
    (oldEdge, newConnection) => {
      setEdges((eds) =>
        reconnectEdge(oldEdge, newConnection, eds, { shouldReplaceId: false })
      );
    },
    [setEdges]
  );

  const onReconnectEnd = useCallback(() => {
    reconnectingEdgeId.current = null;
    setIsConnecting(false);
  }, []);

  const onEdgeDoubleClick = useCallback((event, edge) => {
    event.stopPropagation();
    setEditingEdgeId(edge.id);
  }, []);

  // Auto routing: keep every edge attached to the facing sides of its nodes.
  // routeEdges returns the same array when nothing changed, so no loop.
  useEffect(() => {
    if (edgeRouting !== EDGE_ROUTING_AUTO) return;
    const routed = routeEdges(nodes, edges);
    if (routed !== edges) setEdges(routed);
  }, [nodes, edges, edgeRouting, setEdges]);

  const toggleEdgeRouting = useCallback(() => {
    setEdgeRouting((mode) => {
      const next = mode === EDGE_ROUTING_AUTO ? EDGE_ROUTING_MANUAL : EDGE_ROUTING_AUTO;
      saveEdgeRouting(next);
      return next;
    });
  }, []);

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const addNodeAtPosition = useCallback(
    (type, position) => {
      if (!type || !NODE_TYPE_MAP[type]) return;

      const snappedX = Math.round(position.x / SNAP_GRID) * SNAP_GRID;
      const snappedY = Math.round(position.y / SNAP_GRID) * SNAP_GRID;

      const isTimeline = type === 'timeline';
      const isMedia = type === 'media';
      const reactFlowType = isTimeline
        ? 'timelineNode'
        : isMedia
        ? 'mediaNode'
        : 'osintNode';

      const newNode = {
        id: getId(),
        type: reactFlowType,
        position: { x: snappedX, y: snappedY },
        data: { nodeType: type, label: '' },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes]
  );

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow');
      if (!type || !NODE_TYPE_MAP[type]) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      addNodeAtPosition(type, position);
    },
    [reactFlowInstance, addNodeAtPosition]
  );

  // Mobile tap-to-place: when a node type is pending, tapping the canvas places it
  const onPaneClick = useCallback(
    (event) => {
      if (!isMobile || !pendingNodeType || !reactFlowInstance) return;

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      addNodeAtPosition(pendingNodeType, position);
      onNodePlaced?.();
    },
    [isMobile, pendingNodeType, reactFlowInstance, addNodeAtPosition, onNodePlaced]
  );

  const onNodesDelete = useCallback((deleted) => {
    // React Flow handles edge deletion automatically
  }, []);

  // Right-click / long-press → open quick-search
  const openQuickSearch = useCallback((clientX, clientY) => {
    // Position the search so it doesn't overflow viewport
    const x = Math.min(clientX, window.innerWidth - 260);
    const y = Math.min(clientY, window.innerHeight - 320);
    setQuickSearchPos({ x, y });
  }, []);

  const closeQuickSearch = useCallback(() => {
    setQuickSearchPos(null);
  }, []);

  // --- Maigret scan runner ---
  const clearScanPoll = useCallback(() => {
    if (scanPollRef.current) {
      clearInterval(scanPollRef.current);
      scanPollRef.current = null;
    }
  }, []);

  // Never poll after unmount
  useEffect(() => clearScanPoll, [clearScanPoll]);

  const runMaigretScan = useCallback(
    async (nodeId) => {
      const node = nodes.find((n) => n.id === nodeId);
      const username = node?.data?.label?.trim() || '';
      if (!username) {
        setNodeMenu(null);
        return;
      }

      // Never leave a second interval behind
      clearScanPoll();

      const stamp = {
        username,
        scanId: null,
        status: 'pending',
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, maigret: stamp } }
            : n
        )
      );

      let scanId;
      try {
        const res = await startScan(username);
        scanId = res.scanId;
      } catch (err) {
        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    maigret: { ...stamp, status: 'error', error: err.message },
                  },
                }
              : n
          )
        );
        return;
      }

      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  maigret: { ...stamp, scanId, status: 'running' },
                },
              }
            : n
        )
      );

      // Consecutive fetch failures: transient (e.g. backend restarting) — keep
      // polling so a recovered backend's restart record surfaces; give up after
      // several in a row so a dead backend doesn't poll forever.
      let consecutiveErrors = 0;

      scanPollRef.current = setInterval(async () => {
        let record;
        try {
          record = await getScan(scanId);
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= 3) {
            clearScanPoll();
            setNodes((nds) =>
              nds.map((n) =>
                n.id === nodeId
                  ? {
                      ...n,
                      data: {
                        ...n.data,
                        maigret: {
                          ...n.data.maigret,
                          status: 'error',
                          error: err.message,
                        },
                      },
                    }
                  : n
              )
            );
          }
          return;
        }

        setNodes((nds) => {
          // Node deleted mid-scan → stop polling
          if (!nds.some((n) => n.id === nodeId)) {
            clearScanPoll();
            return nds;
          }
          return nds.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    maigret: {
                      ...n.data.maigret,
                      status: record.status,
                      error: record.error,
                      completedAt: record.completedAt,
                      reportUrl: record.reportUrl,
                      resultsUrl: record.resultsUrl,
                    },
                  },
                }
              : n
          );
        });

        if (record.status === 'done' || record.status === 'error') {
          clearScanPoll();
        }
      }, 2000);
    },
    [nodes, setNodes, clearScanPoll]
  );

  // Right-click on a Username node → node context menu
  const handleNodeContextMenu = useCallback((event, node) => {
    // macOS turns Ctrl+click into a right-click. Ctrl+click is how nodes are
    // added to the selection, so treat it as that instead of opening menus.
    if (IS_MAC && event.ctrlKey && event.button === 0) {
      event.preventDefault();
      event.stopPropagation();
      setNodes((nds) =>
        nds.map((n) => (n.id === node.id ? { ...n, selected: !n.selected } : n))
      );
      return;
    }
    if (node.data?.nodeType !== 'username') return;
    // stopPropagation is REQUIRED: otherwise the event bubbles to the
    // wrapper's onContextMenu and QuickSearch opens on top of this menu.
    event.preventDefault();
    event.stopPropagation();
    setNodeMenu({
      nodeId: node.id,
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 160),
    });
  }, [setNodes]);

  const handleQuickSelect = useCallback(
    (nodeType) => {
      if (!reactFlowInstance || !quickSearchPos) return;
      const position = reactFlowInstance.screenToFlowPosition({
        x: quickSearchPos.x,
        y: quickSearchPos.y,
      });
      addNodeAtPosition(nodeType, position);
      setQuickSearchPos(null);
    },
    [reactFlowInstance, quickSearchPos, addNodeAtPosition]
  );

  // --- Right-button drag on empty canvas → selection box (like a desktop) ---
  // A right *click* (no drag) still opens quick-search. Browsers fire
  // `contextmenu` on mousedown (Linux/macOS) or on mouseup (Windows), so the
  // menu is decided on mouseup and the native event is swallowed meanwhile.
  const [rightBox, setRightBox] = useState(null); // { x1, y1, x2, y2 } client px
  const rightPressRef = useRef(null); // { x, y, additive, base:Set, moved }
  const suppressMenuUntil = useRef(0);
  const RIGHT_DRAG_THRESHOLD = 4;

  const selectInBox = useCallback(
    (box, additive, base) => {
      if (!reactFlowInstance) return;
      const a = reactFlowInstance.screenToFlowPosition({ x: Math.min(box.x1, box.x2), y: Math.min(box.y1, box.y2) });
      const b = reactFlowInstance.screenToFlowPosition({ x: Math.max(box.x1, box.x2), y: Math.max(box.y1, box.y2) });
      // Partial overlap counts (same as SelectionMode.Partial)
      const hit = (n) => {
        const p = n.positionAbsolute ?? n.position;
        const w = n.width ?? 0;
        const h = n.height ?? 0;
        return p.x < b.x && p.x + w > a.x && p.y < b.y && p.y + h > a.y;
      };
      setNodes((nds) =>
        nds.map((n) => {
          const selected = hit(n) || (additive && base.has(n.id));
          return n.selected === selected ? n : { ...n, selected };
        })
      );
      if (!additive) {
        setEdges((eds) => eds.map((e) => (e.selected ? { ...e, selected: false } : e)));
      }
    },
    [reactFlowInstance, setNodes, setEdges]
  );

  const handleRightMouseDown = useCallback(
    (event) => {
      if (event.button !== 2 || isMobile) return;
      // Only on empty canvas — right-click on a node/edge keeps its own menu.
      // (Nodes and edges live *inside* .react-flow__pane, so exclude them.)
      if (!event.target.closest?.('.react-flow__pane')) return;
      if (
        event.target.closest(
          '.react-flow__node, .react-flow__edge, .react-flow__handle, .react-flow__nodesselection, .osint-edge-label, .react-flow__controls, .react-flow__minimap, .react-flow__panel'
        )
      ) {
        return;
      }
      rightPressRef.current = {
        x: event.clientX,
        y: event.clientY,
        additive: event.ctrlKey || event.metaKey || event.shiftKey,
        base: new Set(nodes.filter((n) => n.selected).map((n) => n.id)),
        moved: false,
      };
    },
    [isMobile, nodes]
  );

  useEffect(() => {
    const onMove = (e) => {
      const press = rightPressRef.current;
      if (!press) return;
      if (!press.moved) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < RIGHT_DRAG_THRESHOLD) return;
        press.moved = true;
      }
      const box = { x1: press.x, y1: press.y, x2: e.clientX, y2: e.clientY };
      setRightBox(box);
      selectInBox(box, press.additive, press.base);
    };
    const onUp = (e) => {
      const press = rightPressRef.current;
      if (!press || e.button !== 2) return;
      rightPressRef.current = null;
      setRightBox(null);
      // Swallow the contextmenu Windows fires right after mouseup
      suppressMenuUntil.current = Date.now() + 400;
      if (!press.moved) openQuickSearch(press.x, press.y);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && rightPressRef.current) {
        rightPressRef.current = null;
        setRightBox(null);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [selectInBox, openQuickSearch]);

  // Right-click on canvas (or the keyboard Menu key): quick-search.
  // Mouse right-clicks on the pane are handled on mouseup (see above).
  const handleContextMenu = useCallback(
    (event) => {
      event.preventDefault();
      if (rightPressRef.current || Date.now() < suppressMenuUntil.current) return;
      openQuickSearch(event.clientX, event.clientY);
    },
    [openQuickSearch]
  );

  // Long-press on mobile
  const touchStartRef = useRef(null);

  const handleTouchStart = useCallback(
    (event) => {
      // Only on mobile, and only if not interacting with a node
      if (!isMobile) return;
      if (event.target.closest('.react-flow__node')) return;
      const touch = event.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      longPressTimer.current = setTimeout(() => {
        if (touchStartRef.current) {
          openQuickSearch(touchStartRef.current.x, touchStartRef.current.y);
        }
      }, 500);
    },
    [isMobile, openQuickSearch]
  );

  const handleTouchEnd = useCallback(() => {
    touchStartRef.current = null;
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    // Cancel long-press if finger moves
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartRef.current = null;
  }, []);

  // Listen for clear-canvas event from Sidebar
  useEffect(() => {
    const handler = () => {
      isUndoRedoing.current = true;
      setNodes([]);
      setEdges([]);
      setTimeout(() => { isUndoRedoing.current = false; }, 0);
    };
    window.addEventListener('clear-canvas', handler);
    return () => window.removeEventListener('clear-canvas', handler);
  }, [setNodes, setEdges]);

  // View Results button on a node dispatches this; open the shared popup
  useEffect(() => {
    const handler = (e) => setReportNodeId(e.detail);
    window.addEventListener('maigret-view-results', handler);
    return () => window.removeEventListener('maigret-view-results', handler);
  }, []);

  // Arrow-key panning when board is focused
  const ARROW_PAN = 40;

  const handleKeyDown = useCallback(
    (e) => {
      if (!reactFlowInstance) return;
      // Only handle when no modifier held and no input is focused
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      let dx = 0;
      let dy = 0;
      switch (e.key) {
        case 'ArrowUp':    dy =  ARROW_PAN; break;
        case 'ArrowDown':  dy = -ARROW_PAN; break;
        case 'ArrowLeft':  dx =  ARROW_PAN; break;
        case 'ArrowRight': dx = -ARROW_PAN; break;
        default: return;
      }

      e.preventDefault();
      const { x, y, zoom } = reactFlowInstance.getViewport();
      reactFlowInstance.setViewport({ x: x + dx, y: y + dy, zoom });
    },
    [reactFlowInstance]
  );

  const handleWrapperMouseDown = useCallback(() => {
    reactFlowWrapper.current?.focus();
  }, []);

  return (
    <NodeStateContext.Provider value={setNodes}>
    <EdgeUIContext.Provider value={edgeUI}>
    <div
      className={`canvas-wrapper ${isConnecting ? 'canvas-wrapper--connecting' : ''} ${edgeSelected ? 'canvas-wrapper--edge-selected' : ''}`}
      ref={reactFlowWrapper}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseDown={handleWrapperMouseDown}
      onMouseMove={(e) => { pointerRef.current = { x: e.clientX, y: e.clientY }; }}
      onMouseLeave={() => { pointerRef.current = null; }}
      onMouseDownCapture={handleRightMouseDown}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      {isMobile && pendingNodeType && (
        <div className="canvas-placement-hint">
          <span>
            Tap canvas to place{' '}
            <strong>
              {NODE_TYPE_MAP[pendingNodeType]?.label || pendingNodeType}
            </strong>
          </span>
          <button
            className="canvas-placement-cancel"
            onClick={() => onNodePlaced?.()}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Quick-search floating box */}
      {quickSearchPos && (
        <QuickSearch
          position={quickSearchPos}
          onSelect={handleQuickSelect}
          onClose={closeQuickSearch}
        />
      )}

      {/* Username node context menu */}
      {nodeMenu && (
        <NodeContextMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          username={
            nodes.find((n) => n.id === nodeMenu.nodeId)?.data?.label?.trim() ||
            ''
          }
          hasResults={
            nodes.find((n) => n.id === nodeMenu.nodeId)?.data?.maigret
              ?.status === 'done'
          }
          onRunScan={() => runMaigretScan(nodeMenu.nodeId)}
          onViewResults={() => setReportNodeId(nodeMenu.nodeId)}
          onClose={() => setNodeMenu(null)}
        />
      )}

      {/* Maigret results popup */}
      {reportNodeId &&
        (() => {
          const maigret = nodes.find((n) => n.id === reportNodeId)?.data
            ?.maigret;
          return maigret ? (
            <MaigretReport
              maigret={maigret}
              onClose={() => setReportNodeId(null)}
            />
          ) : null;
        })()}

      {/* Undo/Redo toolbar */}
      <div className="undo-redo-toolbar">
        <button
          className="undo-redo-btn"
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          ↩
        </button>
        <button
          className="undo-redo-btn"
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl+Y)"
        >
          ↪
        </button>
        <button
          className="undo-redo-btn auto-layout-btn"
          onClick={handleAutoLayout}
          disabled={nodes.length === 0}
          title="Auto Layout (Ctrl+L)"
        >
          🔀
        </button>
        <button
          className={`undo-redo-btn edge-routing-btn ${edgeRouting === EDGE_ROUTING_AUTO ? 'edge-routing-btn--auto' : ''}`}
          onClick={toggleEdgeRouting}
          title={
            edgeRouting === EDGE_ROUTING_AUTO
              ? 'Edges: Auto — attach to the nearest sides of nodes. Click for Manual.'
              : 'Edges: Manual — stay on the points you chose. Click for Auto.'
          }
        >
          {edgeRouting === EDGE_ROUTING_AUTO ? '⇄ Auto' : '✋ Manual'}
        </button>
      </div>

      {rightBox && (
        <div
          className="right-select-box"
          style={{
            left: Math.min(rightBox.x1, rightBox.x2),
            top: Math.min(rightBox.y1, rightBox.y2),
            width: Math.abs(rightBox.x2 - rightBox.x1),
            height: Math.abs(rightBox.y2 - rightBox.y1),
          }}
        />
      )}

      {selectedCount > 1 && (
        <div className="selection-bar">
          <span className="selection-bar-count">{selectedCount} selected</span>
          <button onClick={copySelection} title="Copy (Ctrl+C), paste with Ctrl+V">
            Copy
          </button>
          <button onClick={duplicateSelection} title="Duplicate">
            Duplicate
          </button>
          <button className="selection-bar-danger" onClick={deleteSelection} title="Delete (Del)">
            Delete
          </button>
          <button className="selection-bar-close" onClick={clearSelection} title="Clear selection (Esc)">
            ✕
          </button>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onReconnect={onReconnect}
        onReconnectStart={onReconnectStart}
        onReconnectEnd={onReconnectEnd}
        onEdgeDoubleClick={onEdgeDoubleClick}
        isValidConnection={isValidConnection}
        connectionMode={ConnectionMode.Loose}
        connectionLineType={ConnectionLineType.SmoothStep}
        // Edges always stay BEHIND nodes (no elevateEdgesOnSelect — it lifted
        // a selected node's edges above every other node). To keep reconnect
        // usable, handles stop catching the mouse while an edge is selected
        // (see .canvas-wrapper--edge-selected) and the end anchors are larger.
        reconnectRadius={16}
        edgeTypes={edgeTypes}
        onInit={setReactFlowInstance}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onPaneClick={onPaneClick}
        onNodesDelete={onNodesDelete}
        onNodeContextMenu={handleNodeContextMenu}
        nodeTypes={nodeTypes}
        defaultViewport={defaultViewport}
        snapToGrid
        snapGrid={[SNAP_GRID, SNAP_GRID]}
        selectionMode={SelectionMode.Partial}
        // Ctrl (Windows/Linux) or Cmd (macOS) + click adds/removes nodes;
        // Shift or Ctrl/Cmd + drag on empty canvas draws a selection box.
        multiSelectionKeyCode={['Control', 'Meta']}
        selectionKeyCode={['Shift', 'Control', 'Meta']}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView={false}
        minZoom={0.1}
        maxZoom={4}
        panOnScroll={false}
        zoomOnScroll={true}
        selectNodesOnDrag={false}
        panActivationKeyCode="Space"
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={SNAP_GRID}
          size={1}
          color="#1a1a2e"
        />
        <Controls
          showInteractive={false}
          style={{
            background: '#111',
            border: '1px solid #333',
            borderRadius: 8,
            ...(isMobile ? { transform: 'scale(1.3)', transformOrigin: 'bottom left', marginBottom: 8, marginLeft: 8 } : {}),
          }}
        />
        {!isMobile && (
          <MiniMap
            nodeColor={(node) => {
              const nt = node.data?.nodeType;
              return NODE_TYPE_MAP[nt]?.color || '#555';
            }}
            maskColor="#000000cc"
            style={{
              background: '#0a0a0a',
              border: '1px solid #333',
              borderRadius: 8,
            }}
          />
        )}
      </ReactFlow>
    </div>
    </EdgeUIContext.Provider>
    </NodeStateContext.Provider>
  );
});

export default Canvas;
