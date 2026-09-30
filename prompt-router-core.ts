/**
 * prompt-router-core.ts
 * ---------------------
 * Phase 1 of the prompt router: take a Claude Code `UserPromptSubmit` payload,
 * compute facts in code, classify with heuristics only, and build the record
 * that `router-log.ts` appends.
 *
 * **No model is called in Phase 1 — not Claude, not Jev.** The phase exists to
 * produce the ground truth that Phase 2 needs before a model-backed judge can
 * be argued for: without a log of real prompts, the decisions actually taken,
 * and what the heuristics would have said, any threshold is guesswork. This is
 * the division the sibling projects already settled on — `triagem_vagas`
 * states it outright ("o ponto não é o fluxo, é a medição") and the Jev
 * prototype in `portal_brasileirao` measured itself against zero-cost rules
 * before anybody wired it in, and found the rules still winning.
 *
 * Pure, like every `*-core.ts` in `portal_brasileirao`: no network, no clock,
 * no filesystem, no `process.env`. Everything from outside arrives as an
 * argument, so the thresholds below are unit-testable against fixed inputs.
 * `tests/prompt-router-core.test.ts` enforces that by reading this source.
 *
 * The heuristics are bilingual on purpose: prompts here are written in
 * pt-BR and English interchangeably, and a router that only reads English
 * would mis-score half of them.
 */

/** Bumped whenever a threshold or pattern changes, and written into every
 *  record: a log that cannot say which rules produced it cannot be re-scored
 *  later, which is the whole point of keeping it. */
export const HEURISTICS_VERSION = "1.0.0";

/** ~3.5 characters per token, the ratio the Jev cost note in
 *  `portal_brasileirao/.claude/worktrees/typesafe-highlights/docs/jev.md`
 *  used for the same kind of estimate. An estimate, not a count: the real
 *  number comes from `messages.count_tokens`, which needs the network. */
export const CHARS_PER_TOKEN = 3.5;

/**
 * Where a heuristic reading stops counting as settled. Starting points, not
 * results — Phase 2 tunes them against the log this phase writes. One
 * constant per line so a sweep edits one line.
 */
export const THRESHOLDS = {
  /** Below this classifier confidence the decision is the session default.
   *  Failing toward the *capable* model is deliberate: a cheap route that
   *  needs a retry costs more than the expensive one taken once. */
  minConfidence: 0.35,
  /** At or above this, a prompt counts as needing judgment rather than
   *  mechanical application of a stated rule. */
  needsJudgment: 0.6,
  /** At or above this, the prompt omits something needed to act — which
   *  predicts retries better than difficulty does, so it raises effort. */
  underspecified: 0.6,
  /** Estimated tokens above which a prompt counts as long. */
  longPrompt: 220,
  /** Estimated tokens below which a prompt counts as terse. */
  tersePrompt: 15,
} as const;

/** The model that stays in the interactive session. Routing a conversation to
 *  a cheaper model mid-flight forfeits the prompt cache, which is model-scoped
 *  and is what actually dominates the bill in a Claude Code session. */
export const DEFAULT_MODEL = "claude-opus-5";
/** Used only when the payload does not say what the session is already on. */
export const DEFAULT_EFFORT: Effort = "high";
/** Suggested targets for work that leaves the session entirely. Suggestions
 *  recorded in the log — Phase 1 dispatches nothing. */
export const CHEAP_MODEL = "claude-haiku-4-5";
export const MID_MODEL = "claude-sonnet-5";

export type TaskKind =
  | "code_edit"
  | "code_read"
  | "debug"
  | "design"
  | "bulk"
  | "mechanical"
  | "ops"
  | "meta"
  | "other";

export const TASK_KINDS: readonly TaskKind[] = [
  "code_edit",
  "code_read",
  "debug",
  "design",
  "bulk",
  "mechanical",
  "ops",
  "meta",
  "other",
];

export type Effort = "low" | "medium" | "high" | "xhigh";
/** `max` is absent on purpose: no heuristic here has evidence strong enough to
 *  ask for the most expensive setting. That has to be earned in Phase 2. */
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"];

export type Route =
  /** Answer here, in the session, on the session's model. */
  | "in_session"
  /** Well-bounded one-shot or bulk work: `claude -p --model <cheap>`. */
  | "headless_cheap"
  /** Deterministic enough that a script beats a model. */
  | "deterministic_script"
  /** Per-item judgment over an external list with stored credentials — the
   *  shape the live `triagem_vagas` n8n webhook already serves. */
  | "n8n_webhook";

