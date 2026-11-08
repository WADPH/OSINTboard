import { memo, useMemo } from 'react';
import { formatCoords, googleMapsUrl, osmUrl, tilesAround, TILE_SIZE } from '../utils/geo';

const stop = (e) => e.stopPropagation();

const ZOOM = 16;
// Covers the widest node content (~240px) × the 140px map height
const HALF_W = 130;
const HALF_H = 70;

/**
 * Static map: OSM tiles positioned around the point, marker in the middle.
 * Lighter than an embedded map and keeps the required attribution small.
 */
function StaticMap({ coords }) {
  const tiles = useMemo(() => tilesAround(coords, ZOOM, HALF_W, HALF_H), [coords]);
  return (
    <div className="map-preview-frame" aria-label={`Map at ${formatCoords(coords)}`}>
      {tiles.map((t) => (
        <img
          key={t.key}
          className="map-preview-tile"
          src={t.url}
          alt=""
          width={TILE_SIZE}
          height={TILE_SIZE}
          loading="lazy"
          draggable={false}
          style={{ left: `calc(50% + ${t.left}px)`, top: `calc(50% + ${t.top}px)` }}
        />
      ))}
      <span className="map-preview-marker" />
      <span className="map-preview-attribution">© OpenStreetMap</span>
    </div>
  );
}

/**
 * Location block for Address / Place nodes.
 * - coords → OpenStreetMap mini map + "Google Maps" / "OSM" buttons
 * - text only → just "Google Maps" (opens a search for the text)
 *
 * The map is a static preview so dragging/zooming the canvas over it still
 * works; the buttons open a full interactive map.
 */
const MapPreview = memo(({ coords, query }) => {
  if (!coords && !query) return null;
  return (
    <div className="map-preview">
      {coords && (
        <>
          <StaticMap coords={coords} />
          <div className="map-preview-coords" title="Coordinates (lat, lon)">
            📍 {formatCoords(coords)}
          </div>
        </>
      )}
      <div className="map-preview-actions">
        <a
          className="map-preview-btn nodrag"
          href={googleMapsUrl({ coords, query })}
          target="_blank"
          rel="noopener noreferrer"
          onClick={stop}
          onDoubleClick={stop}
          title={coords ? 'Open these coordinates in Google Maps' : `Search Google Maps for “${query}”`}
        >
          Open in Google Maps ↗
        </a>
        {coords && (
          <a
            className="map-preview-btn nodrag"
            href={osmUrl(coords)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={stop}
            onDoubleClick={stop}
            title="Open in OpenStreetMap"
          >
            OSM ↗
          </a>
        )}
      </div>
    </div>
  );
});

MapPreview.displayName = 'MapPreview';

export default MapPreview;
