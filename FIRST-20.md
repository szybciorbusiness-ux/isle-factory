# The first 20 minutes — beat sheet (make every minute perfect: UI, feel, understanding)

User: "think about the first 20 minutes of gameplay and make them perfect in every sense, UI, feel, understanding."
References studied: Whiteout Survival camp ads (YouTube shorts) and cosy idle-game HUDs (Pinterest).

## What the references teach

1. **Abundance.** Drop zones and piles become big satisfying heaps; resources pour in fast streams; the
   character carries a tall stack. The player always feels rich and fast.
2. **Pads are floor plates.** A flat, high-contrast rounded plate on the ground with one item icon and ONE big bold
   number (e.g. 🪵 6). It reads in a split second from any zoom. No small floating bubbles for the main cost.
3. **Stations explain themselves.** A little wooden sign on each station shows input → output (🪵 → 🪚 plank).
4. **Sticker UI.** Thick dark-brown outlines, bright fills, chunky lips, oversized icons, outlined numerals,
   little red dots for "new". See UI-STYLE.md.
5. **The next thing is obvious.** One goal at a time: a bouncing arrow over it, and an arrow at the screen edge
   when it is off-screen. No quest list. (The user said "don't do quests"; guidance ≠ quests: no list, no text
   checklist, just "go here".)

## Beat sheet (target times; tuned with tools/pace.mjs)

| time | beat | the player understands | the moment |
|---|---|---|---|
| 0:00 | Robot boots up next to a cold, grey hearth; clouds tight around a small circle | "that's me; that's the centre" | visor flickers on, stretch, little hop; a joystick hint ring at the bottom |
| 0:10 | Guide arrow → nearest tree. Hint bubble once: "Walk into trees" | walking = acting | first tree: 3 bonks, it leans and FALLS (bounce, dust, leaves); 4 logs arc onto the back |
| 0:40 | Pad "Light the hearth 🪵3" glows by the hearth | pads take what you carry | stream in → the hearth IGNITES: light spreads over the island, colours warm up, clouds pull back a little |
| 1:00 | Sawmill pad 🪵6 appears (rises in) | the next thing always appears | building rises with overshoot; sign shows 🪵→plank |
| 2:00 | Drop zone at the sawmill → planks ride the line to the pile → arrow to the pile | stations convert | the first plank pops onto the pile |
| 3:00 | Pads: Cookfire (plank 8) and "Camp level 2" (plank 12) | choices, both visible | |
| 4:00 | Cookfire built → a deer wanders close; hint once: "Bump into animals to hunt" | hunting | bonk, cute poof, drumsticks arc in |
| 5:00 | Cooked meat appears on the cookfire pile | food | sizzle puffs |
| 6:30 | **Camp level 2**: ribbon banner + 3–4 new pads pop in one by one (hut, west bridge, pack upgrade, south bridge) | the camp grows | clouds open wider, hearth grows a ring of stones |
| 7:30 | Bigger pack (plank 12) → carry 20 | I got stronger | stack visibly taller; pill pulses "20" |
| 9:00 | Workers' hut → hire pad "Lumberjack 🍗3" | workers cost food | |
| 10:00 | Lumberjack walks out, chops, delivers wood to the sawmill on its own | automation | "it works without me" moment; planks pile up while you do something else |
| 11:00 | Hire a hunter; the camp now runs itself in a loop | | |
| 12:00 | West bridge (plank 10) → the forest isle: dense trees, boars | new land | planks fly in one by one; the camera nudges toward the new isle |
| 14:00 | **Camp level 3** (plank 30, cooked 8) | | bigger fire, banners |
| 15:00 | North bridge → stone; quarry (auto stone line) | machines | |
| 17:00 | East bridge (plank 20, stone 10) → copper isle | | |
| 18:30 | Copper drill → line → smelter → bars (a real production line) | production lines | items visibly travel drill → smelter → pile |
| 20:00 | Copper tools (axe upgrade) → gathering 1.6× faster; **Camp level 4** is in reach | power curve | big celebration at level 4 |

## Understanding (clarity) rules

- **One goal at a time**, computed by `camp.nextGoal()` (sim): gather X / pay pad / drop at station / pick up
  pile / hunt. Shown as a bouncing arrow over the target, a dotted trail on the ground from the robot (fades
  after 2 s of walking the right way), and an edge arrow when the target is off-screen.
- **First-time hints**: one short sentence-case line in a sticker bubble above the robot, max 5 in the whole
  game: "Walk into trees", "Stand on the pad to build", "Drop wood here", "Bump into animals to hunt",
  "Workers need cooked meat". Each shows once, for ~3 s or until done.
- **Stations** wear a sign: input icon → output icon.
- **Pads** show icon + remaining number in big outlined numerals on the floor plate; the number counts down live.
- **Locked future** is hinted, not hidden: unbuilt bridge landings show a faint dashed plank outline across the water.
- **Full stack**: the counter turns red "Full" and the guide points to where to drop.

## Feel rules

- Gathering: a swing every ~0.4 s with hit-stop (1–2 frames), white flash on the target, chips/leaves, a soft
  screen shake on the final hit only. Items arc onto the back in a stream (stagger 40–60 ms) and the stack sways.
- Paying/dropping: the stream accelerates the longer you stand, each item arcs from the stack top, and the pad
  number ticks with a pop. Completion is a moment: a beat of anticipation, then the build rises, dust, confetti.
- Abundance: drops are generous (a tree = 4 logs), piles render as heaps that grow, and the sawmill outputs fast
  enough that you never wait on it.
- Sound later (not in this round).
