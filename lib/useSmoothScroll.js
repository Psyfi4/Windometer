'use client';

/**
 * Eased wheel scrolling, with a settle onto section boundaries.
 *
 * Native wheel scrolling moves in hard steps: one notch, roughly forty pixels,
 * stopped. Measured against the reference site, each of its gestures glides for
 * about 1.1 s with a long ease — the signature of interpolated scrolling rather
 * than anything CSS can express. `scroll-behavior: smooth` does not do it,
 * because that only applies to programmatic scrolls; CSS scroll-snap does not
 * either, because its animation is browser-controlled and much shorter.
 *
 * So the wheel is intercepted and the scroll position is eased toward a target
 * each frame. Once the wheel goes quiet the target moves to the nearest section
 * top, which the same easing then carries you to.
 *
 * Deliberately narrow:
 *
 *   - Only `wheel` is intercepted. Touch already has native inertia, and
 *     keyboard, scrollbar dragging and scrollIntoView are left alone — those
 *     are how people navigate a page they cannot scroll by hand.
 *   - External scrolls are detected and the target re-synced, so nothing
 *     fights the rAF loop.
 *   - It disables itself under prefers-reduced-motion.
 *
 * CSS scroll-snap must be off while this runs; the two fight over the scroll
 * position. The hook adds a class the stylesheet keys off.
 */

import { useEffect } from 'react';

export function useSmoothScroll(ref, {
  enabled = true,
  ease = 0.112,        // solved so a long move settles in ~1.1 s at 60fps,
                       // matching the measured gesture length of the reference
  snapSelector = '.stage',
  snapQuietMs = 110,   // wheel silence before settling onto a section
  snapMaxPull = 0.42,  // only settle if within this fraction of the viewport
} = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    if (typeof window === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let target = el.scrollTop;
    let current = el.scrollTop;
    let raf = 0;
    let running = false;
    let ours = false;
    let quietTimer = 0;

    const maxScroll = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const clamp = (v) => Math.max(0, Math.min(v, maxScroll()));

    const frame = () => {
      const delta = target - current;
      if (Math.abs(delta) < 0.4) {
        current = target;
        ours = true;
        el.scrollTop = current;
        ours = false;
        running = false;
        return;
      }
      current += delta * ease;
      ours = true;
      el.scrollTop = current;
      ours = false;
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };

    /** Nearest section top, if one is close enough to be worth settling onto. */
    const settle = () => {
      const stages = el.querySelectorAll(snapSelector);
      if (!stages.length) return;
      const limit = el.clientHeight * snapMaxPull;
      let best = null;
      let bestDist = Infinity;
      stages.forEach((s) => {
        const top = s.offsetTop;
        const d = Math.abs(top - target);
        if (d < bestDist) { bestDist = d; best = top; }
      });
      if (best !== null && bestDist < limit) {
        target = clamp(best);
        start();
      }
    };

    const onWheel = (e) => {
      // let the browser handle zoom and horizontal intent
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      // deltaMode 1 is lines, 2 is pages
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      target = clamp(target + e.deltaY * scale);
      start();
      clearTimeout(quietTimer);
      quietTimer = setTimeout(settle, snapQuietMs);
    };

    // Anything that moves the scroller without us — keyboard, scrollbar,
    // scrollIntoView — resets the target, so the loop never drags it back.
    const onScroll = () => {
      if (ours) return;
      target = el.scrollTop;
      current = el.scrollTop;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
      clearTimeout(quietTimer);
    };
  }, [ref, enabled, ease, snapSelector, snapQuietMs, snapMaxPull]);
}

export default useSmoothScroll;
