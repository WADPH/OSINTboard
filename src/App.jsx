import { useState, useCallback, useRef, useEffect } from 'react';
import { ReactFlowProvider } from 'reactflow';
import Sidebar from './components/Sidebar';
import Canvas from './components/Canvas';
import GraphModal from './components/GraphModal';
import {
  saveGraph,
  getLastOpenGraph,
  setLastOpenGraphId,
  clearLastOpenGraph,
  exportGraphToFile,
  importGraphFromFile,
  migrateLocalGraphs,
  checkServer,
} from './data/graphStore';
import './App.css';

const MOBILE_BREAKPOINT = 768;

// Demo graph shown on very first launch (no saved graphs, no last-open)
const DEMO_NODES = [
  {
    id: 'osint_1',
    type: 'osintNode',
    position: { x: 300, y: 200 },
    data: { nodeType: 'person', label: 'Target Name' },
  },
  {
    id: 'osint_2',
    type: 'osintNode',
    position: { x: 100, y: 400 },
    data: { nodeType: 'phone', label: '' },
  },
  {
    id: 'osint_3',
    type: 'osintNode',
    position: { x: 500, y: 400 },
    data: { nodeType: 'email', label: '' },
  },
];

const DEMO_EDGES = [
  {
    id: 'e1-2',
    source: 'osint_1',
    target: 'osint_2',
    style: { stroke: '#888', strokeWidth: 2 },
    markerEnd: { type: 'arrowclosed', color: '#888' },
  },
  {
    id: 'e1-3',
    source: 'osint_1',
    target: 'osint_3',
    style: { stroke: '#888', strokeWidth: 2 },
    markerEnd: { type: 'arrowclosed', color: '#888' },
  },
];

