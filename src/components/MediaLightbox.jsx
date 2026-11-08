import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { mediaUrl, mediaDownloadUrl, fileIcon, formatSize } from '../utils/mediaFiles';

export default function MediaLightbox({ item, onClose }) {
  // Close on Escape
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Close on overlay click
  const handleOverlayClick = useCallback(
    (e) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  if (!item) return null;

  // Portal to <body>: inside a React Flow node the `transform` on the node
  // makes `position: fixed` relative to the node, so the overlay rendered
  // squashed inside the node instead of covering the screen.
  return createPortal(
    <div className="lightbox-overlay" onClick={handleOverlayClick}>
      <div className="lightbox-content">
        <button className="lightbox-close" onClick={onClose}>
          ✕
        </button>

        {item.type === 'image' && (
          <img
            src={mediaUrl(item)}
            alt={item.name}
            className="lightbox-img"
          />
        )}

        {item.type === 'video' && (
          <video
            src={mediaUrl(item)}
            className="lightbox-video"
            controls
            autoPlay
          />
        )}

        {item.type === 'audio' && (
          <div className="lightbox-audio">
            <div className="lightbox-audio-icon">🎵</div>
            <div className="lightbox-audio-name">{item.name}</div>
            <audio src={mediaUrl(item)} controls autoPlay />
          </div>
        )}

        {item.type === 'file' && (
          <div className="lightbox-file">
            <div className="lightbox-file-icon">{fileIcon(item)}</div>
          </div>
        )}

        <div className="lightbox-name">
          {item.name}
          {item.size ? <span className="lightbox-size"> · {formatSize(item.size)}</span> : null}
        </div>
        <a
          className="lightbox-download"
          href={mediaDownloadUrl(item)}
          download={item.name}
        >
          ⬇ Download
        </a>
      </div>
    </div>,
    document.body
  );
}
