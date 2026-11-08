/**
 * Graph storage — server-side (SQLite via the backend API).
 *
 * Graphs used to live in this browser's localStorage. They are now stored by
 * the backend, so they survive clearing browser data and are shared by every
 * browser/device that opens this OSINTboard. Only the "last opened graph" id
 * stays in localStorage (a per-browser preference).
 */
import { apiFetch } from '../utils/api';

const LEGACY_STORAGE_KEY = 'osintboard_graphs';
const MIGRATED_KEY = 'osintboard_graphs_migrated_to_server';
const LAST_OPEN_KEY = 'osintboard_last_open';

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** → [{ id, name, savedAt }] newest first */
export async function listGraphs() {
  const res = await apiFetch('/graphs');
  return res.json();
}

/**
 * Save under `name`; an existing graph with the same name is overwritten.
 * → { id, name, savedAt }
 */
export async function saveGraph(name, nodes, edges) {
  const res = await apiFetch('/graphs', json({ name, nodes, edges }));
  const graph = await res.json();
  setLastOpenGraphId(graph.id);
  return graph;
}

/** → { id, name, savedAt, nodes, edges } or null if it no longer exists */
export async function loadGraph(id) {
  try {
    const res = await apiFetch(`/graphs/${encodeURIComponent(id)}`);
    return await res.json();
  } catch (err) {
    if (/not found|^404/i.test(err.message)) return null;
    throw err;
  }
}

export async function deleteGraph(id) {
  await apiFetch(`/graphs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (getLastOpenGraphId() === id) clearLastOpenGraph();
}

/** Throws if the backend is unreachable. */
export async function checkServer() {
  await apiFetch('/health');
}

// --- Last-opened graph (per browser) ---

export function getLastOpenGraphId() {
  try {
    return localStorage.getItem(LAST_OPEN_KEY);
  } catch {
    return null;
  }
}

export function setLastOpenGraphId(id) {
  try {
    localStorage.setItem(LAST_OPEN_KEY, id);
  } catch {
    // storage unavailable — ignore
  }
}

export function clearLastOpenGraph() {
  try {
    localStorage.removeItem(LAST_OPEN_KEY);
  } catch {
    // ignore
  }
}

/** The graph this browser had open last, or null. Throws if the server is down. */
export async function getLastOpenGraph() {
  const id = getLastOpenGraphId();
  if (!id) return null;
  const graph = await loadGraph(id);
  if (!graph) clearLastOpenGraph();
  return graph;
}

// --- One-time migration of graphs saved by older (browser-only) versions ---

let migration = null;

/**
 * Upload graphs left in this browser's localStorage to the server, once.
 * A name already taken on the server gets a " (from browser)" suffix so
 * nothing is overwritten. The local copy is kept as a backup.
 * Safe to call repeatedly/concurrently (React StrictMode runs effects twice).
 * → number of graphs migrated
 */
export function migrateLocalGraphs() {
  if (!migration) migration = runMigration();
  return migration;
}

async function runMigration() {
  let local;
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return 0;
    local = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY) || '[]');
  } catch {
    return 0;
  }
  if (!Array.isArray(local) || local.length === 0) {
    try {
      localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
    } catch {
      // ignore
    }
    return 0;
  }

  const taken = new Set((await listGraphs()).map((g) => g.name));
  const lastOpen = getLastOpenGraphId();
  let count = 0;
  for (const g of local) {
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) continue;
    let name = String(g.name || 'Untitled').slice(0, 180);
    if (taken.has(name)) name = `${name} (from browser)`;
    let suffix = 2;
    while (taken.has(name)) name = `${g.name} (from browser ${suffix++})`;
    taken.add(name);
    const res = await apiFetch('/graphs', json({ name, nodes: g.nodes, edges: g.edges }));
    const saved = await res.json();
    if (g.id === lastOpen) setLastOpenGraphId(saved.id);
    count += 1;
  }
  localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
  return count;
}

// --- File export / import (unchanged format) ---

export function exportGraphToFile(name, nodes, edges) {
  const data = { name, nodes, edges, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.osintboard.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function importGraphFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.nodes || !data.edges) {
          reject(new Error('Invalid graph file — missing nodes or edges'));
          return;
        }
        resolve({
          nodes: data.nodes,
          edges: data.edges,
          name: data.name || null,
        });
      } catch {
        reject(new Error('Invalid JSON file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
