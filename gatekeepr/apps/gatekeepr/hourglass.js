/* The sand timer both Gatekeepr surfaces draw. apps/gatekeepr/hourglass.js and apps/gatekeepr-widget/hourglass.js
 * are the same file (tests/gatekeepr checks), since an app can't load another app's assets.
 *
 * The top bulb holds the time left. Its sand level is solved by area, not height, so a bulb that narrows toward
 * the neck still shows the true fraction, and the bottom bulb mirrors the top, so the fallen sand fills as much
 * as the top has lost. A sliver stays while any time is left: the last half hour of a 24-hour session is
 * otherwise 2% of the sand, and expiring soon would look like expired.
 *
 * Colours are theme tokens only. The page sets --tone (the sand); the frame is --text-secondary, lit and shaded
 * toward whichever of --bg-primary and --text-primary is lighter or darker in the current mode. The stream falls
 * only while the session runs, and holds still under data-motion="reduce".
 *
 *   const timer = Hourglass.mount(element);
 *   timer.draw(fraction, flowing);   // fraction of the session left, 0..1 */
window.Hourglass = (() => {
  const TOP = 22, NECK = 85, BOT = 148, MIN_SHOWN = 0.03;
  const GLASS = `M32 ${TOP} C32 56, 56.5 70, 56.5 ${NECK} C56.5 100, 32 114, 32 ${BOT} `
    + `L88 ${BOT} C88 114, 63.5 100, 63.5 ${NECK} C63.5 70, 88 56, 88 ${TOP} Z`;
  const bez = (a, b, c, d, t) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
  // [y, half-width] down the top bulb's right edge: (88,22) to (63.5,85), controls (88,56) and (63.5,70).
  const N = 240;
  const edge = Array.from({ length: N + 1 }, (_, i) => [bez(TOP, 56, 70, NECK, i / N), bez(28, 28, 3.5, 3.5, i / N)]);
  // below[i]: the sand area between edge[i] and the neck.
  const below = new Array(N + 1).fill(0);
  for (let i = N - 1; i >= 0; i--) below[i] = below[i + 1] + (edge[i][1] + edge[i + 1][1]) * (edge[i + 1][0] - edge[i][0]);

  function level(fraction) {      // the y of the sand's surface in the top bulb
    const want = fraction * below[0];
    for (let i = N - 1; i >= 0; i--) {
      if (below[i] < want) continue;
      const k = (want - below[i + 1]) / ((below[i] - below[i + 1]) || 1);
      return edge[i + 1][0] - k * (edge[i + 1][0] - edge[i][0]);
    }
    return TOP;
  }

  const style = document.createElement('style');
  style.textContent = `
    .hourglass { --hg-tone: var(--tone, var(--accent)); --hg-frame: var(--text-secondary);
      --hg-lift: var(--bg-primary); --hg-sink: var(--text-primary); display: block; height: auto; overflow: visible; }
    html[data-theme-mode="dark"] .hourglass { --hg-lift: var(--text-primary); --hg-sink: var(--bg-primary); }
    .hourglass .hg-shadow { fill: color-mix(in srgb, var(--text-primary) 12%, transparent); }
    .hourglass .hg-plate { fill: var(--hg-frame); }
    .hourglass .hg-bevel { fill: color-mix(in srgb, var(--hg-frame) 55%, var(--hg-lift)); }
    .hourglass .hg-under { fill: color-mix(in srgb, var(--hg-frame) 70%, var(--hg-sink)); }
    .hourglass .hg-post { fill: color-mix(in srgb, var(--hg-frame) 80%, var(--hg-lift)); }
    .hourglass .hg-post-shine { fill: color-mix(in srgb, var(--hg-frame) 45%, var(--hg-lift)); }
    .hourglass .hg-bead { fill: var(--hg-frame); }
    .hourglass .hg-collar { fill: color-mix(in srgb, var(--hg-frame) 75%, var(--hg-sink)); }
    .hourglass .hg-glass { fill: color-mix(in srgb, var(--hg-tone) 6%, transparent); stroke: var(--text-muted); stroke-width: 1.6; }
    .hourglass .hg-shine { fill: none; stroke: var(--hg-lift); stroke-linecap: round; opacity: 0.75; }
    html[data-theme-mode="dark"] .hourglass .hg-shine { opacity: 0.3; }
    .hourglass .hg-sand-lit { stop-color: color-mix(in srgb, var(--hg-tone) 70%, var(--hg-lift)); }
    .hourglass .hg-sand-deep { stop-color: color-mix(in srgb, var(--hg-tone) 88%, var(--hg-sink)); }
    .hourglass .hg-stream { stroke: var(--hg-tone); stroke-linecap: round; }
    .hourglass .hg-stream-core { stroke-width: 0.8; opacity: 0.45; }
    .hourglass .hg-grains { stroke-width: 1.8; stroke-dasharray: 0.1 3.4; animation: hg-fall 0.5s linear infinite; }
    @keyframes hg-fall { to { stroke-dashoffset: -3.5; } }
    html[data-motion="reduce"] .hourglass .hg-grains { animation: none; }`;
  document.head.appendChild(style);

  // A turned post: a bar with a bead where it meets each plate and one at the waist.
  const post = (x) => `<rect class="hg-post" x="${x}" y="18" width="6" height="134"/>
    <rect class="hg-post-shine" x="${x + 1}" y="18" width="1.6" height="134"/>
    <ellipse class="hg-bead" cx="${x + 3}" cy="22" rx="4.6" ry="2.4"/>
    <ellipse class="hg-bead" cx="${x + 3}" cy="${NECK}" rx="4.4" ry="3"/>
    <ellipse class="hg-bead" cx="${x + 3}" cy="148" rx="4.6" ry="2.4"/>`;
  // A plate with its lit top edge and shaded underside, and the two knobs (or feet) on its outer face.
  const plate = (y, outward) => `<rect class="hg-bead" x="13" y="${outward < 0 ? y - 4 : y + 10}" width="12" height="4.5" rx="2"/>
    <rect class="hg-bead" x="95" y="${outward < 0 ? y - 4 : y + 10}" width="12" height="4.5" rx="2"/>
    <rect class="hg-plate" x="8" y="${y}" width="104" height="10" rx="3"/>
    <rect class="hg-bevel" x="10" y="${y + 1}" width="100" height="2.4" rx="1.2"/>
    <rect class="hg-under" x="10" y="${y + 7.4}" width="100" height="1.8" rx="0.9"/>`;

  let ids = 0;
  function mount(el) {
    const id = `hg-${++ids}`;
    el.innerHTML = `<svg class="hourglass" viewBox="0 0 120 172" aria-hidden="true">
      <defs>
        <clipPath id="${id}-clip"><path d="${GLASS}"/></clipPath>
        <linearGradient id="${id}-sand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="hg-sand-lit"/><stop offset="1" class="hg-sand-deep"/>
        </linearGradient>
      </defs>
      <ellipse class="hg-shadow" cx="60" cy="168.5" rx="52" ry="3"/>
      ${post(13)}${post(101)}
      <path class="hg-glass" d="${GLASS}"/>
      <g clip-path="url(#${id}-clip)" fill="url(#${id}-sand)">
        <path class="hg-top"/><path class="hg-bottom"/>
      </g>
      <g class="hg-stream">
        <line class="hg-stream-core" x1="60" y1="${NECK - 1}" x2="60"/>
        <line class="hg-grains" x1="60" y1="${NECK - 1}" x2="60"/>
      </g>
      <path class="hg-shine" stroke-width="2.6" d="M38.5 30 C38.5 46, 45 58, 53 67.5"/>
      <path class="hg-shine" stroke-width="1.4" d="M82 30 C82 35, 81.4 39, 80 43"/>
      <path class="hg-shine" stroke-width="2.6" d="M53 102.5 C45 112, 38.5 124, 38.5 140"/>
      <path class="hg-shine" stroke-width="1.4" d="M80 127 C81.4 131, 82 135, 82 140"/>
      <rect class="hg-collar" x="30" y="18" width="60" height="4" rx="1"/>
      <rect class="hg-collar" x="30" y="148" width="60" height="4" rx="1"/>
      ${plate(8, -1)}${plate(152, 1)}
    </svg>`;
    const top = el.querySelector('.hg-top'), bottom = el.querySelector('.hg-bottom');
    const stream = el.querySelector('.hg-stream'), lines = stream.querySelectorAll('line');
    return {
      draw(fraction, flowing) {
        const f = Math.max(0, Math.min(1, Number(fraction) || 0));
        const surface = level(f > 0 ? Math.max(f, MIN_SHOWN) : 0);
        // The top surface sags toward the neck, where the sand drains from.
        const dip = Math.min(4, (NECK - surface) * 0.35);
        top.setAttribute('d', f > 0 ? `M0 ${surface} Q60 ${surface + 2 * dip} 120 ${surface} L120 ${NECK + 1} L0 ${NECK + 1} Z` : '');
        // The fallen sand heaps into a cone under the stream.
        const fill = surface - TOP, pile = BOT - fill, rise = Math.min(5, fill / 2);
        bottom.setAttribute('d', fill > 0.2
          ? `M0 ${BOT + 1} L0 ${pile + rise} Q60 ${pile - 3 * rise} 120 ${pile + rise} L120 ${BOT + 1} Z` : '');
        for (const line of lines) line.setAttribute('y2', pile - rise);
        stream.style.display = flowing && f > 0 ? '' : 'none';
      },
    };
  }
  return { mount };
})();
