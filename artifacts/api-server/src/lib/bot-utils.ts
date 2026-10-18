/**
 * Small shared helpers for the bot manager: cancellation tokens for
 * long-running tasks, error formatting and Minecraft-flavoured formatting.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export class TaskCancelledError extends Error {
  constructor() {
    super("Task cancelled");
    this.name = "TaskCancelledError";
  }
}

export function isTaskCancelled(err: unknown): boolean {
  return err instanceof TaskCancelledError;
}

/**
 * Cooperative cancellation for long-running bot tasks (mining, chopping…).
 * Loops call `throwIfCancelled()` / `token.sleep()` / `token.wrap(promise)`
 * so the STOP command (or a replacement task) can interrupt them promptly,
 * including when they are blocked inside a pathfinder `goto()`.
 */
export class TaskToken {
  cancelled = false;
  private callbacks = new Set<() => void>();

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const cb of this.callbacks) {
      try {
        cb();
      } catch {
        // ignore cancel-handler errors
      }
    }
    this.callbacks.clear();
  }

  /** Register a callback fired on cancel. Returns an unregister function. */
  onCancel(cb: () => void): () => void {
    if (this.cancelled) {
      try {
        cb();
      } catch {
        // ignore
      }
      return () => {};
    }
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new TaskCancelledError();
  }

  /** Sleep that rejects immediately when the task is cancelled. */
  sleep(ms: number): Promise<void> {
    if (this.cancelled) return Promise.reject(new TaskCancelledError());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        resolve();
      }, ms);
      const off = this.onCancel(() => {
        clearTimeout(timer);
        reject(new TaskCancelledError());
      });
    });
  }

  /**
   * Race a promise against cancellation. `onCancel` lets the caller actively
   * interrupt the underlying operation (e.g. pathfinder.stop()).
   */
  wrap<T>(promise: Promise<T>, onCancel?: () => void): Promise<T> {
    if (this.cancelled) {
      onCancel?.();
      return Promise.reject(new TaskCancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      const off = this.onCancel(() => {
        try {
          onCancel?.();
        } catch {
          // ignore
        }
        reject(new TaskCancelledError());
      });
      promise.then(
        (value) => {
          off();
          resolve(value);
        },
        (err) => {
          off();
          reject(err);
        },
      );
    });
  }
}

/** Mineflayer yaw (radians, 0 = north, increasing turns left/west) → compass point. */
export function compassFromYaw(yaw: number): string {
  const points = ["N", "NW", "W", "SW", "S", "SE", "E", "NE"];
  const deg = ((yaw * 180) / Math.PI % 360 + 360) % 360;
  return points[Math.round(deg / 45) % 8];
}

/** Minecraft time-of-day ticks (0–23999) → human label. */
export function timeOfDayLabel(ticks: number): "day" | "sunset" | "night" | "sunrise" {
  const t = ((ticks % 24000) + 24000) % 24000;
  if (t < 1000) return "sunrise";
  if (t < 11000) return "day";
  if (t < 13000) return "sunset";
  if (t < 23000) return "night";
  return "sunrise";
}

/** `deepslate_diamond_ore` → `Deepslate Diamond Ore` */
export function prettifyName(name: string): string {
  return name
    .replace(/^minecraft:/, "")
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
