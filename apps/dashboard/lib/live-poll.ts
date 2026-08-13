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
  /**
   * Called whenever the interval starts or stops, so the UI can report whether
   * it is really refreshing rather than guess (AIW-266: a "Live" badge over a
   * stopped loop is worse than no badge, because it removes the user's only cue
   * to reload).
   */
  onRunningChange?: (running: boolean) => void;
}

export interface LivePoll {
  start: () => void;
  stop: () => void;
}

/**
 * There is deliberately no tick budget. A counter cannot know how long the work
 * being watched takes — production runs last 400-730s, so a five minute budget
 * expired mid-run and froze the screen with no signal. Worse, once the budget
 * was spent the visibility handler could no longer restart the interval, so
 * returning to the tab bought a single refresh and then silence. The only thing
 * that ends a loop here is the caller disabling it (the run reached a terminal
 * status) or the tab going away.
 */
export function createLivePoll(deps: LivePollDeps): LivePoll {
  const { intervalMs, onTick, isHidden, subscribeVisibility, onRunningChange } =
    deps;

  let timer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  const startInterval = () => {
    if (timer !== null) return;
    timer = setInterval(onTick, intervalMs);
    onRunningChange?.(true);
  };
  const stopInterval = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    onRunningChange?.(false);
  };

  const onVisibilityChange = () => {
    if (!started) return;
    if (isHidden()) {
      stopInterval();
    } else if (timer === null) {
      // Became visible while paused: refresh once now, then resume the cycle.
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
