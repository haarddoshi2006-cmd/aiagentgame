# Developer Agent Guide

> Canvas 2D starter template. Keep this doc updated so future features and UI additions stay aligned.

## Placeholder Content

The current rotating square (`drawPlaceholderSquare.js`) is a demonstration placeholder. Replace or remove it when implementing your actual game content. The background gradient in `drawBackground.js` can also be customized or replaced as needed.

## Tech Stack Overview
- **Runtime & Tooling**: [Vite](https://vitejs.dev/) front-end bundle; dev server on port 5173 by default.
- **Rendering**: Native Canvas 2D. Core assembly lives in `src/main.js`; drawing functions live in `src/draw/`.
- **Layout/Styles**: `src/styles.css` handles the full-screen background and base layout; canvas covers the viewport.
- **Scripts**: `npm run dev`, `npm run build`, `npm run preview`.

## Code Conventions
- ES Modules everywhere (`"type": "module"` is set in `package.json`).
- `main` does assembly only: grab context, manage size/DPR, start the loop, call draw functions.
- High-DPI: use `viewport.scale` and call `ctx.setTransform` before drawing.
- Add new drawing logic under `src/draw/`; keep functions pure, receiving `ctx` and `viewport` as args.
- Comment only for math or non-obvious drawing behavior.

## Common Task Recipes
| Task | How to Approach |
| --- | --- |
| Add a new shape/effect | Create a function in `src/draw/` (e.g., `drawParticles`) and call it from the loop with needed state. |
| Manage state | Keep shared state in `main` (e.g., angle, speed) and pass it through the render callback. |
| Input handling | Listen to mouse/keyboard, update state, and keep event logic decoupled from drawing. |
| Performance | Avoid extra `save/restore`, reuse gradients/paths, and limit high-cost effects like heavy `shadowBlur`. |
| Scaling | Use `createResizer` to keep `viewport` current, and call `ctx.setTransform(scale, 0, 0, scale, 0, 0)` before drawing. |
