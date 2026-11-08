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
const MAX_HISTORY = 50;
const HISTORY_DEBOUNCE = 300; // ms

const INITIAL_NODES = [];
const INITIAL_EDGES = [];

// Deep-clone for history snapshots (strips heavy base64 media data)
const cloneForHistory = (nodes, edges) => {
  const clonedNodes = nodes.map((n) => ({
    ...n,
    data: { ...n.data, media: undefined },
    position: { ...n.position },
  }));
  const clonedEdges = edges.map((e) => ({ ...e }));
  return { nodes: clonedNodes, edges: clonedEdges };
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

  // --- Undo / Redo system ---
  const historyRef = useRef([{ nodes: [], edges: [] }]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const isUndoRedoing = useRef(false);
  const pushTimerRef = useRef(null);
  const skipNextPush = useRef(false); // set by auto-layout to suppress one debounced push

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < historyRef.current.length - 1;

  // Debounced push: after changes settle, push a snapshot to history
  const schedulePush = useCallback(() => {
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      if (isUndoRedoing.current) return;
      if (skipNextPush.current) {
        skipNextPush.current = false;
        return;
      }

      const currentSnapshot = cloneForHistory(nodes, edges);

      historyRef.current = [
        ...historyRef.current.slice(0, historyIndex + 1),
        currentSnapshot,
      ];

      // Trim if over max
      if (historyRef.current.length > MAX_HISTORY) {
        historyRef.current = historyRef.current.slice(-MAX_HISTORY);
      }

      setHistoryIndex(historyRef.current.length - 1);
    }, HISTORY_DEBOUNCE);
  }, [nodes, edges, historyIndex]);

  // Watch for changes and schedule history push
  useEffect(() => {
    if (isUndoRedoing.current) return;
    schedulePush();
  }, [nodes, edges, schedulePush]);

  const undo = useCallback(() => {
    if (historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    const snapshot = historyRef.current[newIndex];
    if (!snapshot) return;

    isUndoRedoing.current = true;
    setNodes(mergeSnapshot(snapshot.nodes, nodes));
    setEdges(snapshot.edges);
    setHistoryIndex(newIndex);
    // Reset flag after React commits the update
    setTimeout(() => { isUndoRedoing.current = false; }, 0);
  }, [historyIndex, setNodes, setEdges, nodes]);

  const redo = useCallback(() => {
    if (historyIndex >= historyRef.current.length - 1) return;
    const newIndex = historyIndex + 1;
    const snapshot = historyRef.current[newIndex];
    if (!snapshot) return;

    isUndoRedoing.current = true;
    setNodes(mergeSnapshot(snapshot.nodes, nodes));
    setEdges(snapshot.edges);
    setHistoryIndex(newIndex);
    setTimeout(() => { isUndoRedoing.current = false; }, 0);
  }, [historyIndex, setNodes, setEdges, nodes]);

  // Auto-layout: rearrange nodes for optimal readability
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0 || !reactFlowInstance) return;

    // Compute new layout
    const laidOut = autoLayout(nodes, edges);

    // Push BOTH pre- and post-layout snapshots immediately into history
    // so undo works the instant the layout is applied — no waiting for debounce.
    const preSnapshot = cloneForHistory(nodes, edges);
    const postSnapshot = cloneForHistory(laidOut, edges);
    historyRef.current = [
      ...historyRef.current.slice(0, historyIndex + 1),
      preSnapshot,
      postSnapshot,
    ];
    if (historyRef.current.length > MAX_HISTORY) {
      historyRef.current = historyRef.current.slice(-MAX_HISTORY);
    }
    setHistoryIndex(historyRef.current.length - 1);

    // Suppress the next debounced push — we already pushed both snapshots
    skipNextPush.current = true;

    setNodes(laidOut);

    // Fit the new layout in view after React commits
    setTimeout(() => {
      reactFlowInstance.fitView({ padding: 0.2, duration: 400 });
    }, 50);
  }, [nodes, edges, setNodes, reactFlowInstance, historyIndex]);

  // Keyboard shortcuts for undo/redo/auto-layout
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 'l') {
        e.preventDefault();
        handleAutoLayout();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo, handleAutoLayout]);

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

      isUndoRedoing.current = true;
      setNodes(newNodes);
      setEdges(migratedEdges);
      setEditingEdgeId(null);
      setTimeout(() => { isUndoRedoing.current = false; }, 0);

      // Reset history with this as the initial state
      historyRef.current = [cloneForHistory(newNodes, migratedEdges)];
      setHistoryIndex(0);
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
  }, []);

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

  // Right-click on canvas
  const handleContextMenu = useCallback(
    (event) => {
      event.preventDefault();
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
    <EdgeUIContext.Provider value={edgeUI}>
    <div
      className={`canvas-wrapper ${isConnecting ? 'canvas-wrapper--connecting' : ''}`}
      ref={reactFlowWrapper}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseDown={handleWrapperMouseDown}
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
        // A selected edge is drawn above nodes so its end anchors aren't
        // covered by the node handles sitting at the same spot (reconnect).
        elevateEdgesOnSelect
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
  );
});

export default Canvas;
