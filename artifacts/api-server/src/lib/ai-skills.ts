/**
 * AI skill library + sandboxed skill execution.
 *
 * The AI brain can write new JavaScript "skills" for itself (the Voyager
 * pattern). Skills are persisted to disk, catalogued for the planner, and
 * executed in a `node:vm` context that receives ONLY a frozen helper API
 * (bot-control functions) — no require, no process, no filesystem, no
 * network, and string code-generation (eval/Function) disabled inside the
 * context. As defence in depth, skill code is also statically screened
 * for dangerous tokens before it is saved or run.
 *
 * This is best-effort isolation appropriate for a single-user local bot:
 * skills are owner-triggered, saved to disk, and reviewable/deletable in
 * the dashboard.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { logger } from "./logger";

export interface AiSkill {
  name: string;
  description: string;
  code: string;
  createdAt: string;
  updatedAt: string;
  runs: number;
  successes: number;
  failures: number;
}

export interface AiSkillSummary {
  name: string;
  description: string;
  runs: number;
  successes: number;
  failures: number;
  updatedAt: string;
}

const SKILL_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_SKILL_CODE_CHARS = 8000;

const BLOCKED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brequire\s*\(/, why: "require() is not available in skills" },
  { re: /\bprocess\b/, why: "process is not available in skills" },
  { re: /\bconstructor\b/, why: "constructor access is blocked" },
  { re: /__proto__/, why: "__proto__ access is blocked" },
  { re: /\beval\s*\(/, why: "eval() is blocked" },
  { re: /\bFunction\s*\(/, why: "Function() is blocked" },
  { re: /\bimport\s*\(/, why: "dynamic import is blocked" },
  { re: /^\s*import\s/m, why: "import statements are not allowed in skills" },
  { re: /\bglobalThis\b/, why: "globalThis access is blocked" },
  { re: /\bmodule\s*\./, why: "module access is blocked" },
  { re: /child_process/, why: "child_process is blocked" },
  { re: /\bfetch\s*\(/, why: "fetch() is not available in skills (no network)" },
  { re: /\bWebSocket\b/, why: "WebSocket is not available in skills" },
  { re: /\bXMLHttpRequest\b/, why: "XMLHttpRequest is not available in skills" },
];

/** Returns an error message when the name is invalid, else null. */
export function validateSkillName(name: string): string | null {
  if (!SKILL_NAME_RE.test(name)) {
    return `invalid skill name "${name}" — use snake_case (a-z, 0-9, _), starting with a letter, max 41 chars`;
  }
  return null;
}

/** Returns an error message when the code fails screening, else null. */
export function screenSkillCode(code: string): string | null {
  if (!code || code.trim() === "") return "skill code is empty";
  if (code.length > MAX_SKILL_CODE_CHARS) {
    return `skill code too long (${code.length} chars, max ${MAX_SKILL_CODE_CHARS})`;
  }
  for (const { re, why } of BLOCKED_PATTERNS) {
    if (re.test(code)) return `blocked: ${why}`;
  }
  return null;
}

