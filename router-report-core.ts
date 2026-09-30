/**
 * router-report-core.ts
 * ---------------------
 * Turns the JSONL that `router-log.ts` appends into the distribution Phase 2
 * reads. Pure: parsing, arithmetic and rendering only — `scripts/router-report.ts`
 * does the reading. `tests/` enforces that by grepping this source, as it does
 * for `prompt-router-core.ts`.
 *
 * Two things this report is built to answer, because they are what decides
 * whether Phase 2 is worth starting:
 *
 * 1. **How often does the classifier say nothing?** A high `fellBack` rate
 *    means the heuristics are a no-op on real traffic, and no threshold tuning
 *    fixes that — it is a finding about the approach.
 * 2. **Would the router have changed anything?** A recommendation that always
 *    matches the session's existing settings saves nothing, however confident
 *    it is.
 *
 * It reads records **defensively**. The log spans rule versions and will
 * outlive this file's assumptions, so every field is extracted from `unknown`
 * and an unreadable line is counted rather than thrown. And it never pools
 * `HEURISTICS_VERSION`s silently: records written under different rules are
 * different populations, and the report says so where they are mixed.
 */

/** The projection of a record this report needs. Deliberately flat and all
 *  primitives: it is a reading of whatever is on disk, not the record type. */
export interface Row {
  readonly v: string;
  readonly ts: string;
  readonly cwd: string | null;
  readonly estTokens: number;
  readonly language: string;
  readonly taskKind: string;
  readonly difficulty: number;
  readonly confidence: number;
  readonly isBulk: boolean;
  readonly effort: string;
  readonly route: string;
  readonly model: string;
  readonly fellBack: boolean;
  readonly actualEffort: string | null;
  readonly actualModel: string | null;
  readonly preview: string;
}

export interface Tally {
  readonly label: string;
  readonly count: number;
  readonly share: number;
}

export interface Summary {
  readonly total: number;
  readonly malformed: number;
  readonly first: string | null;
  readonly last: string | null;
  readonly versions: readonly Tally[];
  readonly fellBack: number;
  /** Records where the recommendation differs from what the session was on:
   *  a route out of the session, or an effort other than the session's. */
  readonly wouldChange: number;
  /** Records whose `actual.effort` was unknown, so no comparison was possible. */
  readonly effortUnknown: number;
  readonly routes: readonly Tally[];
  readonly efforts: readonly Tally[];
  readonly kinds: readonly Tally[];
  readonly difficulties: readonly Tally[];
  readonly confidences: readonly Tally[];
  readonly languages: readonly Tally[];
  readonly projects: readonly Tally[];
  readonly bulk: number;
  readonly tokens: {
    readonly min: number;
    readonly median: number;
    readonly p90: number;
    readonly max: number;
  };
  /** The confident recommendations to leave the session — the ones worth
   *  eyeballing before anything is wired to act on them. */
  readonly routed: readonly Row[];
  /** A sample of what the heuristics could not read. This is the Phase 2
   *  worklist: if a judge is ever justified, it is justified here. */
  readonly unread: readonly Row[];
}

/* ------------------------------------------------------------------ reading */

const str = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;
const strOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * Reads one parsed line into a `Row`, or `null` when it is not a record at
 * all. A record missing a field it should have is still counted — losing the
 * whole line over one absent key would quietly shrink the population.
 */
export const readRow = (value: unknown): Row | null => {
  const record = obj(value);
  if (strOrNull(record.ts) === null) return null;

  const prompt = obj(record.prompt);
  const facts = obj(record.facts);
  const classification = obj(record.classification);
  const decision = obj(record.decision);
  const actual = obj(record.actual);

  return {
    v: str(record.v, "unknown"),
    ts: str(record.ts, ""),
    cwd: strOrNull(record.cwd),
    estTokens: num(prompt.estTokens, 0),
    language: str(facts.language, "unknown"),
    taskKind: str(classification.taskKind, "unknown"),
    difficulty: num(classification.difficulty, 0),
    confidence: num(decision.confidence, num(classification.confidence, 0)),
    isBulk: classification.isBulk === true,
    effort: str(decision.effort, "unknown"),
    route: str(decision.route, "unknown"),
    model: str(decision.model, "unknown"),
    fellBack: decision.fellBack === true,
    actualEffort: strOrNull(actual.effort),
    actualModel: strOrNull(actual.model),
    preview: str(prompt.preview, ""),
  };
};

/** Parses JSONL. Blank lines are skipped; anything unreadable is counted, not
 *  thrown — a truncated last line is normal in a file being appended to. */
export const readRows = (text: string): { rows: Row[]; malformed: number } => {
  const rows: Row[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const row = readRow(parsed);
    if (row === null) malformed += 1;
    else rows.push(row);
  }
  return { rows, malformed };
};

/* -------------------------------------------------------------- arithmetic */

/** Nearest-rank percentile on an ascending array. `p` in [0, 1]. */
export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
};

const tally = (values: readonly string[]): Tally[] => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count, share: count / values.length }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

/** Confidence in fifths. Buckets rather than a mean, because the interesting
 *  question is how much of the traffic sits at the bottom, not the average. */
export const confidenceBucket = (confidence: number): string => {
  if (confidence <= 0) return "0.0 (no reading)";
  const lower = Math.min(0.8, Math.floor(confidence * 5) / 5);
  return `${lower.toFixed(1)}-${(lower + 0.2).toFixed(1)}`;
};

