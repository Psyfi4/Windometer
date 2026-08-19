'use client';

/**
 * The station map.
 *
 * The OpenStreetMap embed reads its viewport once, when its document loads,
 * and never revisits it. That is fine in an ordinary page and wrong here: the
 * stages carry content-visibility: auto, so a stage that is off screen has its
 * contents skipped, and an iframe inside it can load against a container that
 * has not been laid out. The embed then renders a small map and keeps it —
 * tiles in one corner of a wide empty frame — because scrolling to the stage
 * resizes the iframe element without telling the document inside it.
 *
 * Two things fix it:
 *
 *   - Do not render the iframe at all until its container is on screen and has
 *     a real width. Nothing loads against a collapsed box.
 *   - Key the iframe on that width, rounded, so a genuine resize remounts it
 *     and the embed lays out again. Rounding keeps a window drag from
 *     remounting on every pixel.
 */

import { useEffect, useRef, useState } from 'react';

export default function StationMap({ lat, lon, delta = 1.4, height = 340 }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [onScreen, setOnScreen] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;

    const readWidth = () => {
      const w = el.clientWidth;
      // to the nearest 40px: enough to catch a real layout change, coarse
      // enough that dragging a window edge does not reload the map repeatedly
      if (w > 0) setWidth(Math.round(w / 40) * 40);
    };
    readWidth();

    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(readWidth)
      : null;
    if (ro) ro.observe(el);

    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setOnScreen(true);
            readWidth();
          }
        },
        // a little ahead of the viewport, so it is ready by the time it arrives
        { rootMargin: '300px 0px' },
      )
      : null;
    if (io) io.observe(el);

    // no IntersectionObserver: fall back to rendering immediately
    if (!io) setOnScreen(true);

    window.addEventListener('resize', readWidth);
    return () => {
      window.removeEventListener('resize', readWidth);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
    };
  }, []);

  const bbox = [
    (lon - delta).toFixed(4),
    (lat - delta * 0.7).toFixed(4),
    (lon + delta).toFixed(4),
    (lat + delta * 0.7).toFixed(4),
  ].join(',');
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}`
    + `&layer=mapnik&marker=${lat},${lon}`;

  return (
    <div className="mapframe" ref={wrapRef} style={{ height }}>
      {onScreen && width > 0 && (
        <iframe
          // remounts when the container width genuinely changes, which is the
          // only way to make the embedded document lay out again
          key={`${width}-${lat}-${lon}`}
          title="Station location"
          src={src}
        />
      )}
    </div>
  );
}
