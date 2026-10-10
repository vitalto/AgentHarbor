/**
 * The endless indicators (spin, pulse, shimmer in tailwind.config.js) step 60 times a second. Chrome
 * draws a frame whenever any of them steps, so indicators that started at different moments add up —
 * five unsynchronised ones drew several times the frames of one. Every one of them steps a whole number
 * of times per second, so snapping each start onto a whole second puts all steps on the same ticks:
 * 60 frames/s however many are visible.
 */
export const STEP_SYNC_PERIOD_MS = 1000;

function snapToSyncPeriod(animation: Animation) {
  const isEndless = animation.effect?.getTiming().iterations === Infinity;
  if (!isEndless || animation.startTime === null) return;
  animation.startTime = Math.floor(Number(animation.startTime) / STEP_SYNC_PERIOD_MS) * STEP_SYNC_PERIOD_MS;
}

export function alignSteppedAnimations() {
  document.addEventListener(
    'animationstart',
    (event) => {
      if (event.target instanceof Element) event.target.getAnimations().forEach(snapToSyncPeriod);
    },
    true,
  );
}
