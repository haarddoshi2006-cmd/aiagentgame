export function createCanvasContext(selector = '#stage') {
  const canvas = document.querySelector(selector);
  if (!canvas) {
    throw new Error(`Canvas element "${selector}" not found`);
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Unable to acquire 2D rendering context');
  }

  return { canvas, ctx };
}
