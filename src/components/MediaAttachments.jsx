import { memo, useRef, useState } from 'react';
import MediaLightbox from './MediaLightbox';
import { filesToMedia, mediaUrl, mediaDownloadUrl, fileIcon, formatSize } from '../utils/mediaFiles';

const MediaAttachments = memo(({ media = [], onAdd, onRemove }) => {
  const fileInputRef = useRef(null);
  const [error, setError] = useState(null);
  const [lightboxItem, setLightboxItem] = useState(null);
  const [uploading, setUploading] = useState(false);

  const handlePick = () => {
    fileInputRef.current?.click();
  };

  // onAdd receives all picked files at once (one state update)
  const handleFiles = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = e.target;
    setError(null);
    setUploading(true);
    try {
      const { items, error: problem } = await filesToMedia(input.files);
      if (items.length) onAdd(items);
      if (problem) setError(problem);
    } finally {
      setUploading(false);
      input.value = '';
    }
  };

  const handleRemove = (mediaId) => {
    onRemove(mediaId);
  };

  return (
    <div className="media-attachments">
      {media.length > 0 && (
        <div className="media-attachments-grid">
          {media.map((item) => (
            <div key={item.id} className="media-attachment-item">
              {item.type === 'image' && (
                <div
                  className="media-attachment-preview"
                  onClick={() => setLightboxItem(item)}
                >
                  <img
                    src={mediaUrl(item)}
                    alt={item.name}
                    className="media-attachment-thumb"
                  />
                </div>
              )}
              {item.type === 'video' && (
                <div className="media-attachment-preview">
                  <video
                    src={mediaUrl(item)}
                    className="media-attachment-thumb"
                    controls
                    preload="metadata"
                  />
                </div>
              )}
              {item.type === 'audio' && (
                <div className="media-attachment-audio">
                  <audio src={mediaUrl(item)} controls preload="none" />
                </div>
              )}
              {item.type === 'file' && (
                <div
                  className="media-attachment-file"
                  onClick={() => setLightboxItem(item)}
                  title={item.name}
                >
                  <span className="media-attachment-file-icon">{fileIcon(item)}</span>
                  <span className="media-attachment-file-size">{formatSize(item.size)}</span>
                </div>
              )}
              <a
                className="media-attachment-download"
                href={mediaDownloadUrl(item)}
                download={item.name}
                title={`Download ${item.name}`}
              >
                ⬇
              </a>
              <button
                className="media-attachment-remove"
                title="Remove"
                onClick={() => handleRemove(item.id)}
              >
                ✕
              </button>
              <span className="media-attachment-name">{item.name}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="media-attachments-error">{error}</div>}

      <button
        className="media-attachments-add-btn"
        onClick={handlePick}
        disabled={uploading}
      >
        {uploading
          ? 'Uploading…'
          : `+ ${media.length > 0 ? 'Add files' : 'Attach files'}`}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="media-attachments-hidden-input"
        onChange={handleFiles}
      />

      {lightboxItem && (
        <MediaLightbox
          item={lightboxItem}
          onClose={() => setLightboxItem(null)}
        />
      )}
    </div>
  );
});

MediaAttachments.displayName = 'MediaAttachments';

export default MediaAttachments;
