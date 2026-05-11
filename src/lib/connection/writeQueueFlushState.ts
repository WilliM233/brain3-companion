/**
 * Write-queue flush-state event surface for [2C-27] / [2C-29].
 *
 * [2C-29] will emit `'flushing'` at the start of each non-coalesced flush and
 * `'idle'` after the flush settles. [2C-27]'s connection store subscribes to
 * derive the `syncing` indicator state with the 800 ms pulse cap from
 * `config.ts`.
 *
 * **First Consumer Instantiates:** [2C-27] introduces this event so its hook
 * can subscribe with a stable interface. [2C-29] is the producer side — it
 * imports `emitFlushState` to publish transitions. Pre-[2C-29] the event
 * never fires, so the connection store sees `flushing: false` indefinitely,
 * which yields a stub `syncing: false` as Pass 5 §3 [2C-27] anticipates.
 *
 * Follows the `Set<Listener>` pub-sub convention used throughout this repo
 * (`pairing.ts`, `writeQueue.ts:subscribeConflicts`,
 * `completionQueues.ts:subscribe*Warnings`). Recommended `mitt` from the
 * brief was a suggestion, not a mandate — staying consistent with the
 * existing pattern avoids introducing a dep with no functional gain.
 */

export type FlushState = 'idle' | 'flushing';

type Listener = (state: FlushState) => void;

const listeners = new Set<Listener>();
let current: FlushState = 'idle';

export function getFlushState(): FlushState {
  return current;
}

export function subscribeFlushState(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitFlushState(state: FlushState): void {
  current = state;
  for (const listener of listeners) listener(state);
}

export function __resetFlushStateForTests(): void {
  listeners.clear();
  current = 'idle';
}
