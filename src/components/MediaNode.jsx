import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { useReactFlow } from 'reactflow';
import NodeHandles from './NodeHandles';
import MediaAttachments from './MediaAttachments';

const MediaNode = memo(({ id, data, selected }) => {
  const [editing, setEditing] = useState(false);
  const [localLabel, setLocalLabel] = useState(data.label || '');
  const [renderTick, setRenderTick] = useState(0);
  const media = data.media || [];
  const { deleteElements } = useReactFlow();
  const nodeRef = useRef(null);

  const color = '#ba68c8';

  // Ref for latest local label (used by click-outside handler)
  const localLabelRef = useRef(localLabel);
  localLabelRef.current = localLabel;

  const commitEditExternal = useCallback(() => {
    data.label = localLabelRef.current;
    setEditing(false);
  }, []);

  // Dismiss editing when clicking outside the node
  useEffect(() => {
    if (!editing) return;
    const handler = (e) => {
      if (nodeRef.current && !nodeRef.current.contains(e.target)) {
        commitEditExternal();
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
  }, [editing, commitEditExternal]);

  const handleDelete = useCallback(
    (e) => {
      e.stopPropagation();
      deleteElements({ nodes: [{ id }] });
    },
    [id, deleteElements]
  );

  const commitEdit = () => {
    setEditing(false);
    data.label = localLabel;
  };

  const handleAddMedia = useCallback(
    (item) => {
      if (!data.media) data.media = [];
      data.media.push(item);
      setRenderTick((t) => t + 1);
    },
    [data]
  );

  const handleRemoveMedia = useCallback(
    (mediaId) => {
      if (!data.media) return;
      data.media = data.media.filter((m) => m.id !== mediaId);
      setRenderTick((t) => t + 1);
    },
    [data]
  );

  const imageCount = media.filter((m) => m.type === 'image').length;
  const videoCount = media.filter((m) => m.type === 'video').length;
  const audioCount = media.filter((m) => m.type === 'audio').length;

  return (
    <div
      ref={nodeRef}
      className={`media-node ${selected ? 'media-node--selected' : ''}`}
      style={{
        width: 360,
        borderColor: color,
        boxShadow: selected
          ? `0 0 12px ${color}44, 0 0 0 1px ${color}`
          : `0 0 0 1px ${color}88`,
      }}
    >
      <NodeHandles color={color} />

      <div
        className="media-node-header"
        style={{ borderBottomColor: color + '66' }}
        onDoubleClick={() => setEditing(true)}
      >
        <span className="osint-node-icon">🖼️</span>
        {editing ? (
          <input
            className="osint-node-input"
            value={localLabel}
            onChange={(e) => setLocalLabel(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') {
                setEditing(false);
                setLocalLabel(data.label || '');
              }
            }}
            placeholder="Gallery title…"
            autoFocus
          />
        ) : (
          <span className="media-node-title">
            {data.label || (
              <span className="osint-node-placeholder">Media Gallery</span>
            )}
            {media.length > 0 && (
              <span className="media-node-count">
                {imageCount > 0 && `${imageCount} photo`}
                {imageCount > 0 && (videoCount > 0 || audioCount > 0) && ' · '}
                {videoCount > 0 && `${videoCount} video`}
                {(imageCount > 0 || videoCount > 0) && audioCount > 0 && ' · '}
                {audioCount > 0 && `${audioCount} audio`}
              </span>
            )}
          </span>
        )}
        {editing && (
          <button
            className="node-delete-btn"
            onClick={handleDelete}
            title="Delete media gallery"
          >
            🗑️
          </button>
        )}
      </div>

      <div className="media-node-body">
        {editing ? (
          <div className="osint-node-edit-area">
            <MediaAttachments
              media={media}
              onAdd={handleAddMedia}
              onRemove={handleRemoveMedia}
            />
          </div>
        ) : (
          <>
            {media.length > 0 ? (
              <div className="media-node-gallery">
                {media.map((item) => (
                  <div key={item.id} className="media-node-gallery-item">
                    {item.type === 'image' && (
                      <img
                        src={item.url}
                        alt={item.name}
                        className="media-node-gallery-img"
                      />
                    )}
                    {item.type === 'video' && (
                      <video
                        src={item.url}
                        className="media-node-gallery-video"
                        controls
                        preload="metadata"
                      />
                    )}
                    {item.type === 'audio' && (
                      <div className="media-node-gallery-audio">
                        <audio src={item.url} controls preload="none" />
                        <span className="media-node-gallery-name">
                          {item.name}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="media-node-empty">
                Drop photos, videos, or audio recordings here
              </div>
            )}

          </>
        )}
      </div>

    </div>
  );
});

MediaNode.displayName = 'MediaNode';

export default MediaNode;
