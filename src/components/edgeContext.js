import { createContext } from 'react';

/** Shared UI state for edges: which edge's label is being edited. */
export const EdgeUIContext = createContext({
  editingEdgeId: null,
  setEditingEdgeId: () => {},
});
