/**
 * Keeps the canvas backing store in sync with CSS size and devicePixelRatio.
 * Scene code uses viewport.width / viewport.height as logical pixels; scale is DPR.
 */
export function createResizer(canvas) {
  const viewport = { width: 800, height: 600, scale: 1 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const bw = Math.max(1, Math.floor(cssW * dpr));
    const bh = Math.max(1, Math.floor(cssH * dpr));
    canvas.width = bw;
    canvas.height = bh;
    viewport.width = cssW;
    viewport.height = cssH;
    viewport.scale = dpr;
  }

  resize();
  window.addEventListener('resize', resize);

  return { viewport, resize };
}
