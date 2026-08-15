const studioAborts = new WeakSet();

export function abortError(message = 'Operation cancelled.') {
  const error = new DOMException(message, 'AbortError');
  studioAborts.add(error);
  return error;
}

export function isStudioAbort(error) { return Boolean(error && studioAborts.has(error)); }

// `task` may be a promise/value or a factory. Factories are invoked in a
// microtask so synchronous tool errors become ordinary promise rejections and
// are handled by the same timeout/cancellation path as async failures.
export async function waitBounded(task, { timeoutMs, timeoutMessage = 'Operation timed out.', signal = null, abortMessage } = {}) {
  if (signal?.aborted) throw abortError(abortMessage);
  if (Number.isFinite(timeoutMs) && timeoutMs <= 0) throw new Error(timeoutMessage);
  let timer; let onAbort;
  const operation = typeof task === 'function' ? Promise.resolve().then(task) : Promise.resolve(task);
  const races = [operation];
  if (Number.isFinite(timeoutMs)) races.push(new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs); }));
  if (signal) races.push(new Promise((_, reject) => {
    onAbort = () => reject(abortError(abortMessage));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  }));
  try { return await Promise.race(races); }
  finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
