// Styles for the guide's own DOM layer (.guide-layer inside ctx.uiRoot): the off-screen edge chip and the
// first-time hint bubble. Sticker language from UI-STYLE.md: cream fill, 3 px warm-brown outline, inner top
// highlight, a darker lip at the bottom, chunky icons that break out of their sticker. JS sets every
// transform / opacity from update(dt); CSS only lays out (no transitions, no keyframes).
export const CSS = `
.guide-layer { position: fixed; inset: 0; pointer-events: none !important; overflow: hidden; z-index: 4;
  font-family: 'Fredoka', 'Nunito', ui-rounded, system-ui, sans-serif; color: #5b3a21;
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none; contain: layout style; }
.guide-layer * { box-sizing: border-box; }
.guide-layer img { -webkit-user-drag: none; }
.gl-probe { position: absolute; left: 0; width: 0; top: var(--safe-top, 0px); bottom: var(--safe-bottom, 0px); visibility: hidden; }

/* ---------- off-screen edge chip ---------- */
.ge { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform, opacity; opacity: 0; visibility: hidden; }
.ge-in { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
.ge-ptr { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
.ge-ptr svg { position: absolute; left: 17px; top: -19px; width: 30px; height: 38px; overflow: visible; display: block; filter: drop-shadow(0 2px 0 rgba(91,58,33,.25)); }
.ge-face { position: absolute; left: -27px; top: -27px; width: 54px; height: 54px; border-radius: 50%;
  background: #fff7e6; border: 3px solid #5b3a21;
  box-shadow: inset 0 1.5px 0 rgba(255,255,255,.85), inset 0 -4px 0 #e3c99a, 0 8px 16px -8px rgba(60,40,20,.45);
  display: grid; place-items: center; }
.ge-face img { width: 46px; height: 46px; display: block; margin-top: -3px; filter: drop-shadow(0 2px 0 rgba(91,58,33,.25)); }
.ge-face canvas { width: 40px; height: 40px; display: block; margin-top: -3px; }
.ge-dot { position: absolute; right: -4px; top: -4px; width: 15px; height: 15px; border-radius: 50%;
  background: #ff9a2e; border: 2.5px solid #5b3a21; box-shadow: inset 0 -2px 0 #d26a12; }
body.mobile .ge-face { left: -24px; top: -24px; width: 48px; height: 48px; }
body.mobile .ge-face img { width: 41px; height: 41px; }
body.mobile .ge-face canvas { width: 35px; height: 35px; }
body.mobile .ge-ptr svg { left: 15px; top: -17px; width: 27px; height: 34px; }

/* ---------- first-time hint bubble (above the robot) ---------- */
.gh { position: absolute; left: 0; top: 0; width: max-content; display: flex; flex-direction: column; align-items: center;
  transform-origin: 50% 100%; will-change: transform, opacity; opacity: 0; visibility: hidden; padding-top: 6px; }
.gh-card { position: relative; display: flex; align-items: center; height: 46px; padding: 0 18px 2px 50px; border-radius: 999px;
  background: #fff7e6; border: 3px solid #5b3a21; white-space: nowrap;
  box-shadow: inset 0 1.5px 0 rgba(255,255,255,.85), inset 0 -4px 0 #e3c99a, 0 8px 16px -8px rgba(60,40,20,.45);
  font-size: 18px; font-weight: 600; line-height: 1; letter-spacing: .005em; color: #5b3a21; }
.gh-card.no-icon { padding-left: 18px; }
.gh-icon { position: absolute; left: -12px; top: 50%; width: 56px; height: 56px; margin-top: -30px; display: grid; place-items: center; }
.gh-icon img { width: 56px; height: 56px; display: block; filter: drop-shadow(0 2px 0 rgba(91,58,33,.28)); }
.gh-icon canvas { width: 46px; height: 46px; display: block; }
.gh-tail { display: block; width: 24px; height: 14px; margin-top: -3.5px; overflow: visible; }
body.mobile .gh-card { height: 42px; font-size: 16.5px; padding: 0 16px 2px 45px; }
body.mobile .gh-card.no-icon { padding-left: 16px; }
body.mobile .gh-icon { width: 50px; height: 50px; margin-top: -27px; left: -11px; }
body.mobile .gh-icon img { width: 50px; height: 50px; }
body.mobile .gh-icon canvas { width: 41px; height: 41px; }
`;

// The edge chip's pointer: an orange arrowhead with the brown outline and a lip, pointing +x.
export const POINTER_SVG = `<svg viewBox="0 0 26 34" aria-hidden="true"><path d="M3 4.5 Q3 2 5.4 3.1 L22.6 14.6 Q25 17 22.6 19.4 L5.4 30.9 Q3 32 3 29.5 Z"
  fill="#ff9a2e" stroke="#5b3a21" stroke-width="3" stroke-linejoin="round"/><path d="M6.5 24.6 L19.5 16.9" stroke="#d26a12" stroke-width="2.6" stroke-linecap="round" opacity=".9"/></svg>`;

// Hint tail: points down at the robot.
export const TAIL_SVG = `<svg class="gh-tail" viewBox="0 0 24 14" aria-hidden="true"><path d="M1.5 1.5 L9.6 11.4 Q12 14 14.4 11.4 L22.5 1.5"
  fill="#fff7e6" stroke="#5b3a21" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><path d="M3 0 H21" stroke="#fff7e6" stroke-width="3.2"/></svg>`;
