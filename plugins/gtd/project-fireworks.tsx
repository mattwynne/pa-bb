/*!
 * canvas-confetti is distributed under the ISC license.
 * Copyright (c) 2020, Kiril Vatev
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { useEffect, useRef } from 'react';
import confetti from 'canvas-confetti';

const completions = new EventTarget();
const graphemes = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
const emojiPattern = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F|[#*0-9]\uFE0F?\u20E3/u;

function leadingEmoji(name?: string) {
  if (!name || !graphemes) return undefined;
  const first = graphemes.segment(name.trimStart())[Symbol.iterator]().next().value?.segment;
  return first && emojiPattern.test(first) ? first : undefined;
}

export function celebrateProject(projectTitle: string, linkedAreaName?: string, enclosingAreaTitle?: string) {
  const emoji = leadingEmoji(projectTitle) ?? leadingEmoji(linkedAreaName) ?? leadingEmoji(enclosingAreaTitle);
  completions.dispatchEvent(new CustomEvent('project-completed', { detail: emoji }));
}

const finale = [
  { delay: 0, x: 0.23, y: 0.34, color: '#ffb454', highlight: '#ffebaa' },
  { delay: 180, x: 0.74, y: 0.41, color: '#61d7fa', highlight: '#c3f6ff' },
  { delay: 350, x: 0.50, y: 0.26, color: '#ff6ba9', highlight: '#ffd4ef' },
  { delay: 570, x: 0.82, y: 0.28, color: '#b18aff', highlight: '#eadbff' },
  { delay: 670, x: 0.34, y: 0.48, color: '#65efac', highlight: '#ccffe6' },
];
const emojiScalar = 1.35;

export function ProjectFireworks() {
  const layer = useRef<HTMLDivElement>(null);
  const launches = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const overlay = layer.current;
    const sky = launches.current;
    const surface = canvas.current;
    if (!overlay || !sky || !surface || typeof window.matchMedia !== 'function') return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fire = confetti.create(surface, { resize: true, useWorker: false, disableForReducedMotion: true });
    let timers: ReturnType<typeof setTimeout>[] = [];
    let show = 0;

    const clear = () => {
      show++;
      for (const timer of timers) clearTimeout(timer);
      timers = [];
      for (const animation of sky.getAnimations({ subtree: true })) animation.cancel();
      sky.replaceChildren();
      fire.reset();
      overlay.hidden = true;
    };

    const burst = ({ x, y, color, highlight }: typeof finale[number], emojiShape?: confetti.Shape) => {
      const origin = { x, y };
      fire({
        origin, spread: 360, startVelocity: overlay.clientWidth < 450 ? 20 : 26,
        particleCount: 58, ticks: 102, decay: 0.92, gravity: 0.50,
        scalar: 0.85, shapes: ['circle'], colors: [color, color, highlight],
      });
      const sparks = fire({
        origin, spread: 360, startVelocity: 13, particleCount: 18,
        ticks: 60, decay: 0.90, gravity: 0.38, scalar: 0.55,
        shapes: ['circle'], colors: ['#ffffff', highlight],
      });
      return emojiShape ? fire({
        origin, spread: 360, startVelocity: 16, particleCount: 7,
        ticks: 112, decay: 0.91, gravity: 0.39, scalar: emojiScalar, shapes: [emojiShape],
      }) : sparks;
    };

    const start = (event: Event) => {
      clear();
      if (motion.matches) return;
      const emoji = (event as CustomEvent<string | undefined>).detail;
      const emojiShape = emoji && typeof OffscreenCanvas !== 'undefined' &&
        typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function'
        ? confetti.shapeFromText({ text: emoji, scalar: emojiScalar }) : undefined;
      const current = show;
      let remaining = finale.length;
      overlay.hidden = false;
      timers = finale.map(firework => setTimeout(() => {
        const flare = document.createElement('div');
        flare.className = 'gtd-fireworks-flare';
        flare.style.left = `${firework.x * 100}%`;
        flare.style.setProperty('--gtd-firework-color', firework.color);
        sky.append(flare);
        const rise = (1 - firework.y) * sky.clientHeight - flare.offsetHeight;
        const animation = flare.animate([
          { transform: 'translateY(100%)', opacity: 0 },
          { offset: 0.2, opacity: 1 },
          { transform: `translateY(${-rise}px)`, opacity: 1 },
        ], { duration: 360, easing: 'cubic-bezier(0.3, 0.55, 0.5, 1)', fill: 'forwards' });
        animation.onfinish = () => {
          flare.remove();
          if (show !== current) return;
          const finished = burst(firework, emojiShape);
          if (--remaining === 0) void Promise.resolve(finished).then(() => { if (show === current) clear(); });
        };
      }, firework.delay));
    };

    const motionChanged = () => { if (motion.matches) clear(); };
    completions.addEventListener('project-completed', start);
    motion.addEventListener('change', motionChanged);
    return () => {
      completions.removeEventListener('project-completed', start);
      motion.removeEventListener('change', motionChanged);
      clear();
    };
  }, []);

  return <div className="gtd-fireworks" aria-hidden="true" ref={layer} hidden>
    <div className="gtd-fireworks-launches" ref={launches} />
    <canvas ref={canvas} />
  </div>;
}
