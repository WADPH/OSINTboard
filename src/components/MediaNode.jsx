import { memo, useState, useCallback, useRef } from 'react';
import { useReactFlow } from 'reactflow';
import NodeHandles from './NodeHandles';
import MediaAttachments from './MediaAttachments';
import { useUpdateNodeData, useClickOutside } from './nodeHooks';
import { CustomFieldsEditor, CustomFieldsView } from './CustomFields';
import { cleanFields } from '../utils/customFields';
import { filesToMedia, mediaUrl, mediaDownloadUrl, fileIcon, formatSize } from '../utils/mediaFiles';

const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

const MediaNode = memo(({ id, data, selected }) => {
  const [editing, setEditing] = useState(false);
  const [localLabel, setLocalLabel] = useState(data.label || '');
  const [fields, setFields] = useState(data.fields || []);
  const [dragOver, setDragOver] = useState(false);
  const [dropError, setDropError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const media = data.media || [];
  const { deleteElements } = useReactFlow();
  const updateData = useUpdateNodeData(id);
  const nodeRef = useRef(null);

  const color = '#ba68c8';

  const commitEdit = useCallback(() => {
    updateData({ label: localLabel, fields: cleanFields(fields) });
    setEditing(false);
  }, [localLabel, fields, updateData]);

  const cancelEdit = () => {
    setEditing(false);
    setLocalLabel(data.label || '');
    setFields(data.fields || []);
  };

  // Ignored while editing so a double-click inside an input keeps unsaved text
  const startEditing = () => {
    if (editing) return;
    setLocalLabel(data.label || '');
    setFields(data.fields || []);
    setEditing(true);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') cancelEdit();
  };

  // Dismiss editing when clicking outside the node
  useClickOutside(nodeRef, editing, commitEdit);

  const handleDelete = useCallback(
    (e) => {
      e.stopPropagation();
      deleteElements({ nodes: [{ id }] });
    },
    [id, deleteElements]
  );

  const handleAddMedia = useCallback(
    (items) => updateData((d) => ({ media: [...(d.media || []), ...items] })),
    [updateData]
  );

  const handleRemoveMedia = useCallback(
    (mediaId) =>
      updateData((d) => ({ media: (d.media || []).filter((m) => m.id !== mediaId) })),
    [updateData]
  );

  // Drag files from the desktop onto the gallery
  const handleDragOver = (e) => {
    if (!hasFiles(e)) return; // let sidebar node drags reach the canvas
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false);
  };

  const handleDrop = async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    setDropError(null);
    setUploading(true);
    try {
      const { items, error } = await filesToMedia(e.dataTransfer.files);
      if (items.length) handleAddMedia(items);
      setDropError(error);
    } finally {
      setUploading(false);
    }
  };

  const COUNT_LABELS = { image: 'photo', video: 'video', audio: 'audio', file: 'file' };
  const counts = Object.entries(COUNT_LABELS)
    .map(([type, word]) => {
      const n = media.filter((m) => (m.type in COUNT_LABELS ? m.type : 'file') === type).length;
      return n ? `${n} ${word}${n > 1 && type !== 'audio' ? 's' : ''}` : null;
    })
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      ref={nodeRef}
      className={`media-node ${selected ? 'media-node--selected' : ''} ${dragOver ? 'media-node--dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
        onDoubleClick={startEditing}
      >
        <span className="osint-node-icon">🖼️</span>
        {editing ? (
          <input
            className="osint-node-input"
            value={localLabel}
            onChange={(e) => setLocalLabel(e.target.value)}
            // Save the title on blur but stay in edit mode: clicking "Attach"
            // blurs this input, and closing here removed the button mid-click.
            onBlur={() => updateData({ label: localLabel })}
            onKeyDown={handleKeyDown}
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
                {counts}
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
            <CustomFieldsEditor
              nodeId={id}
              nodeType="media"
              fields={fields}
              onChange={setFields}
              onKeyDown={handleKeyDown}
            />
            <MediaAttachments
              media={media}
              onAdd={handleAddMedia}
              onRemove={handleRemoveMedia}
            />
          </div>
        ) : (
          <>
            <CustomFieldsView fields={data.fields} />
            {media.length > 0 ? (
              <div className="media-node-gallery">
                {media.map((item) => (
                  <div key={item.id} className="media-node-gallery-item">
                    {item.type === 'image' && (
                      <img
                        src={mediaUrl(item)}
                        alt={item.name}
                        className="media-node-gallery-img"
                      />
                    )}
                    {item.type === 'video' && (
                      <video
                        src={mediaUrl(item)}
                        className="media-node-gallery-video"
                        controls
                        preload="metadata"
                      />
                    )}
                    {item.type === 'audio' && (
                      <div className="media-node-gallery-audio">
                        <audio src={mediaUrl(item)} controls preload="none" />
                        <span className="media-node-gallery-name">
                          {item.name}
                        </span>
                      </div>
                    )}
                    {item.type === 'file' && (
                      <div className="media-node-gallery-file" title={item.name}>
                        <span className="media-node-gallery-file-icon">{fileIcon(item)}</span>
                        <span className="media-node-gallery-name">{item.name}</span>
                        <span className="media-node-gallery-size">{formatSize(item.size)}</span>
                      </div>
                    )}
                    <a
                      className="media-node-gallery-download nodrag"
                      href={mediaDownloadUrl(item)}
                      download={item.name}
                      title={`Download ${item.name}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      ⬇
                    </a>
                  </div>
                ))}
              </div>
            ) : (
              <div className="media-node-empty">
                Drop files here — photos, video, audio, documents…
              </div>
            )}
            {uploading && <div className="media-node-uploading">Uploading…</div>}
            {dropError && <div className="media-attachments-error">{dropError}</div>}

          </>
        )}
      </div>

    </div>
  );
});

MediaNode.displayName = 'MediaNode';

export default MediaNode;
