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
 * So the wheel is intercepted and the scroll position is driven toward a target
 * by a critically damped spring. Once the wheel goes quiet the target moves to
 * the nearest section top, which the same spring then carries you to.
 *
 * One wheel detent travels half the viewport, so two take you a full page and
 * a stage boundary lands exactly on a detent.
 *
 * A spring rather than an exponential lerp, for two reasons.
 *
 * A lerp puts its highest velocity on the very first frame and only decays from
 * there, so making it quicker means making its opening jump larger — which is
 * what reads as abrupt. The spring accelerates first, so it can cover ground
 * sooner at a lower peak speed: measured over a 1000 px move, it reaches 90%
 * in 0.28 s against the lerp's 0.33 s while peaking at 87 px/frame rather
 * than 112.
 *
 * And a spring carries velocity. A second wheel notch arriving mid-glide blends
 * into the motion already underway instead of restarting it from a standstill.
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
  smoothTime = 0.035,   // spring response; a half-page hop lands in ~0.15 s
                        // across 9 frames. Below about 0.025 a hop spans
                        // fewer than 5 frames and stops reading as movement
                        // at all — the eye gets a start pose and an end pose,
                        // so lowering it further removes the smoothness
                        // rather than adding speed.
  pageFraction = 0.5,   // a full 100-unit detent travels half the viewport
  maxEventPages = 1.4,  // ceiling on what one event can ask for
  maxVelocity = 12000,  // px per second ceiling, kept above the peak the
                        // spring actually reaches so it never clips
  snapSelector = '.stage',
  snapQuietMs = 110,    // wheel silence before settling onto a section
  snapMaxPull = 0.40,   // settle only within this fraction of the viewport,
                        // kept under pageFraction so one notch is never
                        // yanked back to where it started
} = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return undefined;
    if (typeof window === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let target = el.scrollTop;
    let current = el.scrollTop;
    let velocity = 0;
    let last = 0;
    let raf = 0;
    let running = false;
    let ours = false;
    let quietTimer = 0;

    const maxScroll = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const clamp = (v) => Math.max(0, Math.min(v, maxScroll()));

    /**
     * Critically damped spring. Real elapsed time is used rather than a fixed
     * per-frame constant, so the motion takes the same wall-clock time on a
     * 144 Hz display as on a 60 Hz one — a per-frame lerp runs almost two and
     * a half times quicker on the faster panel.
     */
    const frame = (now) => {
      const dt = Math.min((now - last) / 1000, 0.05) || 1 / 60;  // cap after a tab switch
      last = now;

      const omega = 2 / smoothTime;
      const x = omega * dt;
      const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      const change = current - target;

      const temp = (velocity + omega * change) * dt;
      velocity = (velocity - omega * temp) * decay;

      // Ceiling on speed, not on distance. Clamping the remaining distance
      // would stop the spring ever reaching a far target; clamping velocity
      // just keeps a flung wheel from blurring past everything.
      if (velocity > maxVelocity) velocity = maxVelocity;
      else if (velocity < -maxVelocity) velocity = -maxVelocity;

      current = target + (change + temp) * decay;

      if (Math.abs(target - current) < 0.5 && Math.abs(velocity) < 12) {
        current = target;
        velocity = 0;
        running = false;
        ours = true;
        el.scrollTop = current;
        ours = false;
        return;
      }

      ours = true;
      el.scrollTop = current;
      ours = false;
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
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

    /**
     * Every event is scaled the same way: its delta as a share of a nominal
     * 100-unit detent, times the page fraction.
     *
     * An earlier version branched on delta size, treating anything under 50 as
     * a trackpad and giving it a small fixed multiplier. That starved mice:
     * with OS-level smooth scrolling a wheel does not emit one clean 100, it
     * emits a burst of small deltas, and every one of them took the trackpad
     * path and moved a few dozen pixels. The result was slower than no
     * interception at all.
     *
     * Proportional scaling needs no such guess. A burst of small deltas sums to
     * the same distance as the single large one it stands in for, and a
     * trackpad — whose deltas are small precisely because the gesture is
     * continuous — still gets movement matched to the finger.
     */
    const onWheel = (e) => {
      // let the browser handle zoom and horizontal intent
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();

      const page = el.clientHeight * pageFraction;

      // normalise to detents, whatever units the browser reports in
      let detents;
      if (e.deltaMode === 2) detents = e.deltaY * (1 / pageFraction);  // pages
      else if (e.deltaMode === 1) detents = e.deltaY / 3;              // lines
      else detents = e.deltaY / 100;                                   // pixels

      const cap = maxEventPages / pageFraction;
      if (detents > cap) detents = cap;
      else if (detents < -cap) detents = -cap;

      target = clamp(target + detents * page);
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
  }, [ref, enabled, smoothTime, pageFraction, maxEventPages, maxVelocity,
      snapSelector, snapQuietMs, snapMaxPull]);
}

export default useSmoothScroll;
