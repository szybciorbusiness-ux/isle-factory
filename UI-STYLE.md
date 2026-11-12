# Isle Camp UI — "sticker" style (the bar: exceptional, game-grade, not app UI)

User: "I feel like the UI needs to be much more exceptional." The first HUD was flat cream cards. It read as an
app. Top cosy / idle games read as *toys*: every element is a chunky, tactile sticker that pops and rolls.

## Visual language

- **Sticker pills and cards.** Cream fill `#fff7e6`, a **3 px warm-brown outline** `#5b3a21` (never grey), an inner top
  highlight (1.5 px `rgba(255,255,255,.85)` inset at the top), and a **4 px solid bottom lip** in a darker tone of the
  fill (`#e3c99a` under cream). Radius = full pill or 18–22 px cards. A soft drop shadow under the lip
  (`0 8px 16px -8px rgba(60,40,20,.45)`). Accent stickers: orange `#ff9a2e`/lip `#d26a12`, green `#8fd14f`/lip
  `#5e9e2c`, red `#ff6b5e`/lip `#c94236`, sky `#62c8ff`/lip `#2f93c9`.
- **Icons break out.** 3D item icons (src/ui/icons.js renders from the real models) sit ~20% larger than the
  pill they belong to and overlap its left edge, with a tiny drop shadow. They should never look boxed in.
- **Numbers are the hero.** Fredoka 700, tabular, with a 3 px outline in the outline colour
  (`-webkit-text-stroke` plus `paint-order: stroke fill`, or layered text-shadows) and a 2 px lip shadow under the
  glyphs. White numerals on coloured stickers; brown numerals on cream. Large: 22–28 px on the phone for key counts.
- **Type.** Fredoka 600 for labels, sentence case, never all caps. Short words. No paragraphs anywhere in the HUD.
- **Ribbons.** Level-ups and unlocks use a ribbon banner: a wide orange sticker with folded tail ends (CSS clip-path
  or SVG), a star burst behind it, with the title in big outlined white numerals/letters.
- **Progress bars.** Thick (12–16 px), with the brown outline and an inner well. The fill is a bright gradient with
  a moving shine sweep and segmented ticks for discrete goals. On completion they flash and pop.
- **World-space labels** (pad cost bubbles, the stack counter, the "Full" bubble, worker thought bubbles) use the
  same sticker language: a speech-bubble shape with a little tail pointing down to the thing, billboarded,
  always crisp (DOM projected, or high-DPR canvas sprites).

## Motion (Emil bar + game juice)

- UI state changes: 150–250 ms, `cubic-bezier(0.23, 1, 0.32, 1)`. Enter from `scale(.9)` + opacity with a small
  overshoot spring for stickers (games allow more bounce than apps), never from 0. Press: `scale(.94)` → spring back.
- Counters **roll** (odometer digits sliding) and the icon **bumps** (scale 1 → 1.25 → 1 with a spring) per gain;
  "+N" floaters rise from the counter with a slight arc and fade.
- Nothing jitters: everything world-anchored is projected each frame from `update(dt)` and smoothed.
- Respect `prefers-reduced-motion` (keep fades, drop bounces).

## Layout (portrait first, 402×874 with safe areas; landscape scales up gracefully)

- Top-left under the status bar: **Camp level badge**, a round orange sticker with the flame and level number,
  with a ring showing the current hearth pad's payment progress. Tapping it shows a tiny tooltip of what the
  next level unlocks.
- Top-right: optional sound toggle (sticker button).
- Above the robot: the **stack counter** sticker `7/10` with the top item's icon, bouncing on change, turning into
  a red **Full** bubble (with a gentle wobble) at capacity.
- Bottom: nothing but the floating joystick (it appears wherever the thumb lands). Keep the bottom 40% of the
  screen visually clean.
- Level-up: ribbon banner centred in the upper third, with the confetti and radial rays the world already does,
  plus a list of 1–3 unlocked things as small icon stickers that pop in one by one.
- Toasts: small sticker pills sliding down from the top, max 2 visible.
