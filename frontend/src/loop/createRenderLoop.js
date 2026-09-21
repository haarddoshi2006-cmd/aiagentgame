export function createRenderLoop(update) {
  let lastTimestamp = 0;

  function frame(timestamp = 0) {
    const delta = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : 0;
    lastTimestamp = timestamp;

    try {
      update({ timestamp, delta });
    } catch (err) {
      console.error('[dev-sim] render tick failed', err);
    } finally {
      requestAnimationFrame(frame);
    }
  }

  return () => requestAnimationFrame(frame);
}
