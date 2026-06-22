// apps/dashboard/lib/live-poll.ts
// Pure, DOM-free polling controller: owns the interval and the tab-visibility
// pause. `document` and React are injected (isHidden / subscribeVisibility) so
// this unit-tests with node:test + mock.timers and no browser environment.

export interface LivePollDeps {
  intervalMs: number;
  onTick: () => void;
  /** True when the tab is hidden; while hidden the interval is paused. */
  isHidden: () => boolean;
  /** Subscribe to visibility changes; returns an unsubscribe fn. */
  subscribeVisibility: (cb: () => void) => () => void;
}

export interface LivePoll {
  start: () => void;
  stop: () => void;
}

export function createLivePoll(deps: LivePollDeps): LivePoll {
  const { intervalMs, onTick, isHidden, subscribeVisibility } = deps;

  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  const startInterval = () => {
    if (timer === null) timer = setInterval(onTick, intervalMs);
  };
  const stopInterval = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const onVisibilityChange = () => {
    if (!started) return;
    if (isHidden()) {
      stopInterval();
    } else if (timer === null) {
      // Became visible while paused: refresh once now, then resume.
      onTick();
      startInterval();
    }
  };

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribe = subscribeVisibility(onVisibilityChange);
      if (!isHidden()) startInterval();
    },
    stop() {
      if (!started) return;
      started = false;
      stopInterval();
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  };
}
