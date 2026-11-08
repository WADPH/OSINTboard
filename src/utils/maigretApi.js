/**
 * maigret scan API client.
 */
import { apiFetch } from './api';

/** POST /api/maigret/scan → { scanId } */
export async function startScan(username) {
  const res = await apiFetch(`/maigret/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  return res.json();
}

/**
 * GET /api/maigret/scan/<id>
 * → { id, username, status, error, createdAt, completedAt, reportUrl, resultsUrl }
 */
export async function getScan(scanId) {
  const res = await apiFetch(`/maigret/scan/${scanId}`);
  return res.json();
}

/**
 * GET /api/maigret/results/<id> → parsed JSON.
 * Schema: { "<SiteName>": { "site": { tags: [...], url }, "status": {
 *   site_name, url, status: "Claimed"|..., ids: { fullname?, id? } } } }
 * `{}` when no accounts were found.
 */
export async function getResults(scanId) {
  const res = await apiFetch(`/maigret/results/${scanId}`);
  return res.json();
}
