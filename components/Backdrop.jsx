'use client';

/**
 * The backdrop.
 *
 * Cycles through one scene per station in the study, holding each for five
 * seconds and cross-fading between them.
 *
 * Scenes are drawn rather than photographed. A photograph of a specific wind
 * farm carries licensing that would have to travel with the project, and
 * drawing them means each scene can take its station's own palette — the salt
 * flats at Tuticorin read differently from the Goan headland. If you do hold
 * rights to a photograph, drop it at public/backgrounds/<slug>.jpg and it
 * replaces the drawn scene for that station with no code change.
 *
 * Everything here is decorative: aria-hidden, pointer-events none, and it stops
 * entirely under prefers-reduced-motion.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { SITE_THEMES, SCAPE_ORDER, SLIDE_MS, FADE_MS, photoPath } from '@/lib/theme';

/* ------------------------------------------------------------------ *
 * One turbine
 * ------------------------------------------------------------------ */

function Turbine({ x, base, height, period, opacity, colour, phase }) {
  const hubY = base - height;
  const towerFoot = height * 0.052;
  const towerHead = height * 0.021;
  const bladeLen = height * 0.46;
  const bladeW = height * 0.052;

  // three blades at 120°, rotating about the hub
  const blade = (i) => {
    const a = i * 120;
    return (
      <path
        key={i}
        d={`M 0 0 Q ${bladeW * 0.55} ${-bladeLen * 0.42} ${bladeW * 0.12} ${-bladeLen} Q ${-bladeW * 0.28} ${-bladeLen * 0.5} 0 0 Z`}
        transform={`rotate(${a})`}
        fill={colour}
      />
    );
  };

  return (
    <g opacity={opacity}>
      <path
        d={`M ${x - towerFoot / 2} ${base} L ${x - towerHead / 2} ${hubY} L ${x + towerHead / 2} ${hubY} L ${x + towerFoot / 2} ${base} Z`}
        fill={colour}
      />
      <g
        style={{
          transformBox: 'view-box',
          transformOrigin: `${x}px ${hubY}px`,
          animation: `bladeSpin ${period}s linear infinite`,
          animationDelay: `${-phase}s`,
        }}
      >
        <g transform={`translate(${x} ${hubY})`}>
          {[0, 1, 2].map(blade)}
          <circle r={height * 0.026} fill={colour} />
        </g>
      </g>
    </g>
  );
}

/* ------------------------------------------------------------------ *
 * One station's scene
 * ------------------------------------------------------------------ */

function WindScape({ palette, seed, id }) {
  const W = 1600, H = 900;
  const horizon = H * 0.72;

  // deterministic per-station layout, so a station always looks the same
  const rng = useMemo(() => {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }, [seed]);

  const farm = useMemo(() => {
    const out = [];
    for (let i = 0; i < palette.turbines; i++) {
      const depth = rng();                       // 0 near, 1 far
      const height = 300 - depth * 205;
      out.push({
        x: 90 + rng() * (W - 180),
        base: horizon + (1 - depth) * H * 0.11,
        height,
        period: 7 + depth * 9 + rng() * 3,       // distant ones look slower
        opacity: 0.9 - depth * 0.45,
        phase: rng() * 12,
      });
    }
    return out.sort((a, b) => a.height - b.height);
  }, [palette.turbines, rng, horizon]);

  const dunes = useMemo(() => {
    const bands = [];
    for (let b = 0; b < 3; b++) {
      const y = horizon + b * H * 0.045;
      let d = `M 0 ${y}`;
      for (let x = 0; x <= W; x += 160) {
        d += ` Q ${x + 80} ${y - 14 - rng() * 26} ${x + 160} ${y}`;
      }
      bands.push(`${d} L ${W} ${H} L 0 ${H} Z`);
    }
    return bands;
  }, [rng, horizon]);

  const skyId = `sky-${id}`, seaId = `sea-${id}`, glowId = `glow-${id}`;
  const isWater = Boolean(palette.water);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice"
      width="100%" height="100%" aria-hidden="true">
      <defs>
        <linearGradient id={skyId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.skyTop} />
          <stop offset="55%" stopColor={palette.skyMid} />
          <stop offset="100%" stopColor={palette.skyLow} />
        </linearGradient>
        <linearGradient id={seaId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={palette.water ?? palette.land} />
          <stop offset="100%" stopColor={palette.land} />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={palette.sun} stopOpacity="0.55" />
          <stop offset="100%" stopColor={palette.sun} stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width={W} height={H} fill={`url(#${skyId})`} />
      <circle cx={W * 0.68} cy={horizon - 30} r={230} fill={`url(#${glowId})`} />
      <circle cx={W * 0.68} cy={horizon - 30} r={26} fill={palette.sun} opacity="0.5" />

      {/* haze bands just above the horizon */}
      {[0, 1, 2].map((i) => (
        <rect key={i} x="0" y={horizon - 46 + i * 15} width={W} height="5"
          fill={palette.sun} opacity={0.05 + i * 0.02} />
      ))}

      {isWater
        ? <rect x="0" y={horizon} width={W} height={H - horizon} fill={`url(#${seaId})`} />
        : dunes.map((d, i) => (
          <path key={i} d={d} fill={palette.land} opacity={0.55 + i * 0.18} />
        ))}

      {farm.map((t, i) => (
        <Turbine key={i} {...t} colour={palette.land} />
      ))}

      {isWater && (
        <rect x="0" y={horizon} width={W} height={H - horizon}
          fill={palette.sun} opacity="0.045" />
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * The cycling layer
 * ------------------------------------------------------------------ */

export default function Backdrop({ enabled = true, pinned = null }) {
  const [index, setIndex] = useState(0);
  const [photos, setPhotos] = useState({});
  const [reduced, setReduced] = useState(false);

  // honour the platform's reduced-motion preference
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Photographs are opt-in through a manifest, so an install without any
  // costs one failed request rather than one per station.
  useEffect(() => {
    let live = true;
    fetch('/backgrounds/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (!live || !list) return;
        const slugs = Array.isArray(list) ? list : Object.keys(list);
        const found = {};
        slugs.forEach((slug) => { found[slug] = photoPath(slug); });
        setPhotos(found);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  // a pinned station holds still
  useEffect(() => {
    if (!pinned) return;
    const at = SCAPE_ORDER.indexOf(pinned);
    if (at >= 0) setIndex(at);
  }, [pinned]);

  // otherwise advance every five seconds
  useEffect(() => {
    if (!enabled || reduced || pinned) return undefined;
    const id = setInterval(
      () => setIndex((i) => (i + 1) % SCAPE_ORDER.length),
      SLIDE_MS
    );
    return () => clearInterval(id);
  }, [enabled, reduced, pinned]);

  if (!enabled) return null;

  // Every scene stays mounted under a stable key, and only the active one is
  // opaque. Swapping the contents of a single slide would replace the image
  // outright with no crossfade, which is what an earlier version did.
  return (
    <div className="backdrop" aria-hidden="true">
      {SCAPE_ORDER.map((name, i) => {
        const theme = SITE_THEMES[name];
        const photo = photos[theme.slug];
        return (
          <div key={name} className={`backdrop-slide${i === index ? ' on' : ''}`}>
            {photo
              ? <div className="backdrop-photo" style={{ backgroundImage: `url(${photo})` }} />
              : <WindScape palette={theme.scape} seed={i * 7919 + 13} id={theme.slug} />}
          </div>
        );
      })}
      <div className="backdrop-scrim" />
    </div>
  );
}
