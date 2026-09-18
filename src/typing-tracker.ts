/** How long a "thinking..." indicator stays up before it expires on its own. */
export const THINKING_TTL_MS = 6000;

/**
 * Remembers who is mid-message. Each entry lives for 6 seconds unless it is
 * refreshed by another keystroke, cancelled by a `stop`, or cut short when the
 * message actually arrives.
 */
export class TypingTracker {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly onChange: (users: string[]) => void) {}

  start(user: string): void {
    const existing = this.timers.get(user);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => this.stop(user), THINKING_TTL_MS);
    timer.unref();
    this.timers.set(user, timer);

    if (!existing) this.onChange(this.users());
  }

  stop(user: string): void {
    const existing = this.timers.get(user);
    if (!existing) return;
    clearTimeout(existing);
    this.timers.delete(user);
    this.onChange(this.users());
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  users(): string[] {
    return [...this.timers.keys()];
  }
}
