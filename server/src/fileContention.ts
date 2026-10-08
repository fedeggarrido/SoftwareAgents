/** Windows readers/deleters can temporarily deny even metadata operations. */
export function isFileContention(error: unknown): boolean {
  return ['EPERM', 'EACCES', 'EBUSY', 'EBADF', 'ENOENT'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  );
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
// Capture before test clocks can replace performance.now. Wall time and fake
// timers must never turn a bounded filesystem retry into an infinite loop.
export const contentionNow = performance.now.bind(performance);
export function contentionPause(): void {
  Atomics.wait(sleeper, 0, 0, 5);
}

/** Monotonic deadline; a clock correction must not extend a retry indefinitely. */
export function retryFileOperation<T>(action: () => T, timeoutMs = 1000): T {
  const deadline = contentionNow() + timeoutMs;
  for (;;) {
    try {
      return action();
    } catch (error) {
      if (!isFileContention(error) || contentionNow() >= deadline) throw error;
      contentionPause();
    }
  }
}
