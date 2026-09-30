#!/usr/bin/env node
/**
 * user-prompt-submit.ts
 * ---------------------
 * The `UserPromptSubmit` hook. Reads the payload Claude Code writes to stdin,
 * classifies the prompt with `prompt-router-core.ts`, appends one JSONL record
 * through `router-log.ts`, and prints hook output.
 *
 * Register it in `~/.claude/settings.json` (absolute path — the hook runs with
 * the working directory of whatever project submitted the prompt):
 *
 *   "UserPromptSubmit": [
 *     { "hooks": [{ "type": "command",
 *                   "command": "node /home/mpb/Documents/GitHub/ai_tools/user-prompt-submit.ts",
 *                   "timeout": 5 }] }
 *   ]
 *
 * Run straight from TypeScript, no build step and no dependencies: Node strips
 * the types itself (stable since Node 23; measured here at ~40 ms per
 * invocation on Node 26, against ~10 ms for plain JS). That is why this file
 * and the modules it imports use erasable syntax only — no enums, no
 * namespaces, no parameter properties — and import each other with the `.ts`
 * extension. A `tsx` loader would work too, but `--import tsx` resolves
 * against the submitting project's `node_modules`, which is not this one.
 *
 * **Two rules this file exists to keep.**
 *
 * It never fails the prompt. Every path is wrapped and the exit code is always
 * 0: a router that can block your own typing is worse than no router.
 *
 * It never changes the session. Phase 1 prints nothing to the model — no
 * `additionalContext` — because a hook that alters the conversation it is
 * measuring corrupts the measurement it exists to produce. Advice is opt-in
 * (`PROMPT_ROUTER_ADVISE=1`) and goes to `systemMessage`, which the human sees
 * and the model does not.
 */
import { buildRecord, adviceLine, type HookPayload } from "./prompt-router-core.ts";
import { advises, appendRecord, gatherEnv, keepsText, sha256 } from "./router-log.ts";

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
};

const parsePayload = (raw: string): HookPayload => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
};

const main = async (): Promise<void> => {
  const dryRun = process.argv.includes("--dry-run");
  const payload = parsePayload(await readStdin());
  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";

  // Nothing submitted means nothing to measure; a blank record would only
  // dilute the log Phase 2 reads.
  if (prompt.trim().length === 0) {
    process.stdout.write("{}\n");
    return;
  }

  const record = buildRecord(payload, gatherEnv(), sha256(prompt), keepsText());

  if (dryRun) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }

  appendRecord(record);
  process.stdout.write(advises() ? `${JSON.stringify({ systemMessage: adviceLine(record) })}\n` : "{}\n");
};

void main()
  .catch((error: unknown) => {
    // Reported to the human, never to the model, and never as a failure: a
    // broken router must cost the session nothing but this line.
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ systemMessage: `prompt-router: ${message}` })}\n`);
  })
  .finally(() => {
    process.exitCode = 0;
  });
