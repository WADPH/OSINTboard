/**
 * Turn picked/dropped File objects into attachment items for node.data.media
 * (any file type: images/video/audio get previews, the rest are 'file').
 * Shared by the "Attach" button and drag-and-drop onto a Media Gallery.
 *
 * Files are uploaded to the backend; a media item stores only the server
 * `fileId` (plus name/type), never the bytes. Items from older boards may
 * still carry an inline `url` (base64 data URL) — mediaUrl() handles both.
 */
import { API_BASE, apiFetch } from './api';

// Keep in sync with OSINTBOARD_MAX_MEDIA_MB (docker-compose.yml)
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_FILE_LABEL = '100 MB';

/** URL to display a media item (server file or legacy inline data). */
export function mediaUrl(item) {
  if (item?.fileId) return `${API_BASE}/media/${encodeURIComponent(item.fileId)}`;
  return item?.url || '';
}

/** URL that downloads the file (with its original name) instead of showing it. */
export function mediaDownloadUrl(item) {
  if (item?.fileId) return `${mediaUrl(item)}?download=1`;
  return item?.url || '';
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const EXT_ICONS = [
  [/\.(pdf)$/i, '📕'],
  [/\.(zip|rar|7z|tar|gz|bz2|xz|tgz)$/i, '🗜️'],
  [/\.(docx?|odt|rtf|pages)$/i, '📝'],
  [/\.(xlsx?|ods|csv|tsv|numbers)$/i, '📊'],
  [/\.(pptx?|odp|key)$/i, '📽️'],
  [/\.(txt|md|log|json|xml|ya?ml|html?)$/i, '📄'],
  [/\.(eml|msg|mbox)$/i, '✉️'],
  [/\.(kml|kmz|gpx|geojson)$/i, '🗺️'],
];

/** Icon for an attachment (type first, then file extension). */
export function fileIcon(item) {
  if (item?.type === 'image') return '🖼️';
  if (item?.type === 'video') return '🎬';
  if (item?.type === 'audio') return '🎵';
  const hit = EXT_ICONS.find(([re]) => re.test(item?.name || ''));
  return hit ? hit[1] : '📎';
}

async function uploadFile(file) {
  const res = await apiFetch('/media', {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  return res.json(); // { id, name, mime, size }
}

// Must stay unique across page reloads: a plain counter restarted at
// media_1 and collided with ids already saved in a loaded board.
let mediaIdCounter = 0;
const nextMediaId = () =>
  `media_${Date.now().toString(36)}_${(++mediaIdCounter).toString(36)}`;

// image/video/audio get a preview; everything else is a downloadable 'file'.
// (SVG is treated as a file: the server never displays it inline.)
function classifyMime(mime = '') {
  if (mime === 'image/svg+xml') return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * @returns {Promise<{ items: object[], error: string|null }>}
 */
export async function filesToMedia(fileList) {
  const files = Array.from(fileList || []);
  const oversized = files.filter((f) => f.size > MAX_FILE_SIZE);
  const empty = files.filter((f) => f.size === 0);
  const accepted = files.filter((f) => f.size > 0 && f.size <= MAX_FILE_SIZE);

  const items = [];
  const failed = [];
  for (const file of accepted) {
    try {
      const stored = await uploadFile(file);
      items.push({
        id: nextMediaId(),
        fileId: stored.id,
        type: classifyMime(file.type),
        name: stored.name || file.name,
        mime: stored.mime || file.type,
        size: stored.size,
      });
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }

  const problems = [];
  if (oversized.length) {
    problems.push(`Files over ${MAX_FILE_LABEL} aren't supported (${oversized.map((f) => f.name).join(', ')})`);
  }
  if (empty.length) {
    problems.push(`Empty files skipped (${empty.map((f) => f.name).join(', ')})`);
  }
  if (failed.length) problems.push(`Upload failed (${failed.join('; ')})`);

  return { items, error: problems.length ? problems.join('. ') : null };
}
