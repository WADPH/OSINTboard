import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

/**
 * Provided by Canvas: the `setNodes` from its useNodesState.
 *
 * Not React Flow's `useReactFlow().setNodes`: in controlled mode that one
 * evaluates function updates against React Flow's internal store, which only
 * catches up after the parent re-renders — two quick updates (e.g. attaching
 * an image and an audio file in one pick) and the second overwrote the first.
 * React's own state setter queues function updates correctly.
 */
export const NodeStateContext = createContext(null);

/**
 * Immutable update of one node's `data`.
 *
 * Node components used to mutate `data` in place (`data.media.push(...)`,
 * `data.label = ...`). That broke in several ways: memoized children never
 * saw the change (same array reference), handlers created on first render kept
 * writing into a stale `data` object after undo/redo replaced it, and history
 * never noticed the edit. Going through state fixes all three.
 *
 * `update` is a patch object or a function `(data) => patch`.
 */
export function useUpdateNodeData(id) {
  const setNodes = useContext(NodeStateContext);
  return useCallback(
    (update) =>
      setNodes((nds) =>
        nds.map((n) =>
          n.id !== id
            ? n
            : {
                ...n,
                data: {
                  ...n.data,
                  ...(typeof update === 'function' ? update(n.data) : update),
                },
              }
        )
      ),
    [id, setNodes]
  );
}

/**
 * Call `onOutside` when the user presses anywhere outside `ref` while
 * `active`. Listens in the CAPTURE phase: React Flow's pan/zoom and node-drag
 * handlers stop propagation of mousedown, so a bubbling document listener
 * never fired for clicks on the canvas or on other nodes.
 * Clicks inside a media lightbox (rendered in a portal) don't count.
 */
export function useClickOutside(ref, active, onOutside) {
  const callbackRef = useRef(onOutside);
  useEffect(() => {
    callbackRef.current = onOutside;
  });

  useEffect(() => {
    if (!active) return;
    const handler = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      if (e.target.closest?.('.lightbox-overlay')) return;
      callbackRef.current();
    };
    // Defer so the event that started editing doesn't immediately end it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler, true);
      document.addEventListener('touchstart', handler, true);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler, true);
      document.removeEventListener('touchstart', handler, true);
    };
  }, [active, ref]);
}
