/* The countdown timer both Gatekeepr surfaces draw. apps/gatekeepr/timer.js and apps/gatekeepr-widget/timer.js
 * are the same file (tests/gatekeepr checks), since an app can't load another app's assets.
 *
 * A stopwatch dial for one whole session: a full turn is the session length, and the tinted wedge from 12 o'clock
 * round to the hand is the time left, so the hand sweeps back to 12 as the session runs out. The quarter labels
 * come from the session length (6h, 12h, 18h for a 24-hour session; the crown marks 12 o'clock). A sliver of wedge stays while any time is
 * left: the last half hour of a 24-hour session is otherwise 2% of the dial, and expiring soon would look like
 * expired. While the session runs, a thin second hand ticks round, and it's hidden under data-motion="reduce".
 *
 * Colours are theme tokens only. The page sets --tone (the wedge and the hand); the case is --text-secondary, lit
 * and shaded toward whichever of --bg-primary and --text-primary is lighter or darker in the current mode.
 *
 *   const timer = ExpiryTimer.mount(element);
 *   timer.draw(fraction, running, sessionLengthSeconds);   // fraction of the session left, 0..1 */
window.ExpiryTimer = (() => {
  const CX = 70, CY = 92, FACE = 50, MIN_SHOWN = 0.02, DEFAULT_LENGTH = 86399;
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
    .expiry-timer .tm-stem { fill: color-mix(in srgb, var(--tm-frame) 78%, var(--tm-lift)); }
    .expiry-timer .tm-bevel { fill: color-mix(in srgb, var(--tm-frame) 50%, var(--tm-lift)); }
    .expiry-timer .tm-rim { fill: none; stroke: color-mix(in srgb, var(--tm-frame) 50%, var(--tm-lift)); stroke-width: 1.4; }
    .expiry-timer .tm-wall { fill: color-mix(in srgb, var(--tm-frame) 72%, var(--tm-sink)); }
    .expiry-timer .tm-face { fill: color-mix(in srgb, var(--tm-tone) 5%, var(--tm-face)); }
    .expiry-timer .tm-wedge { fill: color-mix(in srgb, var(--tm-tone) 26%, transparent); }
    .expiry-timer .tm-edge { fill: none; stroke: var(--tm-tone); stroke-width: 2.4; }
    .expiry-timer .tm-tick { stroke: var(--text-muted); stroke-width: 1; stroke-linecap: round; }
    .expiry-timer .tm-tick-major { stroke: var(--text-secondary); stroke-width: 2.2; }
    .expiry-timer .tm-num { fill: var(--text-muted); font-family: var(--font-ui); font-size: 9.5px; font-weight: 600;
      text-anchor: middle; dominant-baseline: central; }
    .expiry-timer .tm-sec { stroke: var(--text-muted); stroke-width: 0.9; stroke-linecap: round;
      transform-origin: ${CX}px ${CY}px; animation: tm-tick 60s steps(60) infinite; }
    @keyframes tm-tick { to { transform: rotate(360deg); } }
    html[data-motion="reduce"] .expiry-timer .tm-sec { display: none; }
    .expiry-timer .tm-hand { stroke: var(--tm-tone); stroke-width: 3; stroke-linecap: round; }
    .expiry-timer .tm-hub { fill: var(--tm-tone); }
    .expiry-timer .tm-pin { fill: var(--tm-face); }
    .expiry-timer .tm-glare { fill: none; stroke: var(--tm-lift); stroke-width: 3.4; stroke-linecap: round; opacity: 0.7; }
    html[data-theme-mode="dark"] .expiry-timer .tm-glare { opacity: 0.16; }`;
  document.head.appendChild(style);

  // A push button on the case, drawn at 12 o'clock and turned into place: a stem and a bevelled cap.
  const button = (deg, stemTop, capTop, capWidth) => `<g transform="rotate(${deg} ${CX} ${CY})">
      <rect class="tm-stem" x="${CX - 4.5}" y="${stemTop}" width="9" height="${CY - FACE - 6 - stemTop + 4}"/>
      <rect class="tm-metal" x="${CX - capWidth / 2}" y="${capTop}" width="${capWidth}" height="${stemTop - capTop + 2}" rx="2.6"/>
      <rect class="tm-bevel" x="${CX - capWidth / 2 + 2}" y="${capTop + 1.2}" width="${capWidth - 4}" height="2.2" rx="1.1"/>
    </g>`;

  // Hour ticks round the dial (a quarter tick longer), and quarter labels when they land on whole hours.
  function dial(length) {
    const hours = Math.round(length / 3600);
    const marks = hours >= 4 && hours <= 48 ? hours : 4;
    let out = '';
    for (let i = 0; i < marks; i++) {
      const quarter = (i * 4) % marks === 0;
      const [x1, y1] = at(i * 360 / marks, FACE - 2.5), [x2, y2] = at(i * 360 / marks, FACE - (quarter ? 9 : 5.5));
      out += `<line class="tm-tick${quarter ? ' tm-tick-major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    if (hours % 4 === 0) {
      [1, 2, 3].forEach((q) => {
        const [x, y] = at(q * 90, FACE - 18);
        out += `<text class="tm-num" x="${x}" y="${y}">${hours * q / 4}h</text>`;
      });
    }
    return out;
  }

  function wedge(deg, r) {   // clockwise from 12 o'clock to deg
    if (deg >= 359.95) return { fill: `M${CX} ${CY - r} A${r} ${r} 0 1 1 ${CX - 0.01} ${CY - r} Z`, edge: `M${CX} ${CY - r} A${r} ${r} 0 1 1 ${CX - 0.01} ${CY - r}` };
    const [x, y] = at(deg, r), big = deg > 180 ? 1 : 0;
    return { fill: `M${CX} ${CY} L${CX} ${CY - r} A${r} ${r} 0 ${big} 1 ${x} ${y} Z`, edge: `M${CX} ${CY - r} A${r} ${r} 0 ${big} 1 ${x} ${y}` };
  }

  function mount(el) {
    const [g1x, g1y] = at(-68, FACE - 7), [g2x, g2y] = at(-28, FACE - 7);
    el.innerHTML = `<svg class="expiry-timer" viewBox="0 0 140 160" aria-hidden="true">
      <ellipse class="tm-shadow" cx="${CX}" cy="${CY + FACE + 14}" rx="46" ry="3"/>
      ${button(-42, 30, 25, 13)}${button(42, 30, 25, 13)}${button(0, 18, 9, 26)}
      <circle class="tm-metal" cx="${CX}" cy="${CY}" r="${FACE + 9}"/>
      <circle class="tm-rim" cx="${CX}" cy="${CY}" r="${FACE + 7.6}"/>
      <circle class="tm-wall" cx="${CX}" cy="${CY}" r="${FACE + 3.5}"/>
      <circle class="tm-face" cx="${CX}" cy="${CY}" r="${FACE}"/>
      <path class="tm-wedge"/><path class="tm-edge"/>
      <g class="tm-dial"></g>
      <line class="tm-sec" x1="${CX}" y1="${CY + 8}" x2="${CX}" y2="${CY - FACE + 7}"/>
      <g class="tm-hand-group"><line class="tm-hand" x1="${CX}" y1="${CY + 8}" x2="${CX}" y2="${CY - FACE + 9}"/></g>
      <circle class="tm-hub" cx="${CX}" cy="${CY}" r="5"/>
      <circle class="tm-pin" cx="${CX}" cy="${CY}" r="1.9"/>
      <path class="tm-glare" d="M${g1x} ${g1y} A${FACE - 7} ${FACE - 7} 0 0 1 ${g2x} ${g2y}"/>
    </svg>`;
    const q = (sel) => el.querySelector(sel);
    const fill = q('.tm-wedge'), edge = q('.tm-edge'), hand = q('.tm-hand-group'), sec = q('.tm-sec'), face = q('.tm-dial');
    sec.style.animationDelay = `-${new Date().getSeconds()}s`;   // start where a real second hand would be
    let drawnLength = null;
    return {
      draw(fraction, running, sessionLength) {
        const length = Number(sessionLength) > 0 ? Number(sessionLength) : DEFAULT_LENGTH;
        if (length !== drawnLength) { face.innerHTML = dial(length); drawnLength = length; }
        const f = Math.max(0, Math.min(1, Number(fraction) || 0));
        const deg = (f > 0 ? Math.max(f, MIN_SHOWN) : 0) * 360;
        const w = deg > 0 ? wedge(deg, FACE - 1.5) : { fill: '', edge: '' };
        fill.setAttribute('d', w.fill);
        edge.setAttribute('d', w.edge);
        hand.setAttribute('transform', `rotate(${round(deg)} ${CX} ${CY})`);
        sec.style.display = running && f > 0 ? '' : 'none';
      },
    };
  }
  return { mount };
})();
