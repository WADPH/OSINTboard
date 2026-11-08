import { useState, useEffect, useCallback } from 'react';
import { listGraphs, loadGraph, deleteGraph } from '../data/graphStore';

export default function GraphModal({ mode, onClose, onSave, onLoad }) {
  const [saved, setSaved] = useState([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      setSaved(await listGraphs());
    } catch (err) {
      setListError(`Couldn't load graphs from the server: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'load' || mode === 'delete' || mode === 'save') refresh();
  }, [mode, refresh]);

  const handleSave = () => {
    // The overwrite check below needs the list of existing names
    if (loading) return;
    if (listError) {
      setError(listError);
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter a name for this graph');
      return;
    }
    if (saved.some((g) => g.name === trimmed)) {
      const ok = window.confirm(
        `"${trimmed}" already exists. Overwrite?`
      );
      if (!ok) return;
    }
    onSave(trimmed);
    onClose();
  };

  const handleLoad = async (id) => {
    if (busy) return;
    setBusy(true);
    try {
      const g = await loadGraph(id);
      if (!g) {
        setListError('This graph no longer exists.');
        refresh();
        return;
      }
      onLoad(g.nodes, g.edges, g.name, g.id);
      onClose();
    } catch (err) {
      setListError(`Couldn't open the graph: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id, graphName) => {
    if (!window.confirm(`Delete "${graphName}"?`)) return;
    try {
      await deleteGraph(id);
    } catch (err) {
      setListError(`Couldn't delete: ${err.message}`);
    }
    refresh();
  };

  const listStatus = loading ? (
    <div className="modal-empty">Loading…</div>
  ) : listError ? (
    <div className="modal-error">{listError}</div>
  ) : null;

  if (!mode) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>
            {mode === 'save'
              ? '💾 Save Graph'
              : mode === 'load'
              ? '📂 Load Graph'
              : mode === 'delete'
              ? '🗑️ Delete Graph'
              : '📁 Graphs'}
          </h3>
          <button className="modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {mode === 'save' && (
            <div className="modal-form">
              <label className="modal-label">Graph Name</label>
              <input
                className="modal-input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                placeholder="My Investigation"
                autoFocus
              />
              {error && <div className="modal-error">{error}</div>}
              <button
                className="modal-btn modal-btn-primary"
                onClick={handleSave}
                disabled={loading}
              >
                {loading ? 'Loading…' : '💾 Save'}
              </button>
            </div>
          )}

          {mode === 'load' && (
            <div className="modal-list">
              {listStatus ||
              (saved.length === 0 ? (
                <div className="modal-empty">No saved graphs yet.</div>
              ) : (
                saved.map((g) => (
                  <div
                    key={g.id}
                    className="modal-list-item"
                    onClick={() => handleLoad(g.id)}
                  >
                    <div className="modal-list-item-info">
                      <span className="modal-list-item-name">{g.name}</span>
                      <span className="modal-list-item-date">
                        {new Date(g.savedAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))
              ))}
            </div>
          )}

          {mode === 'delete' && (
            <div className="modal-list">
              {listStatus ||
              (saved.length === 0 ? (
                <div className="modal-empty">No saved graphs to delete.</div>
              ) : (
                saved.map((g) => (
                  <div key={g.id} className="modal-list-item">
                    <div className="modal-list-item-info">
                      <span className="modal-list-item-name">{g.name}</span>
                      <span className="modal-list-item-date">
                        {new Date(g.savedAt).toLocaleString()}
                      </span>
                    </div>
                    <button
                      className="modal-btn modal-btn-delete"
                      onClick={() => handleDelete(g.id, g.name)}
                    >
                      Delete
                    </button>
                  </div>
                ))
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
