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

// ---------------------------------------------------------------------------
// Chat-component → plain text (kick reasons, disconnect messages)
// ---------------------------------------------------------------------------

const NBT_TAG_TYPES = new Set([
  "byte", "short", "int", "long", "float", "double",
  "byteArray", "string", "list", "compound", "intArray", "longArray",
]);

/** Unwrap a protodef/prismarine-nbt node ({ type, value }) into plain JS. */
function deNbtify(node: unknown, depth = 0): unknown {
  if (!node || typeof node !== "object" || depth > 16) return node;
  const nbt = node as { type?: unknown; value?: unknown };
  if (typeof nbt.type !== "string" || !NBT_TAG_TYPES.has(nbt.type) || !("value" in nbt)) {
    return node;
  }
  switch (nbt.type) {
    case "compound": {
      if (!nbt.value || typeof nbt.value !== "object") return {};
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(nbt.value as Record<string, unknown>)) {
        out[key] = deNbtify(val, depth + 1);
      }
      return out;
    }
    case "list": {
      const listVal = nbt.value as { type?: unknown; value?: unknown } | null;
      const items = listVal && Array.isArray(listVal.value) ? listVal.value : [];
      // Items are raw values of the inner tag type (strings, numbers, or
      // compound maps that still need unwrapping).
      return items.map((item: unknown) =>
        listVal?.type === "compound" ? deNbtify({ type: "compound", value: item }, depth + 1) : item,
      );
    }
    default:
      return nbt.value;
  }
}

function truncateText(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function componentNodeToText(node: unknown, fallbackRaw: string | null, maxLen: number): string {
  // prismarine-chat ChatMessage instances know how to render themselves.
  if (node && typeof node === "object") {
    const ctorName = (node as { constructor?: { name?: unknown } }).constructor?.name;
    if (ctorName === "ChatMessage") {
      const rendered = String((node as { toString: () => string }).toString());
      if (rendered) return truncateText(rendered.replace(/\s+/g, " ").trim(), maxLen);
    }
  }

  let text = "";
  const visit = (n: unknown, depth: number): void => {
    if (depth > 16 || text.length > maxLen * 2) return;
    const plain = deNbtify(n, depth);
    if (typeof plain === "string") {
      text += plain;
      return;
    }
    if (Array.isArray(plain)) {
      for (const child of plain) visit(child, depth + 1);
      return;
    }
    if (!plain || typeof plain !== "object") return;
    const comp = plain as Record<string, unknown>;
    if (typeof comp.text === "string") text += comp.text;
    else if (comp.text !== undefined) visit(comp.text, depth + 1);
    if (comp.extra !== undefined) visit(comp.extra, depth + 1);
    if (comp.text === undefined && comp.extra === undefined && typeof comp.translate === "string") {
      text += comp.translate;
    }
  };
  visit(node, 0);

  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned) return truncateText(cleaned, maxLen);
  if (fallbackRaw) return truncateText(fallbackRaw, maxLen);
  try {
    return truncateText(JSON.stringify(node) ?? String(node), maxLen);
  } catch {
    return truncateText(String(node), maxLen);
  }
}

/**
 * Render a Minecraft chat component — or a kick/disconnect reason in any of
 * the shapes Mineflayer delivers — as plain text. Handles plain strings,
 * JSON-encoded components, prismarine-chat ChatMessage instances, component
 * objects ({ text, extra, translate }) and the NBT-wrapped components
 * ({ type: "compound", value: … }) newer protocol versions use.
 */
export function chatComponentToText(input: unknown, maxLen = 220): string {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return truncateText(input, maxLen);
    try {
      return componentNodeToText(JSON.parse(trimmed) as unknown, input, maxLen);
    } catch {
      return truncateText(input, maxLen);
    }
  }
  return componentNodeToText(input, null, maxLen);
}

/**
 * Append a plain-English hint to a raw connection failure — socket errors
 * like "write EPIPE" or "socketClosed" mean nothing to most users.
 * Returns the input unchanged when no known pattern matches.
 */
export function describeConnectionError(raw: string): string {
  let hint: string | null = null;
  if (/ECONNREFUSED/i.test(raw)) {
    hint = "nothing is listening at that address — is the server online, and is the port right?";
  } else if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    hint = "that hostname could not be resolved — check the address for typos";
  } else if (/ETIMEDOUT|timed out/i.test(raw)) {
    hint = "the server did not answer in time — it may be offline, still starting, or blocked by a firewall";
  } else if (/EPIPE|ECONNRESET|socketClosed|socket hang up/i.test(raw)) {
    hint =
      "the connection was closed during login — the server may be offline or still starting, the port may be wrong " +
      "(hosts like Aternos change it every restart), or outbound connections to it are blocked";
  } else if (/protocol version|unsupported.*version/i.test(raw)) {
    hint = "this Minecraft version may not be supported yet — try setting the version explicitly to match the server";
  }
  return hint ? `${raw} — ${hint}` : raw;
}

// ---------------------------------------------------------------------------
// Outbound movement-packet guard
// ---------------------------------------------------------------------------

export interface MovePacketFallback {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

const MOVE_PACKET_FIELDS: Record<string, Array<keyof MovePacketFallback>> = {
  position: ["x", "y", "z"],
  look: ["yaw", "pitch"],
  position_look: ["x", "y", "z", "yaw", "pitch"],
};

/**
 * Repair non-finite fields in an outbound movement packet, in place, and
 * report whether anything had to be fixed.
 *
 * Why: mineflayer answers a server `position` packet (teleport / respawn)
 * synchronously inside its packet handler with `position_look`, computed
 * from relative-flag math over the entity's current yaw/pitch. Right after
 * a server-initiated respawn (e.g. SkinsRestorer applying a skin on join)
 * that math can yield NaN, and mineflayer only finite-checks x/y/z before
 * sending — never yaw/pitch. Vanilla/Paper responds with a kick:
 * "Invalid move player packet received". Sanitizing at the `_client.write`
 * choke point covers every send path (physics ticks, forced moves, the
 * delayed post-death response, look calls), not just the ones we can hook.
 */
export function sanitizeMovePacketParams(
  name: string,
  params: Record<string, unknown> | undefined | null,
  fallback: MovePacketFallback,
): boolean {
  const fields = MOVE_PACKET_FIELDS[name];
  if (!fields || !params || typeof params !== "object") return false;
  let repaired = false;
  for (const field of fields) {
    const value = params[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      params[field] = fallback[field];
      repaired = true;
    }
  }
  return repaired;
}
