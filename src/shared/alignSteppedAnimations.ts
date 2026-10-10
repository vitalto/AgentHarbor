/**
 * The endless indicators (spin, pulse, shimmer in tailwind.config.js) step every 125 ms. Chrome draws
 * a frame whenever any of them steps, so indicators that started at different moments add up — five on
 * screen drew ~37 frames/s. Snapping each one's start onto a shared 125 ms grid makes them step
 * together: ~8 frames/s however many are visible.
 */
export const STEPPED_ANIMATION_GRID_MS = 125;

function snapToGrid(animation: Animation) {
  const isEndless = animation.effect?.getTiming().iterations === Infinity;
  if (!isEndless || animation.startTime === null) return;
  animation.startTime = Math.floor(Number(animation.startTime) / STEPPED_ANIMATION_GRID_MS) * STEPPED_ANIMATION_GRID_MS;
}

export function alignSteppedAnimations() {
  document.addEventListener(
    'animationstart',
    (event) => {
      if (event.target instanceof Element) event.target.getAnimations().forEach(snapToGrid);
    },
    true,
  );
}