/** The `UserPromptSubmit` stdin payload. Every field is `unknown`: this
 *  arrives from outside the module and is parsed, never trusted. */
export interface HookPayload {
  readonly prompt?: unknown;
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly transcript_path?: unknown;
  readonly hook_event_name?: unknown;
}

/** What the caller had to leave the module to find out. */
export interface Env {
  readonly nowIso: string;
  /** Model in use at submit time when the environment says so, else `null`.
   *  The authoritative answer lives in the transcript, whose path is logged. */
  readonly model: string | null;
  readonly effort: Effort | null;
}

export interface Facts {
  readonly chars: number;
  readonly words: number;
  readonly lines: number;
  readonly estTokens: number;
  readonly codeFences: number;
  readonly inlineCode: number;
  readonly paths: number;
  readonly urls: number;
  readonly listItems: number;
  readonly questions: number;
  readonly conjunctions: number;
  readonly language: "pt" | "en" | "mixed" | "unknown";
  readonly hasStackTrace: boolean;
  /** A bare "isso" / "this" / "it" with nothing in the prompt to bind it to. */
  readonly danglingReference: boolean;
  readonly slashCommand: string | null;
}

export interface Classification {
  readonly taskKind: TaskKind;
  readonly kindScores: Readonly<Record<TaskKind, number>>;
  /** Whether the prompt asks for the same work over many items. Orthogonal to
   *  `taskKind` — a batch of judgments is still judgment — so it is a flag
   *  rather than a competing kind, and it is what selects a batch route. */
  readonly isBulk: boolean;
  /** 1 trivial · 2 routine · 3 hard · 4 research-grade. */
  readonly difficulty: 1 | 2 | 3 | 4;
  readonly needsJudgment: number;
  readonly underspecified: number;
  readonly confidence: number;
  readonly reasons: readonly string[];
}

export interface Decision {
  readonly effort: Effort;
  readonly model: string;
  readonly route: Route;
  readonly confidence: number;
  /** True when confidence was too low to say anything and the session default
   *  was kept. A high fallback rate is itself a Phase 2 finding. */
  readonly fellBack: boolean;
  readonly why: readonly string[];
}

export interface RouterRecord {
  readonly v: string;
  readonly ts: string;
  readonly session: string | null;
  readonly cwd: string | null;
  readonly transcript: string | null;
  readonly actual: { readonly model: string | null; readonly effort: Effort | null };
  readonly prompt: {
    readonly sha256: string;
    readonly chars: number;
    readonly estTokens: number;
    readonly text: string | null;
    readonly preview: string;
  };
  readonly facts: Facts;
  readonly classification: Classification;
  readonly decision: Decision;
}

/* ------------------------------------------------------------------ parsing */

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Lowercased and stripped of diacritics, so one pattern matches "avaliação",
 *  "avaliacao" and "AVALIAÇÃO" without three alternatives. */
export const normalize = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const count = (text: string, pattern: RegExp): number =>
  (text.match(pattern) ?? []).length;

/* -------------------------------------------------------------------- facts */

