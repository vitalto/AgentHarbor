import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import { alignSteppedAnimations, STEP_SYNC_PERIOD_MS } from '@/shared/alignSteppedAnimations';
import { declineAnimationIterationListeners } from '@/shared/declineAnimationIterationListeners';

/**
 * A busy session's spinners kept Chrome drawing ~37 frames/s and waking the main thread ~30 times/s:
 * React's animationiteration listener forced main-thread animation ticks, and indicators that started
 * at different moments stepped at different moments. These guard both fixes.
 */

const originalAddEventListener = Element.prototype.addEventListener;
afterEach(() => {
  Element.prototype.addEventListener = originalAddEventListener;
});

test('elements decline animationiteration listeners and keep every other one', () => {
  declineAnimationIterationListeners();
  const element = document.createElement('div');
  const received: string[] = [];
  for (const type of ['animationiteration', 'webkitAnimationIteration', 'animationstart', 'click']) {
    element.addEventListener(type, () => received.push(type));
    element.dispatchEvent(new Event(type));
  }
  assert.deepEqual(received, ['animationstart', 'click']);
});

test('an endless animation is snapped onto a whole second when it starts; a one-shot is left alone', () => {
  alignSteppedAnimations();
  const endless = { startTime: 4_337.5 as number | null, effect: { getTiming: () => ({ iterations: Infinity }) } };
  const oneShot = { startTime: 1_337.5 as number | null, effect: { getTiming: () => ({ iterations: 1 }) } };
  const target = document.createElement('span');
  document.body.appendChild(target);
  Object.assign(target, { getAnimations: () => [endless, oneShot] });

  target.dispatchEvent(new Event('animationstart', { bubbles: true }));

  assert.equal(endless.startTime, 4_000);
  assert.equal((endless.startTime ?? 0) % STEP_SYNC_PERIOD_MS, 0);
  assert.equal(oneShot.startTime, 1_337.5);
  target.remove();
});
