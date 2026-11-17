/**
 * Listeners by event name, each called without arguments. A listener that throws doesn't
 * keep the others from running: its error goes to `onError`.
 */
export class Emitter<E extends string> {
  private readonly listeners = new Map<E, Set<() => void>>();

  constructor(private readonly onError: (error: unknown) => void) {}

  on(event: E, listener: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  emit(event: E): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // A copy: listeners may subscribe or unsubscribe while being called.
    for (const listener of [...set]) {
      try {
        listener();
      } catch (error) {
        this.onError(error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