const PATH_RE = /(?:^|[\s(`'"])(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|mjs|json|md|py|sh|yml|yaml|sql|html|css)\b/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
const STACK_RE = /\b(?:at\s+\w+\s+\(|traceback \(most recent call last\)|stack ?trace|\w+error:|exception in)/i;
const DANGLING_RE = /(?:^|\s)(?:isso|aquilo|esse|essa|isto|it|this|that|dele|dela)(?:\s|[.,;:!?]|$)/;

// Function words, not content words: a prompt about code shares its nouns
// across languages, so only the grammar tells them apart. Ambiguous forms
// ("a", "e", "no") are left out — they belong to both.
const PT_MARKERS = /\b(?:de|do|da|dos|das|em|no|na|nos|nas|os|as|um|uma|para|pra|com|que|nao|mais|como|isso|esse|essa|ao|pelo|pela|sem|ja|voce|quero|preciso)\b/g;
const EN_MARKERS = /\b(?:the|of|to|is|in|for|with|and|this|that|should|would|make|does|about|need|want|into|from|are|was|it|on)\b/g;

export const readFacts = (prompt: string): Facts => {
  const text = prompt.trim();
  const flat = normalize(text);
  const pt = count(flat, PT_MARKERS);
  const en = count(flat, EN_MARKERS);

  const language: Facts["language"] =
    pt === 0 && en === 0
      ? "unknown"
      : pt > 0 && en > 0 && Math.min(pt, en) / Math.max(pt, en) > 0.4
        ? "mixed"
        : pt > en
          ? "pt"
          : "en";

  const paths = count(text, PATH_RE);
  const urls = count(text, URL_RE);
  const codeFences = Math.floor(count(text, /```/g) / 2);
  // A query string is not a question. Counting `?` over the raw text made
  // every pasted search URL look like an unanswered one and nudged the
  // prompt toward `underspecified`.
  const prose = text.replace(URL_RE, " ");

  return {
    chars: text.length,
    words: text.length === 0 ? 0 : text.split(/\s+/).length,
    lines: text.length === 0 ? 0 : text.split("\n").length,
    estTokens: Math.round(text.length / CHARS_PER_TOKEN),
    codeFences,
    inlineCode: count(text, /`[^`\n]+`/g),
    paths,
    urls,
    listItems: count(text, /^\s*(?:[-*+]|\d+[.)])\s+/gm),
    questions: count(prose, /\?/g),
    conjunctions: count(flat, /\b(?:and|e|also|tambem|depois|then|plus|alem de)\b/g),
    language,
    hasStackTrace: STACK_RE.test(text),
    danglingReference: DANGLING_RE.test(flat) && paths === 0 && urls === 0 && codeFences === 0,
    slashCommand: /^\/[a-z][\w:-]*/.exec(text)?.[0] ?? null,
  };
};

/* ----------------------------------------------------------- classification */

/** One entry per kind. Scores are counts of *distinct* patterns matched, not
 *  of occurrences: repeating a word does not make a prompt more of its kind. */
const KIND_PATTERNS: Readonly<Record<Exclude<TaskKind, "other">, readonly RegExp[]>> = {
  debug: [
    /\b(?:bug|erro|error|falh\w*|exception|crash|quebrou|regress(?:ao|ion))\b/,
    /\b(?:nao funciona|not working|fail(?:ing|ed|s)?|flaky|intermitente)\b/,
    /\b(?:stack ?trace|traceback|investig\w*|debug\w*|depur\w*|por que|why is)\b/,
  ],
  design: [
    /\b(?:arquitetura|architecture|design|desenho|tradeoffs?|trade-offs?)\b/,
    /\b(?:avali\w*|assess|compar\w*|decid\w*|decide|escolh\w*|recomend\w*)\b/,
    /\b(?:melhor (?:abordagem|stack|forma|jeito|caminho|modelo)|best (?:approach|stack|way))\b/,
    /\b(?:vale a pena|worth it|estrategia|strategy|plano|planej\w*|planning|roadmap)\b/,
  ],
  bulk: [
    /\b(?:todos os|todas as|cada|for each|para cada|em lote|lote|batch|bulk)\b/,
    /\b(?:all (?:the )?(?:files|rows|items|records)|varr\w*|sweep|percorr\w*)\b/,
    /\b(?:\d{2,}\s+(?:arquivos|files|vagas|itens|items|linhas|rows))\b/,
  ],
  mechanical: [
    /\b(?:renome\w*|rename|format\w*|lint|prettier|reindent|padroniz\w*)\b/,
    /\b(?:typo|bump|atualizar a versao|version bump|mov\w*|move)\b/,
    /\b(?:adicionar (?:um )?coment|add a comment|remover (?:o )?coment)\b/,
  ],
  ops: [
    /\b(?:deploy\w*|docker|compose|systemctl|nginx|ssh|cron|pm2)\b/,
    /\b(?:pipeline|workflow|github actions|ci\b|cd\b)\b/,
    /\b(?:commit|push|merge|rebase|branch|tag|release)\b/,
  ],
  code_edit: [
    /\b(?:implement\w*|cri(?:ar|e|a|ando)|create|escrev\w*|write|construir|build)\b/,
    /\b(?:adicion\w*|refator\w*|refactor|corrig\w*|fix|ajust\w*)\b/,
    /\b(?:migr\w*|migrate|port(?:ar|e)|extra(?:ir|i)|extract)\b/,
  ],
  code_read: [
    /\b(?:explic\w*|explain|como funciona|how does|entend\w*|understand)\b/,
    /\b(?:o que (?:e|faz|significa)|what (?:is|does)|onde (?:esta|fica)|where is)\b/,
    /\b(?:resum\w*|summar(?:y|ize)|analis\w*|analyze|review|revis\w*|ler|read)\b/,
  ],
  meta: [
    /\b(?:claude code|claude desktop|hook|skill|subagent|mcp|slash command)\b/,
    /\b(?:settings\.json|claude\.md|context\.md|output style|permiss(?:ao|oes))\b/,
  ],
};

const JUDGMENT_PATTERNS: readonly RegExp[] = [
  /\b(?:avali\w*|assess|compar\w*|decid\w*|decide|escolh\w*|choose|julg\w*)\b/,
  /\b(?:melhor|best|vale a pena|worth|tradeoffs?|trade-offs?|prefer\w*)\b/,
  /\b(?:deveria|should (?:i|we)|faz sentido|makes sense|recomend\w*|opini(?:ao|on))\b/,
  /\b(?:arquitetura|architecture|estrategia|strategy|design|abordagem|approach)\b/,
];

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const scoreKinds = (flat: string): Record<TaskKind, number> => {
  const scores = Object.fromEntries(TASK_KINDS.map((kind) => [kind, 0])) as Record<TaskKind, number>;
  for (const [kind, patterns] of Object.entries(KIND_PATTERNS)) {
    scores[kind as TaskKind] = patterns.filter((pattern) => pattern.test(flat)).length;
  }
  return scores;
};

export const classify = (facts: Facts, prompt: string): Classification => {
  const flat = normalize(prompt);
  const reasons: string[] = [];
  const kindScores = scoreKinds(flat);

  // A slash command is the tooling being driven directly; nothing to route.
  if (facts.slashCommand !== null) {
    kindScores.meta += 2;
    reasons.push(`slash command ${facts.slashCommand}`);
  }
  if (facts.hasStackTrace) {
    kindScores.debug += 1;
    reasons.push("stack trace pasted");
  }

  const ranked = TASK_KINDS.filter((kind) => kind !== "bulk")
    .map((kind) => ({ kind, score: kindScores[kind] }))
    .sort((a, b) => b.score - a.score);
  const [top, second] = ranked;
  const taskKind: TaskKind = top.score === 0 ? "other" : top.kind;
  if (taskKind !== "other") reasons.push(`kind ${taskKind} (${top.score})`);
  const isBulk = kindScores.bulk > 0;
  if (isBulk) reasons.push(`bulk (${kindScores.bulk})`);

  const matchedJudgment = JUDGMENT_PATTERNS.filter((pattern) => pattern.test(flat)).length;
  let needsJudgment = matchedJudgment / JUDGMENT_PATTERNS.length;
  if (taskKind === "design") needsJudgment += 0.3;
  if (taskKind === "mechanical") needsJudgment -= 0.3;
  needsJudgment = clamp01(needsJudgment);

  let underspecified = 0;
  if (facts.danglingReference) {
    underspecified += 0.4;
    reasons.push("unbound reference, no path or code");
  }
  if (facts.estTokens < THRESHOLDS.tersePrompt) {
    underspecified += 0.3;
    reasons.push("terse");
  }
  if (facts.questions > 0 && facts.paths === 0) underspecified += 0.2;
  if (facts.paths > 0 || facts.codeFences > 0) underspecified -= 0.3;
  underspecified = clamp01(underspecified);

  let difficulty = 2;
  const long = facts.estTokens > THRESHOLDS.longPrompt;
  const manyRequirements = facts.listItems >= 3 || facts.conjunctions >= 3;
  if (long || manyRequirements) {
    difficulty += 1;
    reasons.push(long ? "long prompt" : "several requirements");
  }
  if (taskKind === "design" || needsJudgment >= THRESHOLDS.needsJudgment) difficulty += 1;
  if (taskKind === "mechanical" && facts.estTokens < 40) difficulty -= 1;
  if (taskKind === "meta" && !long) difficulty -= 1;
  difficulty = Math.min(4, Math.max(1, difficulty));

  // Confidence is the shape of the kind distribution, the way TypeSafe's own
  // confidence is described: one dominant option -> near 1, everything spread
  // out -> near 0. It is not a probability that the reading is right.
  const margin = top.score === 0 ? 0 : (top.score - second.score) / (top.score + second.score);
  const evidence = clamp01((top.score + kindScores.bulk + matchedJudgment) / 4);
  const confidence = facts.chars < 5 ? 0 : clamp01(margin * 0.6 + evidence * 0.4);

  return {
    taskKind,
    kindScores,
    isBulk,
    difficulty: difficulty as 1 | 2 | 3 | 4,
    needsJudgment: Math.round(needsJudgment * 100) / 100,
    underspecified: Math.round(underspecified * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    reasons,
  };
};

/* ----------------------------------------------------------------- decision */

const EFFORT_BY_DIFFICULTY: Readonly<Record<1 | 2 | 3 | 4, Effort>> = {
  1: "low",
  2: "medium",
  3: "high",
  4: "xhigh",
};

const raise = (effort: Effort): Effort => EFFORTS[Math.min(EFFORTS.length - 1, EFFORTS.indexOf(effort) + 1)];
const atLeast = (effort: Effort, floor: Effort): Effort =>
  EFFORTS.indexOf(effort) < EFFORTS.indexOf(floor) ? floor : effort;

export const decide = (classification: Classification, facts: Facts, env: Env): Decision => {
  const sessionEffort = env.effort ?? DEFAULT_EFFORT;
  const why: string[] = [];

  if (classification.confidence < THRESHOLDS.minConfidence) {
    return {
      effort: sessionEffort,
      model: env.model ?? DEFAULT_MODEL,
      route: "in_session",
      confidence: classification.confidence,
      fellBack: true,
      why: [`confidence ${classification.confidence} below ${THRESHOLDS.minConfidence}; kept session default`],
    };
  }

  let effort = EFFORT_BY_DIFFICULTY[classification.difficulty];
  why.push(`difficulty ${classification.difficulty} -> ${effort}`);

  // Ambiguity is what makes a turn come back for a second try, and a retry
  // costs more than the level it was trying to save.
  if (classification.underspecified >= THRESHOLDS.underspecified) {
    effort = atLeast(raise(effort), "medium");
    why.push(`underspecified ${classification.underspecified} -> raised to ${effort}`);
  }

  const { taskKind, isBulk, needsJudgment } = classification;
  const mechanicalBulk = isBulk && needsJudgment < THRESHOLDS.needsJudgment;
  const perItemJudgment = isBulk && facts.urls > 0 && needsJudgment >= 0.5;

  let route: Route = "in_session";
  let model = env.model ?? DEFAULT_MODEL;

  if (perItemJudgment) {
    route = "n8n_webhook";
    model = DEFAULT_MODEL;
    why.push("per-item judgment over an external list: the shape triagem_vagas already serves");
  } else if (mechanicalBulk) {
    route = "headless_cheap";
    model = CHEAP_MODEL;
    why.push("bulk without judgment: cheaper model outside the session");
  } else if (isBulk) {
    route = "headless_cheap";
    model = MID_MODEL;
    why.push("bulk needing judgment: mid model outside the session");
  } else if (taskKind === "mechanical" && classification.difficulty === 1) {
    route = "deterministic_script";
    why.push("mechanical and trivial: a script beats a model");
  }

  return {
    effort,
    model,
    route,
    confidence: classification.confidence,
    fellBack: false,
    why,
  };
};

/* ------------------------------------------------------------------- record */

export const previewOf = (prompt: string, limit = 200): string =>
  prompt.length <= limit ? prompt : `${prompt.slice(0, limit)}…`;

/**
 * Assembles the log line. `sha256` and `keepText` are arguments rather than
 * work done here: hashing needs `node:crypto` and the choice of whether the
 * prompt text is kept is the caller's policy, not this module's.
 */
export const buildRecord = (
  payload: HookPayload,
  env: Env,
  sha256: string,
  keepText: boolean,
): RouterRecord => {
  const prompt = asString(payload.prompt) ?? "";
  const facts = readFacts(prompt);
  const classification = classify(facts, prompt);

  return {
    v: HEURISTICS_VERSION,
    ts: env.nowIso,
    session: asString(payload.session_id),
    cwd: asString(payload.cwd),
    transcript: asString(payload.transcript_path),
    actual: { model: env.model, effort: env.effort },
    prompt: {
      sha256,
      chars: facts.chars,
      estTokens: facts.estTokens,
      text: keepText ? prompt : null,
      preview: previewOf(prompt),
    },
    facts,
    classification,
    decision: decide(classification, facts, env),
  };
};

/** The one line a human sees when advice is switched on. Phase 1 defaults to
 *  silence: a hook that changes what the session does cannot measure it. */
export const adviceLine = (record: RouterRecord): string => {
  const { decision, classification } = record;
  if (decision.fellBack) return `router: no reading (confidence ${decision.confidence})`;
  const route = decision.route === "in_session" ? "here" : decision.route;
  return `router: ${classification.taskKind} · effort ${decision.effort} · ${route} · ${decision.model} (confidence ${decision.confidence})`;
};
