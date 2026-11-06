#!/usr/bin/env node
/**
 * stop-session-pending.ts
 * -----------------------
 * The `Stop` hook. When the model ends a turn by *declaring* that nothing is
 * pending, this blocks the stop once and tells it to run the `session-pending`
 * skill instead — to measure rather than recall.
 *
 * Register it in `~/.claude/settings.json` (absolute path — the hook runs with
 * the working directory of whatever project ended the turn; `Stop` takes no
 * matcher, so the gating lives in this file):
 *
 *   "Stop": [
 *     { "hooks": [{ "type": "command",
 *                   "command": "node /home/mpb/Documents/GitHub/ai_tools/stop-session-pending.ts",
 *                   "timeout": 5 }] }
 *   ]
 *
 * Run straight from TypeScript, no build step and no dependencies, like
 * `user-prompt-submit.ts`: Node strips the types itself. Erasable syntax only
 * — no enums, no namespaces, no parameter properties. This one imports
 * nothing, so it stays independent of the prompt router.
 *
 * **Why this one is allowed to change the session.**
 *
 * `user-prompt-submit.ts` never alters the conversation it measures. This hook
 * does the opposite on purpose, and the asymmetry is the point: that one runs
 * on *every* prompt and exists to observe, while this one runs only on a
 * specific false claim and exists to interrupt it. A wrong "nothing pending"
 * is the one answer that loses work in a checkout several sessions share, and
 * the moment the model is least willing to check is right after it has decided
 * it is done. So the trade is deliberate: a turn spent measuring, against a
 * window closed over someone else's uncommitted work.
 *
 * **Three rules this file keeps.**
 *
 * It never breaks the turn. Every path is wrapped and the exit code is always
 * 0. A malformed payload, an unreadable state dir, a regex that matched
 * nothing — all end the same way: silence, and the turn ends as it would have.
 *
 * It never blocks twice over. `stop_hook_active` is true on the continuation a
 * block caused, and that path returns at once; beyond that, `BLOCK_CAP` bounds
 * how many times one session can be interrupted this way. Claude Code has its
 * own cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, default 8) counting *all* hooks;
 * this one is per session and lower on purpose, because a hook that keeps
 * reopening a finished turn teaches the model to write around the regex.
 *
 * It stays scoped. `PROJECTS` lists the directories where the claim is costly
 * enough to be worth a turn. Everywhere else the hook exits without reading
 * anything.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

type StopPayload = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
};

/** Directories where a wrong "nothing pending" costs real work. */
const PROJECTS: string[] = ["/home/mpb/Documents/GitHub/star_wars"];

/** Interruptions allowed per session, over and above `stop_hook_active`. */
const BLOCK_CAP = 3;

const STATE_DIR = join(homedir(), ".claude", "state", "stop-session-pending");

/**
 * Shapes of the claim, not of the work. Each one asserts a *state of the
 * session* — finished, nothing left, published up to here — which is a claim
 * only a command can settle. Phrases about a single file or step ("o PDF está
 * atualizado") are deliberately absent: they are checkable on their face.
 */
const CLAIMS: RegExp[] = [
  /n[ãa]o h[áa] (?:mais )?(?:nada|nenhuma)\s+\S*\s*(?:pendente|pend[êe]ncia)/i,
  /nada (?:mais )?(?:est[áa] |ficou )?pendente/i,
  /nenhuma pend[êe]ncia/i,
  /(?:a )?tarefa (?:est[áa] |foi )?(?:completa|conclu[íi]da|finalizada)/i,
  /(?:o )?trabalho (?:est[áa] |foi )?(?:completo|conclu[íi]do|finalizado)/i,
  /publicad[oa]s? at[ée] [0-9a-f]{7,40}/i,
  /nothing (?:is |was )?(?:left|pending|outstanding)/i,
  /\ball done\b/i,
];

/**
 * The skill named in the message means the check is already on the table —
 * the model ran it, is reporting it, or is being asked about it. Blocking
 * then would interrupt the very answer the hook wants.
 */
const ALREADY = /session[- ]pending/i;

const REASON = [
  "Você terminou este turno afirmando que nada está pendente. Essa é a única",
  "afirmação que destrói trabalho quando está errada, e este checkout é",
  "compartilhado: outras sessões commitam, a árvore se move e o `HEAD` avança",
  "sem você.",
  "",
  "Antes de encerrar, invoque a skill `session-pending` (ferramenta Skill) e",
  "responda pelo que os comandos disserem agora — não pelo que você lembra de",
  "ter feito. Se a medição confirmar a afirmação, repita-a com a evidência",
  "(árvore, branch, `origin`, processos em segundo plano). Se não confirmar,",
  "diga o que encontrou.",
].join(" ").replace(/\s+/g, " ").trim();

const SYSTEM_MESSAGE =
  "stop-session-pending: declaração de 'nada pendente' interceptada — pedindo a medição.";

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

/** Only `[A-Za-z0-9_-]`, so a session id can never walk out of the state dir. */
const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "");

const projects = (): string[] => {
  const override = process.env.STOP_PENDING_PROJECTS;
  if (!override) return PROJECTS;
  if (override.trim() === "*") return [];
  return override.split(":").filter((p) => p.length > 0);
};

const inScope = (cwd: string): boolean => {
  const allowed = projects();
  if (allowed.length === 0) return true;
  const here = resolve(cwd);
  return allowed.some((p) => {
    const root = resolve(p);
    return here === root || here.startsWith(root + sep);
  });
};

const cap = (): number => {
  const raw = process.env.STOP_PENDING_BLOCK_CAP;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : BLOCK_CAP;
};

/** Returns the count *before* this block, having recorded this one. */
const takeBlock = (sessionId: string): number => {
  const file = join(STATE_DIR, `${sessionId}.count`);
  let seen = 0;
  try {
    seen = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    if (!Number.isFinite(seen) || seen < 0) seen = 0;
  } catch {
    seen = 0;
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(file, String(seen + 1), "utf8");
  } catch {
    /* unwritable state is not a reason to break the turn */
  }
  return seen;
};

const log = (record: Record<string, unknown>): void => {
  if (process.env.STOP_PENDING_LOG !== "1") return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(
      join(STATE_DIR, "log.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n",
      "utf8",
    );
  } catch {
    /* logging is opt-in and never load-bearing */
  }
};

const main = async (): Promise<void> => {
  const raw = await readStdin();
  let payload: StopPayload;
  try {
    payload = JSON.parse(raw) as StopPayload;
  } catch {
    log({ skip: "unparseable payload" });
    return;
  }

  if (payload.stop_hook_active === true) return log({ skip: "stop_hook_active" });

  const cwd = payload.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (!inScope(cwd)) return log({ skip: "out of scope", cwd });

  const message = payload.last_assistant_message ?? "";
  if (message.length === 0) return log({ skip: "no message" });
  if (ALREADY.test(message)) return log({ skip: "skill already named" });

  const hit = CLAIMS.find((claim) => claim.test(message));
  if (hit === undefined) return log({ skip: "no claim" });

  const sessionId = safeId(payload.session_id ?? "");
  const limit = cap();
  if (sessionId.length > 0 && limit > 0) {
    const seen = takeBlock(sessionId);
    if (seen >= limit) {
      return log({ skip: "cap reached", seen, limit, session: sessionId });
    }
  } else if (limit === 0) {
    return log({ skip: "cap disabled" });
  }

  log({ blocked: true, claim: hit.source, session: sessionId, cwd });
  process.stdout.write(
    JSON.stringify({ decision: "block", reason: REASON, systemMessage: SYSTEM_MESSAGE }),
  );
};

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
