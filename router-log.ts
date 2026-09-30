/**
 * router-log.ts
 * -------------
 * The I/O half of Phase 1: where the record goes, and the few things the
 * router has to leave the module to find out. `prompt-router-core.ts` decides
 * what a record *means*; nothing here judges anything — the split
 * `portal_brasileirao` draws between `*-core.ts` and `*-api.ts`, for the same
 * reason: thresholds stay testable without a filesystem.
 *
 * Append-only JSONL, one object per prompt. JSONL rather than a database
 * because Phase 2 reads it with `jq`, re-scores it with a newer
 * `HEURISTICS_VERSION`, and slices it into an eval set — all of which are
 * easier on a text file than on rows.
 *
 * **The log holds your prompts in full by default**, because an eval set
 * cannot be built from hashes. It is written under `~/.claude/` and is
 * therefore outside this repository, but it is still plain text on disk: set
 * `PROMPT_ROUTER_LOG_TEXT=0` to keep only the hash and a 200-character
 * preview, and remember that anything pasted into a prompt — a key, a token, a
 * customer name — lands here too.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EFFORTS, type Effort, type Env, type RouterRecord } from "./prompt-router-core.ts";

/** Structurally what this module needs of the environment, so the module does
 *  not depend on `@types/node` being installed to read correctly. */
export type EnvVars = Readonly<Record<string, string | undefined>>;

export const DEFAULT_LOG_PATH = join(homedir(), ".claude", "prompt-router", "records.jsonl");

export const logPath = (env: EnvVars = process.env): string =>
  env.PROMPT_ROUTER_LOG?.trim() || DEFAULT_LOG_PATH;

/** Full prompt text unless explicitly switched off. `0`, `false` and `no` all
 *  turn it off, because a flag nobody can remember the spelling of is a flag
 *  that silently does the wrong thing. */
export const keepsText = (env: EnvVars = process.env): boolean =>
  !/^(?:0|false|no)$/i.test(env.PROMPT_ROUTER_LOG_TEXT?.trim() ?? "");

/** Advice is off by default: a hook that changes the session cannot honestly
 *  measure it. Turned on, it prints one line for the human, never for the
 *  model — `systemMessage`, not `additionalContext`. */
export const advises = (env: EnvVars = process.env): boolean =>
  /^(?:1|true|yes)$/i.test(env.PROMPT_ROUTER_ADVISE?.trim() ?? "");

const asEffort = (value: unknown): Effort | null =>
  typeof value === "string" && (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : null;

/**
 * Best-effort reading of the effort level the session is probably on. Claude
 * Code does not hand it to the hook, so this reads the global setting and may
 * be wrong for a session that changed it — which is exactly why the transcript
 * path is logged alongside: it is the authoritative record of what actually
 * ran, and Phase 2 joins on it.
 */
export const sessionEffort = (env: EnvVars = process.env): Effort | null => {
  const explicit = asEffort(env.PROMPT_ROUTER_EFFORT?.trim());
  if (explicit !== null) return explicit;
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")) as {
      effortLevel?: unknown;
    };
    return asEffort(settings.effortLevel);
  } catch {
    return null;
  }
};

/** No subprocess here on purpose. `git status` per prompt would add more
 *  latency than the whole hook currently costs, for a fact whose predictive
 *  value is unmeasured. Phase 2 can add it if the log says it is missing. */
export const gatherEnv = (env: EnvVars = process.env, now: Date = new Date()): Env => ({
  nowIso: now.toISOString(),
  model: env.ANTHROPIC_MODEL?.trim() || null,
  effort: sessionEffort(env),
});

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Appends one line. Creates the directory on first use so the hook works
 *  without any setup step beyond registering it. */
export const appendRecord = (record: RouterRecord, path: string = logPath()): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
};
