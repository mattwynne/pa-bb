import { VaultError } from './ports.ts';
/** Dispose closes admission, then waits for entered work before invalidating state. */
export class Admission {
  private closed = false;
  private entered = new Set<Promise<unknown>>();
  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new VaultError('unavailable'));
    const task = Promise.resolve().then(action);
    this.entered.add(task);
    return task.finally(() => this.entered.delete(task));
  }
  async stop() { this.closed = true; await Promise.allSettled([...this.entered]); }
}
