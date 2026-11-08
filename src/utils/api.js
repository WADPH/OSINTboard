/**
 * Backend API base + fetch helper.
 *
 * Paths are prefixed with Vite's BASE_URL because the app may be mounted under
 * a sub-path (e.g. /osint/ in dev); a bare `/api/...` would hit the site root
 * instead of this app's backend.
 */
export const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

/** fetch(API_BASE + path); throws Error(detail) on non-2xx. */
export async function apiFetch(path, options) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, options);
  } catch {
    throw new Error('Server unreachable');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const detail = typeof body.detail === 'string' ? body.detail : null;
    throw new Error(detail || `${res.status} ${res.statusText}`.trim());
  }
  return res;
}
