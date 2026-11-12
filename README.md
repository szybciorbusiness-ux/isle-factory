# Isle Factory

A cosy arcade-idle survival camp on little low-poly islands. Walk with a floating joystick (or WASD); the robot
chops, mines and hunts on its own, carries a stack on its back, feeds stations with production lines, and pays
for buildings, bridges, workers and camp levels by standing on build pads.

Work in progress. Plain ES modules + three.js r183 (vendored), no build step.

## Run

```bash
npm install          # only needed for the headless test tools (playwright-core)
node serve.mjs 4660
```

- Game: http://localhost:4660/ (add `?fps` for a frame meter, `?factory` for the old factory sandbox)
- Phone simulator (portrait, iPhone frame): http://localhost:4660/phone/

## Docs

- `GAMEPLAY.md`: the camp loop, sim API and events
- `FIRST-20.md`: the first 20 minutes, beat by beat
- `UI-STYLE.md`: the sticker UI language
- `DESIGN.md`: art direction, motion rules and the module contract

## Checks

```bash
node --test tests/*.test.mjs      # sim + camp tests
node tools/pace.mjs 25            # bot plays the camp headless and prints the timeline
node tools/playtest.mjs 20        # bot plays in the real game (headless, GPU) and saves frames per beat
node tools/shot.mjs --url "/?paused=1" --out shots/x.png
```
