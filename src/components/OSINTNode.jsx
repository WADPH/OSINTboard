import { memo, useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from 'reactflow';
import NodeHandles from './NodeHandles';
import { NODE_TYPE_MAP } from '../data/nodeTypes';
import MediaAttachments from './MediaAttachments';
import MediaLightbox from './MediaLightbox';

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Single point of truth: a video id is exactly 11 characters of
 * [A-Za-z0-9_-], or nothing at all.
 */
function assertVideoId(id) {
  return typeof id === 'string' && YOUTUBE_ID_RE.test(id) ? id : null;
}

/**
 * Extract a YouTube video ID from various URL formats.
 *
 * Returns a validated id, or null. The result always matches YOUTUBE_ID_RE, so
 * it is safe to interpolate into the embed URL — no quote, `<`, or `:` from the
 * node label can survive this function.
 */
function extractYouTubeId(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  const shortMatch = trimmed.match(/^https?:\/\/(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[?&#]|$)/);
  if (shortMatch) return assertVideoId(shortMatch[1]);

  const longMatch = trimmed.match(
    /^https?:\/\/(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com|youtube\.com)\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/
  );
  if (longMatch) return assertVideoId(longMatch[1]);

  return null;
}

const OSINTNode = memo(({ id, data, selected }) => {
  const nodeDef = NODE_TYPE_MAP[data.nodeType] || NODE_TYPE_MAP.note;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(data.label || '');
  const [dateValue, setDateValue] = useState(data.dateValue || '');
  const [personTitle, setPersonTitle] = useState(data.personTitle || '');
  const [renderTick, setRenderTick] = useState(0);
  const [lightboxItem, setLightboxItem] = useState(null);
  const media = data.media || [];
  const { deleteElements } = useReactFlow();
  const nodeRef = useRef(null);

  const isPerson = data.nodeType === 'person';
  const isDate = data.nodeType === 'date';
  const isExternalLink = data.nodeType === 'external-link';

  // Dismiss editing when clicking outside the node
  useEffect(() => {
    if (!editing) return;
    const handler = (e) => {
      if (nodeRef.current && !nodeRef.current.contains(e.target)) {
        commitEditRef.current();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
      document.addEventListener('touchstart', handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [editing]);

  // Refs for latest values (used by click-outside handler)
  const labelRef = useRef(label);
  const dateRef = useRef(dateValue);
  const personTitleRef = useRef(personTitle);
  labelRef.current = label;
  dateRef.current = dateValue;
  personTitleRef.current = personTitle;

  const commitEditRef = useRef(() => {
    data.label = labelRef.current;
    if (isDate) data.dateValue = dateRef.current;
    if (isPerson) data.personTitle = personTitleRef.current;
    setEditing(false);
  });

  const handleDelete = useCallback(
    (e) => {
      e.stopPropagation();
      deleteElements({ nodes: [{ id }] });
    },
    [id, deleteElements]
  );

  const handleAddMedia = useCallback((item) => {
    if (!data.media) data.media = [];
    data.media.push(item);
    setRenderTick((t) => t + 1);
  }, [data]);

  const handleRemoveMedia = useCallback((mediaId) => {
    if (!data.media) return;
    data.media = data.media.filter((m) => m.id !== mediaId);
    setRenderTick((t) => t + 1);
  }, [data]);

  const color = nodeDef.color;
  const youtubeId = useMemo(() => extractYouTubeId(data.label), [data.label]);

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    setLabel(data.label || '');
    setDateValue(data.dateValue || '');
    setPersonTitle(data.personTitle || '');
    setEditing(true);
  };

  const commitEdit = () => {
    data.label = label;
    if (isDate) data.dateValue = dateValue;
    if (isPerson) data.personTitle = personTitle;
    setEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      commitEdit();
    }
    if (e.key === 'Escape') {
      setEditing(false);
      setLabel(data.label || '');
      setDateValue(data.dateValue || '');
      setPersonTitle(data.personTitle || '');
    }
  };

  const formatDate = (iso) => {
    if (!iso) return null;
    try {
      const d = new Date(iso + 'T00:00:00');
      return d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return iso;
    }
  };

  return (
    <>
    <div
      ref={nodeRef}
      className={`osint-node ${selected ? 'selected' : ''} ${isExternalLink ? 'osint-node--external-link' : ''} ${youtubeId ? 'osint-node--has-video' : ''}`}
      onDoubleClick={!youtubeId || editing ? handleDoubleClick : undefined}
      style={{
        borderColor: color,
        boxShadow: selected
          ? `0 0 12px ${color}44, 0 0 0 1px ${color}`
          : `0 0 0 1px ${color}88`,
      }}
    >
      <NodeHandles color={color} />
      <div
        className="osint-node-header"
        style={{ borderBottomColor: color + '66' }}
      >
        <span className="osint-node-icon">{nodeDef.icon}</span>
        <span className="osint-node-type-label" style={{ color }}>
          {nodeDef.label}
        </span>
        {editing && (
          <button
            className="node-delete-btn"
            onClick={handleDelete}
            title="Delete node"
          >
            🗑️
          </button>
        )}
      </div>
      <div className="osint-node-body">
        {isExternalLink && youtubeId && !editing ? (
          <div className="osint-node-video" onClick={() => setEditing(true)}>
            <div className="osint-node-video-embed">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeId)}?autoplay=0&rel=0`}
                title="YouTube video player"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
            <div className="osint-node-video-url" title={data.label}>
              {data.label}
            </div>
          </div>
        ) : editing ? (
          <div className="osint-node-edit-area">
            {isDate && (
              <input
                className="osint-node-input"
                type="date"
                value={dateValue}
                onChange={(e) => setDateValue(e.target.value)}
                autoFocus
              />
            )}
            <input
              className="osint-node-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isPerson
                  ? 'Full name…'
                  : isExternalLink
                  ? 'Paste a URL…'
                  : isDate
                  ? 'Event description…'
                  : 'Enter details…'
              }
              autoFocus={!isDate}
            />
            {isPerson && (
              <input
                className="osint-node-input osint-node-input--title"
                value={personTitle}
                onChange={(e) => setPersonTitle(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Title, role, or position…"
              />
            )}
            {isExternalLink && (
              <div className="osint-node-url-hint">
                YouTube links auto-embed a player ↗
              </div>
            )}
            <MediaAttachments
              media={media}
              onAdd={handleAddMedia}
              onRemove={handleRemoveMedia}
            />
          </div>
        ) : (
          <div
            className="osint-node-label"
            onDoubleClick={handleDoubleClick}
            title={data.label}
          >
            {isDate && formatDate(data.dateValue) && (
              <div className="osint-node-date-display">
                {formatDate(data.dateValue)}
              </div>
            )}
            {data.label ? (
              isExternalLink ? (
                <span className="osint-node-url-display">
                  🔗 {data.label}
                </span>
              ) : (
                <div>
                  {data.label}
                  {isPerson && data.personTitle && (
                    <div className="osint-node-person-title">{data.personTitle}</div>
                  )}
                </div>
              )
            ) : (
              <span className="osint-node-placeholder">
                {isExternalLink
                  ? 'Double-click to add a URL'
                  : 'Double-click to edit'}
              </span>
            )}
            {media.length > 0 && (
              <div className="osint-node-media-preview">
                {media.slice(0, 4).map((item) => (
                  <div
                    key={item.id}
                    className="osint-node-media-thumb"
                    onClick={() => setLightboxItem(item)}
                  >
                    {item.type === 'image' && (
                      <img src={item.url} alt={item.name} />
                    )}
                    {item.type === 'video' && '🎬'}
                    {item.type === 'audio' && '🎵'}
                  </div>
                ))}
                {media.length > 4 && (
                  <span className="osint-node-media-more">+{media.length - 4}</span>
                )}
              </div>
            )}
            {data.nodeType === 'username' && data.maigret && (
              <div className="osint-node-scan">
                {data.maigret.status === 'pending' && (
                  <div className="osint-node-scan-status">Scan queued…</div>
                )}
                {data.maigret.status === 'running' && (
                  <div className="osint-node-scan-status">Scanning…</div>
                )}
                {data.maigret.status === 'error' && (
                  <div className="osint-node-scan-status osint-node-scan-status--error">
                    Scan failed: {data.maigret.error}
                  </div>
                )}
                {data.maigret.status === 'done' && (
                  <button
                    className="osint-node-scan-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      window.dispatchEvent(
                        new CustomEvent('maigret-view-results', {
                          detail: id,
                        })
                      );
                    }}
                  >
                    📄 View Results
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
    {lightboxItem && (
      <MediaLightbox
        item={lightboxItem}
        onClose={() => setLightboxItem(null)}
      />
    )}
    </>
  );
});

OSINTNode.displayName = 'OSINTNode';

export default OSINTNode;