function App() {
  const [modalMode, setModalMode] = useState(null);
  const [graphName, setGraphName] = useState('Untitled');
  const [importError, setImportError] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState(null);

  const toastTimer = useRef(null);
  const showToast = useCallback((message, type) => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), type === 'error' ? 5000 : 2500);
  }, []);
  const [pendingNodeType, setPendingNodeType] = useState(null);
  const [isMobile, setIsMobile] = useState(
    () => window.innerWidth < MOBILE_BREAKPOINT
  );
  const canvasRef = useRef(null);
  const importInputRef = useRef(null);

  // On mount: move graphs from older browser-only versions to the server,
  // then open the last-open graph (or the demo if there is none).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let migrated = 0;
      let lastGraph = null;
      let serverError = null;
      try {
        migrated = await migrateLocalGraphs();
        lastGraph = await getLastOpenGraph();
        // Nothing to load → nothing has hit the server yet; check it anyway so
        // an outage shows up now, not on the first save.
        if (!lastGraph) await checkServer();
      } catch (err) {
        serverError = err;
      }
      if (cancelled) return;
      if (lastGraph) {
        canvasRef.current?.loadSnapshot(lastGraph.nodes, lastGraph.edges);
        setGraphName(lastGraph.name);
      } else {
        canvasRef.current?.loadSnapshot(DEMO_NODES, DEMO_EDGES);
      }
      if (serverError) {
        showToast(`Can't reach the server — graphs can't be loaded or saved (${serverError.message})`, 'error');
      } else if (migrated > 0) {
        showToast(`Moved ${migrated} graph${migrated > 1 ? 's' : ''} from this browser to the server`, 'success');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Track viewport size for mobile detection
  useEffect(() => {
    const onResize = () => {
      const mobile = window.innerWidth < MOBILE_BREAKPOINT;
      setIsMobile(mobile);
      if (!mobile) {
        setSidebarOpen(false);
        setPendingNodeType(null);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  // Mobile: user tapped a node type in the sidebar — close & arm for placement
  const handleSelectNodeType = useCallback((nodeType) => {
    setPendingNodeType(nodeType);
    setSidebarOpen(false);
  }, []);

  // Mobile: node was placed on canvas — clear pending type
  const handleNodePlaced = useCallback(() => {
    setPendingNodeType(null);
  }, []);

  const openModal = useCallback((mode) => {
    setModalMode(mode);
  }, []);

  const closeModal = useCallback(() => {
    setModalMode(null);
  }, []);

  const handleSave = useCallback(
    async (name) => {
      const snapshot = canvasRef.current?.getSnapshot();
      if (!snapshot) return;
      try {
        await saveGraph(name, snapshot.nodes, snapshot.edges);
        setGraphName(name);
        showToast('Saved', 'success');
      } catch (err) {
        showToast(`Save failed: ${err.message}`, 'error');
      }
    },
    [showToast]
  );

  // Quick-save / Save: use the current board name if it has one,
  // otherwise open the naming modal
  const handleSaveCurrent = useCallback((e) => {
    e?.currentTarget?.blur();
    if (graphName && graphName !== 'Untitled') {
      handleSave(graphName);
    } else {
      openModal('save');
    }
  }, [graphName, openModal, handleSave]);

  const handleLoad = useCallback(
    (nodes, edges, name, graphId) => {
      canvasRef.current?.loadSnapshot(nodes, edges);
      setGraphName(name || 'Untitled');
      if (graphId) {
        setLastOpenGraphId(graphId);
      }
    },
    []
  );

  const handleNew = useCallback(() => {
    canvasRef.current?.loadSnapshot([], []);
    setGraphName('Untitled');
    clearLastOpenGraph();
  }, []);

  const handleExport = useCallback(() => {
    const snapshot = canvasRef.current?.getSnapshot();
    if (!snapshot) return;
    exportGraphToFile(graphName, snapshot.nodes, snapshot.edges);
  }, [graphName]);

  const handleImport = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setImportError(null);
      try {
        const { nodes, edges, name } = await importGraphFromFile(file);
        canvasRef.current?.loadSnapshot(nodes, edges);
        setGraphName(name || 'Untitled');
      } catch (err) {
        setImportError(err.message);
      }
      e.target.value = '';
    },
    []
  );

  return (
    <ReactFlowProvider>
      <div className={`app ${isMobile ? 'app--mobile' : ''}`}>
        {isMobile && (
          <header className="mobile-header">
            <button
              className="mobile-header__hamburger"
              onClick={toggleSidebar}
              aria-label="Toggle menu"
            >
              <span className="hamburger-icon">
                <span />
                <span />
                <span />
              </span>
            </button>
            <span className="mobile-header__title">{graphName}</span>
            <button
              className="mobile-header__action"
              onClick={handleSaveCurrent}
              title={graphName !== 'Untitled' ? 'Save' : 'Save as…'}
            >
              💾
            </button>
          </header>
        )}
        {toast && (
          <div className={`toast-notification toast-notification--${toast.type}`}>
            {toast.message}
          </div>
        )}
        <Sidebar
          graphName={graphName}
          importError={importError}
          isMobile={isMobile}
          isOpen={sidebarOpen}
          pendingNodeType={pendingNodeType}
          onClose={closeSidebar}
          onSelectNodeType={handleSelectNodeType}
          onSave={handleSaveCurrent}
          onLoad={() => openModal('load')}
          onNew={handleNew}
          onDelete={() => openModal('delete')}
          onExport={handleExport}
          onImport={handleImport}
        />
        <Canvas
          ref={canvasRef}
          isMobile={isMobile}
          pendingNodeType={pendingNodeType}
          onNodePlaced={handleNodePlaced}
        />
        <input
          ref={importInputRef}
          type="file"
          accept=".json,.osintboard.json"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
      </div>
      {modalMode && (
        <GraphModal
          mode={modalMode}
          onClose={closeModal}
          onSave={handleSave}
          onLoad={handleLoad}
        />
      )}
    </ReactFlowProvider>
  );
}

export default App;
