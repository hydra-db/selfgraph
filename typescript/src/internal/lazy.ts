export class Lazy<T> {
  private pending: Promise<T> | null = null;

  /**
   * A value loaded on first use and shared by every caller; a failed load is dropped so the next call retries.
   *
   * @param load (() => Promise<T>): starts loading the value.
   */
  constructor(private readonly load: () => Promise<T>) {}

  /**
   * The loaded value, starting the load if none is pending.
   *
   * @return (T): the value.
   */
  get(): Promise<T> {
    if (this.pending === null) {
      const pending = this.load();
      this.pending = pending;
      pending.catch(() => {
        if (this.pending === pending) this.pending = null;
      });
    }
    return this.pending;
  }

  /**
   * Replace the value without loading it.
   *
   * @param value (T): the value.
   */
  set(value: T): void {
    this.pending = Promise.resolve(value);
  }

  /**
   * Drop the value and hand it to release once loaded; a load that never started or failed has nothing to release.
   *
   * @param release ((value: T) => Promise<void>): frees the loaded value.
   */
  async release(release: (value: T) => Promise<void>): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) return;
    let value: T;
    try {
      value = await pending;
    } catch {
      return;
    }
    await release(value);
  }
}
