/** Runs `fn` once every call made before it has settled; its result. */
export type WorkspaceLock = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * The one mutex for everything that changes the real `~/.japa` (spec §4.4): going live, rollback, change undo,
 * auto-rollback, safe mode and the boot-time adoption. Calls run one at a time, in order; a call that rejects doesn't
 * stop the next.
 */
export function createWorkspaceLock(): WorkspaceLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const result = tail.then(() => fn());
    tail = result.catch(() => {});
    return result;
  };
}
