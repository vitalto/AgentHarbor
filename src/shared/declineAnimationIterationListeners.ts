const ANIMATION_ITERATION_EVENTS = new Set(['animationiteration', 'webkitAnimationIteration']);

/**
 * A single `animationiteration` listener anywhere makes Chrome tick every running CSS animation on the
 * main thread (~12 wakeups/s per spinner instead of 0 — measured). React subscribes its root and every
 * portal container to it for onAnimationIteration, which nothing here uses (React is the bundle's only
 * subscriber), so elements decline that one event. onAnimationIteration therefore never fires.
 */
export function declineAnimationIterationListeners() {
  const elementAddEventListener = Element.prototype.addEventListener;
  Element.prototype.addEventListener = function addEventListenerExceptAnimationIteration(
    this: Element,
    ...args: Parameters<Element['addEventListener']>
  ) {
    if (ANIMATION_ITERATION_EVENTS.has(args[0])) return;
    elementAddEventListener.apply(this, args);
  };
}
