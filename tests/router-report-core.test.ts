/**
 * Fixed rows, no filesystem. The cases that matter are the honest-arithmetic
 * ones: an unknown session effort must not be counted as agreement, and mixed
 * heuristics versions must not be pooled quietly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  confidenceBucket,
  percentile,
  readRow,
  readRows,
  renderReport,
  summarize,
  type Row,
} from "../router-report-core.ts";

const row = (over: Partial<Row> = {}): Row => ({
  v: "1.1.0",
  ts: "2026-09-30T01:00:00.000Z",
  cwd: "/home/mpb/Documents/GitHub/ai_tools",
  estTokens: 20,
  language: "pt",
  taskKind: "code_edit",
  difficulty: 2,
  confidence: 0.7,
  isBulk: false,
  effort: "medium",
  route: "in_session",
  model: "claude-opus-5",
  fellBack: false,
  actualEffort: "high",
  actualModel: null,
  preview: "faz isso",
  ...over,
});

test("percentiles use nearest rank and survive an empty series", () => {
  const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(series, 0.5), 5);
  assert.equal(percentile(series, 0.9), 9);
  assert.equal(percentile(series, 1), 10);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([], 0.5), 0);
});

test("confidence zero gets its own bucket, and the top bucket is closed", () => {
  assert.equal(confidenceBucket(0), "0.0 (no reading)");
  assert.equal(confidenceBucket(0.35), "0.2-0.4");
  assert.equal(confidenceBucket(1), "0.8-1.0");
});

test("a record missing fields is still counted, with fallbacks", () => {
  const parsed = readRow({ ts: "2026-09-30T01:00:00.000Z" });
  assert.notEqual(parsed, null);
  assert.equal(parsed?.taskKind, "unknown");
  assert.equal(parsed?.estTokens, 0);
  assert.equal(parsed?.fellBack, false);
  // Without a timestamp it is not a record at all.
  assert.equal(readRow({ prompt: { preview: "x" } }), null);
  assert.equal(readRow(null), null);
  assert.equal(readRow("nope"), null);
});

test("unreadable lines are counted, not thrown", () => {
  const { rows, malformed } = readRows(
    [JSON.stringify({ ts: "2026-09-30T01:00:00.000Z" }), "", "{ truncated", "42"].join("\n"),
  );
  assert.equal(rows.length, 1);
  assert.equal(malformed, 2);
});

test("an unknown session effort is not counted as agreement", () => {
  // Same recommendation twice; only the record that knows what the session
  // was on can say whether anything would have changed.
  const summary = summarize([
    row({ effort: "high", actualEffort: "high" }),
    row({ effort: "high", actualEffort: null }),
  ]);
  assert.equal(summary.wouldChange, 0);
  assert.equal(summary.effortUnknown, 1);
});

test("a differing effort or a route out of the session counts as a change", () => {
  const summary = summarize([
    row({ effort: "low", actualEffort: "high" }),
    row({ route: "headless_cheap", effort: "high", actualEffort: "high" }),
    row({ effort: "high", actualEffort: "high" }),
  ]);
  assert.equal(summary.wouldChange, 2);
});

test("the summary counts fallbacks, bulk and the token spread", () => {
  const summary = summarize([
    row({ fellBack: true, confidence: 0, estTokens: 4 }),
    row({ isBulk: true, estTokens: 40 }),
    row({ estTokens: 400 }),
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.fellBack, 1);
  assert.equal(summary.bulk, 1);
  assert.equal(summary.tokens.min, 4);
  assert.equal(summary.tokens.median, 40);
  assert.equal(summary.tokens.max, 400);
  assert.equal(summary.projects[0].label, "ai_tools");
});

test("routed and unread samples are capped and ordered usefully", () => {
  const summary = summarize(
    [
      row({ route: "headless_cheap", confidence: 0.5 }),
      row({ route: "n8n_webhook", confidence: 0.9 }),
      row({ fellBack: true, preview: "older" }),
      row({ fellBack: true, preview: "newest" }),
    ],
    0,
    1,
  );
  assert.equal(summary.routed.length, 1);
  assert.equal(summary.routed[0].route, "n8n_webhook");
  assert.equal(summary.unread.length, 1);
  assert.equal(summary.unread[0].preview, "newest");
});

test("mixed heuristics versions are called out, not pooled quietly", () => {
  const mixed = renderReport(summarize([row({ v: "1.0.0" }), row({ v: "1.1.0" })]));
  assert.match(mixed, /2 heuristics versions mixed/);
  assert.match(mixed, /different populations/);
  const single = renderReport(summarize([row(), row()]));
  assert.ok(!single.includes("heuristics versions mixed"));
});

test("an empty log renders a sentence, not a table of zeros", () => {
  const rendered = renderReport(summarize([]));
  assert.match(rendered, /has not logged anything yet/);
  assert.ok(!rendered.includes("task kind"));
});

test("the report renders the headline numbers and every block", () => {
  const rendered = renderReport(summarize([row(), row({ route: "headless_cheap", effort: "low" })]));
  for (const heading of ["route", "recommended effort", "task kind", "confidence", "project"]) {
    assert.ok(rendered.includes(heading), `missing block: ${heading}`);
  }
  assert.match(rendered, /no reading \(fell back\)/);
  assert.match(rendered, /would change something/);
});

test("columns stay aligned however long the labels are", () => {
  const rendered = renderReport(
    summarize([row({ cwd: "/x/sampa2_graphics_terminal" }), row({ cwd: "/x/ai" })]),
  );
  const project = rendered.split("\n").slice(rendered.split("\n").indexOf("project") + 1, undefined);
  const counts = project.slice(0, 2).map((line) => line.indexOf("  1  "));
  assert.equal(counts[0], counts[1], "count column must start at the same offset");
});

test("the report core stays pure", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "router-report-core.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["node:fs", "node:crypto", "fetch(", "process.env", "Date.now", "new Date"]) {
    assert.ok(!code.includes(forbidden), `router-report-core.ts must not use ${forbidden}`);
  }
});