const basename = (path: string | null): string =>
  path === null ? "(unknown)" : (path.split("/").filter((part) => part.length > 0).pop() ?? path);

export const summarize = (rows: readonly Row[], malformed = 0, sample = 5): Summary => {
  const stamps = rows.map((row) => row.ts).sort();
  const tokens = rows.map((row) => row.estTokens).sort((a, b) => a - b);

  // Unknown actual effort is not agreement. Counting it as "changed nothing"
  // would flatter the router with records that prove nothing either way.
  const comparable = rows.filter((row) => row.actualEffort !== null);
  const wouldChange = rows.filter(
    (row) => row.route !== "in_session" || (row.actualEffort !== null && row.effort !== row.actualEffort),
  ).length;

  return {
    total: rows.length,
    malformed,
    first: stamps[0] ?? null,
    last: stamps[stamps.length - 1] ?? null,
    versions: tally(rows.map((row) => row.v)),
    fellBack: rows.filter((row) => row.fellBack).length,
    wouldChange,
    effortUnknown: rows.length - comparable.length,
    routes: tally(rows.map((row) => row.route)),
    efforts: tally(rows.map((row) => row.effort)),
    kinds: tally(rows.map((row) => row.taskKind)),
    difficulties: tally(rows.map((row) => String(row.difficulty))),
    confidences: tally(rows.map((row) => confidenceBucket(row.confidence))),
    languages: tally(rows.map((row) => row.language)),
    projects: tally(rows.map((row) => basename(row.cwd))),
    bulk: rows.filter((row) => row.isBulk).length,
    tokens: {
      min: tokens[0] ?? 0,
      median: percentile(tokens, 0.5),
      p90: percentile(tokens, 0.9),
      max: tokens[tokens.length - 1] ?? 0,
    },
    routed: rows
      .filter((row) => row.route !== "in_session")
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, sample),
    unread: rows.filter((row) => row.fellBack).slice(-sample),
  };
};

/* --------------------------------------------------------------- rendering */

const pct = (share: number): string => `${Math.round(share * 100)}%`;
const bar = (share: number, width = 24): string =>
  "█".repeat(Math.round(share * width)).padEnd(width, "·");

/** Column width comes from the labels, not a guess: a long project directory
 *  name (`sampa2_graphics_terminal`) pushed every other column out of line
 *  when this was a fixed 18. */
const block = (title: string, tallies: readonly Tally[]): string[] => {
  const width = Math.max(10, ...tallies.map((entry) => entry.label.length));
  return [
    "",
    title,
    ...tallies.map(
      (entry) =>
        `  ${entry.label.padEnd(width)} ${String(entry.count).padStart(5)}  ${pct(entry.share).padStart(4)}  ${bar(entry.share)}`,
    ),
  ];
};

export const renderReport = (summary: Summary): string => {
  if (summary.total === 0) {
    return `No records${summary.malformed > 0 ? ` (${summary.malformed} unreadable lines)` : ""}. The hook has not logged anything yet.`;
  }

  const lines: string[] = [
    `prompt router — ${summary.total} records, ${summary.first?.slice(0, 10)} to ${summary.last?.slice(0, 10)}`,
  ];
  if (summary.malformed > 0) lines.push(`  ${summary.malformed} unreadable line(s), skipped`);

  if (summary.versions.length > 1) {
    lines.push(
      "",
      `!! ${summary.versions.length} heuristics versions mixed (${summary.versions.map((entry) => `${entry.label}: ${entry.count}`).join(", ")}).`,
      "   These are different populations. Do not tune thresholds across them —",
      "   re-score the older records or report each version on its own.",
    );
  }

  lines.push(
    "",
    "the two numbers that decide Phase 2",
    `  no reading (fell back)   ${String(summary.fellBack).padStart(5)}  ${pct(summary.fellBack / summary.total).padStart(4)}  ${bar(summary.fellBack / summary.total)}`,
    `  would change something   ${String(summary.wouldChange).padStart(5)}  ${pct(summary.wouldChange / summary.total).padStart(4)}  ${bar(summary.wouldChange / summary.total)}`,
  );
  if (summary.effortUnknown > 0) {
    lines.push(
      `  (${summary.effortUnknown} record(s) had no known session effort, so only the route could differ)`,
    );
  }

  lines.push(
    ...block("route", summary.routes),
    ...block("recommended effort", summary.efforts),
    ...block("task kind", summary.kinds),
    ...block("difficulty", summary.difficulties),
    ...block("confidence", summary.confidences),
    ...block("language", summary.languages),
    ...block("project", summary.projects),
    "",
    `prompt size (estimated tokens)  min ${summary.tokens.min} · median ${summary.tokens.median} · p90 ${summary.tokens.p90} · max ${summary.tokens.max}`,
    `bulk flagged                    ${summary.bulk}`,
  );

  if (summary.routed.length > 0) {
    lines.push("", "confident recommendations to leave the session (check these by hand)");
    for (const row of summary.routed) {
      lines.push(`  ${row.confidence.toFixed(2)}  ${row.route.padEnd(20)} ${row.model.padEnd(17)} ${row.preview.slice(0, 48)}`);
    }
  }

  if (summary.unread.length > 0) {
    lines.push("", "latest prompts the heuristics could not read (the Phase 2 worklist)");
    for (const row of summary.unread) {
      lines.push(`  ${String(row.estTokens).padStart(4)}tok  ${row.language.padEnd(8)} ${row.preview.slice(0, 56)}`);
    }
  }

  return lines.join("\n");
};
