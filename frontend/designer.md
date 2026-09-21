# Designer Guide

A minimal Canvas 2D showcase focused on a clear central element with smooth animation. Design decisions should emphasize palette, composition, and motion rhythm.

## Visual Direction
- Background: dark gradient to spotlight the center; avoid noisy textures. The current gradient is a placeholder.
- Subject: Currently shows a **placeholder rotating square**. Replace with your game's central visual element.
- Palette: cool/warm gradient pairing (example: cyan/purple); swap in your own themed gradient as needed.
- Motion: smooth, constant rotation; layer gentle scale pulses or breathing light if you need more mood.

## Tunable Elements
- Background gradient: direction, colors, transition stops.
- Square size: viewport-relative or fixed px; optionally add corner radius or adjust stroke weight.
- Shadow/highlight: `shadowBlur`, `shadowColor`, stroke opacity.
- Motion cadence: rotation speed, optional easing/pauses.

## Collaboration Tips
- Add or tweak drawing functions in `src/draw/`, keep them parameterized (colors, size, speed).
- If adding UI text/buttons, place them near the edges to avoid covering the center; style in `src/styles.css`.
- Prefer gradients and vector-style shapes over bitmaps to minimize asset dependencies.