export class SkillLibrary {
  private skills = new Map<string, AiSkill>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
  }

  private load() {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return; // First run — no library file yet.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // A corrupt/hand-edited file must not be silently overwritten by the
      // next save() — preserve it for inspection and start empty.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
        logger.warn({ backup }, "AI skill library file was corrupt — backed up, starting with an empty library");
      } catch {
        // best effort
      }
      return;
    }
    try {
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        const s = entry as Partial<AiSkill>;
        if (
          typeof s.name === "string" &&
          typeof s.code === "string" &&
          validateSkillName(s.name) === null
        ) {
          this.skills.set(s.name, {
            name: s.name,
            description: typeof s.description === "string" ? s.description : "",
            code: s.code,
            createdAt: typeof s.createdAt === "string" ? s.createdAt : new Date().toISOString(),
            updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : new Date().toISOString(),
            runs: Number(s.runs) || 0,
            successes: Number(s.successes) || 0,
            failures: Number(s.failures) || 0,
          });
        }
      }
    } catch {
      // First run / unreadable file — start with an empty library.
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.skills.values()], null, 2));
    } catch (err) {
      logger.warn({ err }, "Could not persist AI skill library");
    }
  }

  list(): AiSkillSummary[] {
    return [...this.skills.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, description, runs, successes, failures, updatedAt }) => ({
        name,
        description,
        runs,
        successes,
        failures,
        updatedAt,
      }));
  }

  /** Name + one-liners for the planner prompt. */
  catalog(): Array<{ name: string; description: string }> {
    return [...this.skills.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ name: s.name, description: s.description }));
  }

  get(name: string): AiSkill | undefined {
    return this.skills.get(name);
  }

  upsert(name: string, description: string, code: string): AiSkill {
    const now = new Date().toISOString();
    const existing = this.skills.get(name);
    const skill: AiSkill = {
      name,
      description: description.slice(0, 300),
      code,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      runs: existing?.runs ?? 0,
      successes: existing?.successes ?? 0,
      failures: existing?.failures ?? 0,
    };
    this.skills.set(name, skill);
    this.save();
    return skill;
  }

  remove(name: string): boolean {
    const existed = this.skills.delete(name);
    if (existed) this.save();
    return existed;
  }

  recordRun(name: string, ok: boolean) {
    const skill = this.skills.get(name);
    if (!skill) return;
    skill.runs += 1;
    if (ok) skill.successes += 1;
    else skill.failures += 1;
    skill.updatedAt = new Date().toISOString();
    this.save();
  }
}

export interface SkillRunOutcome {
  ok: boolean;
  result?: string;
  error?: string;
}

const TIMEOUT = Symbol("skill-timeout");

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    // First stack lines help the AI fix its own code; keep them short.
    const stack = (err.stack ?? err.message).split("\n").slice(0, 3).join(" | ");
    return stack.slice(0, 400);
  }
  return String(err).slice(0, 400);
}

/**
 * Execute skill code in a vm sandbox. The code is wrapped in an async
 * function receiving `api` (frozen helper object). `onTimeout` is invoked
 * when the hard timeout hits so the caller can cancel cooperative work
 * (task token); the returned promise settles shortly after regardless.
 */
export async function runSkillInSandbox(
  code: string,
  api: Record<string, unknown>,
  opts: {
    timeoutMs: number;
    onTimeout: () => void;
    onLog: (message: string) => void;
  },
): Promise<SkillRunOutcome> {
  const screenError = screenSkillCode(code);
  if (screenError) return { ok: false, error: screenError };

  const wrapped = `(async (api) => {\n"use strict";\n${code}\n})(api)`;
  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: "ai-skill.js" });
  } catch (err) {
    return { ok: false, error: `skill code does not compile: ${errMessage(err)}` };
  }

  const logLine = (...args: unknown[]) => {
    try {
      opts.onLog(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    } catch {
      // never let logging break the skill
    }
  };
  const sandbox: Record<string, unknown> = {
    api: Object.freeze(api),
    console: { log: logLine, info: logLine, warn: logLine, error: logLine },
  };
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  let promise: Promise<unknown>;
  try {
    // The vm timeout guards the synchronous prefix (before the first
    // await) against infinite loops; after that, cooperative helpers
    // and the race below govern.
    promise = script.runInContext(context, { timeout: 10_000 }) as Promise<unknown>;
  } catch (err) {
    return { ok: false, error: `skill failed to start: ${errMessage(err)}` };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      try {
        opts.onTimeout();
      } catch {
        // ignore
      }
      resolve(TIMEOUT);
    }, opts.timeoutMs);
  });

  const settled = promise.then(
    (value) => ({ kind: "value" as const, value }),
    (err: unknown) => ({ kind: "error" as const, err }),
  );

  const winner = await Promise.race([settled, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (winner === TIMEOUT) {
    return { ok: false, error: `skill timed out after ${Math.round(opts.timeoutMs / 1000)}s` };
  }
  if (winner.kind === "error") {
    return { ok: false, error: errMessage(winner.err) };
  }
  const value = winner.value;
  let result: string;
  if (typeof value === "string") {
    result = value.slice(0, 300);
  } else if (value === undefined || value === null) {
    result = "done";
  } else {
    try {
      result = JSON.stringify(value).slice(0, 300);
    } catch {
      // Circular/exotic return values — degrade gracefully, never throw.
      result = String(value).slice(0, 300);
    }
  }
  return { ok: true, result };
}
