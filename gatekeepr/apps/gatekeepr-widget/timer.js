/* The countdown timer both Gatekeepr surfaces draw. apps/gatekeepr/timer.js and apps/gatekeepr-widget/timer.js
 * are the same file (tests/gatekeepr checks), since an app can't load another app's assets.
 *
 * A visual desk timer for one whole session: a full turn of the dial is the session length, and a solid disc from
 * 12 o'clock round to its edge is the time left, so the disc shrinks back to 12 as the session runs out. The
 * setting knob's ridge follows the disc's edge. Hour ticks and the quarter labels come from the session length
 * (6h, 12h, 18h for a 24-hour session). A sliver of disc stays while any time is left: the last half hour of a
 * 24-hour session is otherwise 2% of the dial, and expiring soon would look like expired.
 *
 * Colours are theme tokens only. The page sets --tone (the disc); the case is --text-secondary, lit and shaded
 * toward whichever of --bg-primary and --text-primary is lighter or darker in the current mode.
 *
 *   const timer = ExpiryTimer.mount(element);
 *   timer.draw(fraction, sessionLengthSeconds);   // fraction of the session left, 0..1 */
window.ExpiryTimer = (() => {
  const CX = 70, CY = 70, FACE = 52, DISC = 43, MIN_SHOWN = 0.02, DEFAULT_LENGTH = 86399;
  const round = (n) => Math.round(n * 100) / 100;
  const at = (deg, r) => [round(CX + r * Math.sin(deg * Math.PI / 180)), round(CY - r * Math.cos(deg * Math.PI / 180))];

  const style = document.createElement('style');
  style.textContent = `
    .expiry-timer { --tm-tone: var(--tone, var(--accent)); --tm-frame: var(--text-secondary);
      --tm-lift: var(--bg-primary); --tm-sink: var(--text-primary); --tm-face: var(--bg-primary);
      display: block; height: auto; overflow: visible; }
    html[data-theme-mode="dark"] .expiry-timer { --tm-lift: var(--text-primary); --tm-sink: var(--bg-primary);
      --tm-face: color-mix(in srgb, var(--bg-primary) 90%, var(--text-primary)); }
    .expiry-timer .tm-shadow { fill: color-mix(in srgb, var(--text-primary) 12%, transparent); }
    .expiry-timer .tm-metal { fill: var(--tm-frame); }
    .expiry-timer .tm-bevel { fill: color-mix(in srgb, var(--tm-frame) 50%, var(--tm-lift)); }
    .expiry-timer .tm-under { fill: color-mix(in srgb, var(--tm-frame) 70%, var(--tm-sink)); }
    .expiry-timer .tm-wall { fill: color-mix(in srgb, var(--tm-frame) 72%, var(--tm-sink)); }
    .expiry-timer .tm-lip { fill: none; stroke: color-mix(in srgb, var(--tm-frame) 55%, var(--tm-lift)); stroke-width: 1.2; }
    .expiry-timer .tm-face { fill: color-mix(in srgb, var(--tm-tone) 5%, var(--tm-face)); }
    .expiry-timer .tm-disc { fill: var(--tm-tone); }
    .expiry-timer .tm-disc-edge { fill: none; stroke: color-mix(in srgb, var(--tm-tone) 75%, var(--tm-sink)); stroke-width: 1.2; stroke-linejoin: round; }
    .expiry-timer .tm-tick { stroke: var(--text-muted); stroke-width: 1; stroke-linecap: round; }
    .expiry-timer .tm-tick-major { stroke: var(--text-secondary); stroke-width: 2.2; }
    .expiry-timer .tm-num { fill: var(--text-muted); font-family: var(--font-ui); font-size: 9.5px; font-weight: 600;
      text-anchor: middle; dominant-baseline: central; }
    .expiry-timer .tm-knob-ring { fill: color-mix(in srgb, var(--tm-frame) 72%, var(--tm-sink)); }
    .expiry-timer .tm-glare { fill: none; stroke: var(--tm-lift); stroke-width: 3.4; stroke-linecap: round; opacity: 0.7; }
    html[data-theme-mode="dark"] .expiry-timer .tm-glare { opacity: 0.16; }`;
  document.head.appendChild(style);

  // Hour ticks round the dial (a quarter tick longer), and quarter labels when they land on whole hours.
  function dial(length) {
    const hours = Math.round(length / 3600);
    const marks = hours >= 4 && hours <= 48 ? hours : 4;
    let out = '';
    for (let i = 0; i < marks; i++) {
      const quarter = (i * 4) % marks === 0;
      const [x1, y1] = at(i * 360 / marks, FACE - 1.5), [x2, y2] = at(i * 360 / marks, FACE - (quarter ? 8 : 4.5));
      out += `<line class="tm-tick${quarter ? ' tm-tick-major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    if (hours % 4 === 0) {
      [1, 2, 3].forEach((q) => {
        const [x, y] = at(q * 90, FACE - 16.5);
        out += `<text class="tm-num" x="${x}" y="${y}">${hours * q / 4}h</text>`;
      });
    }
    return out;
  }

  function disc(deg) {   // clockwise from 12 o'clock to deg
    if (deg >= 359.95) return `M${CX} ${CY - DISC} A${DISC} ${DISC} 0 1 1 ${CX - 0.01} ${CY - DISC} Z`;
    const [x, y] = at(deg, DISC);
    return `M${CX} ${CY} L${CX} ${CY - DISC} A${DISC} ${DISC} 0 ${deg > 180 ? 1 : 0} 1 ${x} ${y} Z`;
  }

  function mount(el) {
    const [g1x, g1y] = at(-68, FACE - 6), [g2x, g2y] = at(-28, FACE - 6);
    el.innerHTML = `<svg class="expiry-timer" viewBox="0 0 140 150" aria-hidden="true">
      <ellipse class="tm-shadow" cx="${CX}" cy="144" rx="52" ry="3"/>
      <rect class="tm-metal" x="22" y="130" width="16" height="10" rx="3"/>
      <rect class="tm-metal" x="102" y="130" width="16" height="10" rx="3"/>
      <rect class="tm-metal" x="8" y="8" width="124" height="126" rx="24"/>
      <rect class="tm-bevel" x="30" y="10.4" width="80" height="2.8" rx="1.4"/>
      <rect class="tm-under" x="30" y="129.4" width="80" height="2" rx="1"/>
      <rect class="tm-wall" x="14" y="14" width="112" height="112" rx="19"/>
      <circle class="tm-lip" cx="${CX}" cy="${CY}" r="${FACE + 1.6}"/>
      <circle class="tm-face" cx="${CX}" cy="${CY}" r="${FACE}"/>
      <path class="tm-disc"/><path class="tm-disc-edge"/>
      <g class="tm-dial"></g>
      <circle class="tm-knob-ring" cx="${CX}" cy="${CY}" r="9.5"/>
      <circle class="tm-metal" cx="${CX}" cy="${CY}" r="8"/>
      <g class="tm-knob"><rect class="tm-bevel" x="${CX - 1.3}" y="${CY - 6.5}" width="2.6" height="13" rx="1.3"/></g>
      <path class="tm-glare" d="M${g1x} ${g1y} A${FACE - 6} ${FACE - 6} 0 0 1 ${g2x} ${g2y}"/>
    </svg>`;
    const q = (sel) => el.querySelector(sel);
    const fill = q('.tm-disc'), edge = q('.tm-disc-edge'), knob = q('.tm-knob'), face = q('.tm-dial');
    let drawnLength = null;
    return {
      draw(fraction, sessionLength) {
        const length = Number(sessionLength) > 0 ? Number(sessionLength) : DEFAULT_LENGTH;
        if (length !== drawnLength) { face.innerHTML = dial(length); drawnLength = length; }
        const f = Math.max(0, Math.min(1, Number(fraction) || 0));
        const deg = (f > 0 ? Math.max(f, MIN_SHOWN) : 0) * 360;
        const d = deg > 0 ? disc(deg) : '';
        fill.setAttribute('d', d);
        edge.setAttribute('d', d);
        knob.setAttribute('transform', `rotate(${round(deg)} ${CX} ${CY})`);
      },
    };
  }
  return { mount };
})();
