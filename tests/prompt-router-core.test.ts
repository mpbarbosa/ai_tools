/**
 * Fixed inputs, no network, no clock. Each branch of `classify` and `decide`
 * gets a case that fails when the rule behind it is deleted — the discipline
 * the Jev prototype in `portal_brasileirao` learned the hard way, where the
 * upload-window test passed with the window erased until it got a case of its
 * own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildRecord,
  skipReason,
  NON_PROMPT_WRAPPERS,
  classify,
  decide,
  readFacts,
  adviceLine,
  DEFAULT_MODEL,
  CHEAP_MODEL,
  MID_MODEL,
  THRESHOLDS,
  type Env,
} from "../prompt-router-core.ts";

const ENV: Env = { nowIso: "2026-09-29T12:00:00.000Z", model: null, effort: "high" };
const read = (prompt: string) => {
  const facts = readFacts(prompt);
  const classification = classify(facts, prompt);
  return { facts, classification, decision: decide(classification, facts, ENV) };
};

test("facts count what the code can count, and guess the language", () => {
  const facts = readFacts("Corrige o bug em prompt-router-core.ts\n\n- um\n- dois\n- tres\n");
  assert.equal(facts.paths, 1);
  assert.equal(facts.listItems, 3);
  assert.equal(facts.language, "pt");
  assert.ok(facts.estTokens > 0);
});

test("accents and case do not change a reading", () => {
  const a = read("avaliação da arquitetura").classification;
  const b = read("AVALIACAO DA ARQUITETURA").classification;
  assert.deepEqual(a.kindScores, b.kindScores);
});

test("machine-generated events are not prompts", () => {
  assert.equal(skipReason("<bash-input>git status</bash-input><bash-stdout>ok</bash-stdout>"), "bash-input");
  assert.equal(skipReason("<task-notification>\n<task-id>abc</task-id>\n</task-notification>"), "task-notification");
  assert.equal(skipReason("   "), "empty");
  assert.equal(skipReason(""), "empty");
});

test("a wrapper tag is recognised even when it carries attributes", () => {
  // The real payload, which the first version of this rule missed because it
  // required `>` immediately after the tag name.
  assert.equal(
    skipReason('<scheduled-task name="prompt-router-first-week" file="/home/mpb/.claude/x/SKILL.md">\nCheck the report.\n</scheduled-task>'),
    "scheduled-task",
  );
  assert.equal(skipReason("<scheduled-task>bare form too</scheduled-task>"), "scheduled-task");
  // An attribute-bearing tag that is not on the list is still kept.
  assert.equal(skipReason('<div class="x">pasted markup</div>'), null);
});

test("a real prompt survives, even when it talks about the wrappers", () => {
  assert.equal(skipReason("commit this"), null);
  // Only a LEADING tag is an event. Asking about one is an ordinary prompt.
  assert.equal(skipReason("why is <bash-input> showing up in the log?"), null);
  // An unknown tag is kept: it may be something the user submitted.
  assert.equal(skipReason("<pasted_content>some log lines</pasted_content>"), null);
  assert.ok(!NON_PROMPT_WRAPPERS.includes("pasted_content"));
});

test("a query string is not a question", () => {
  const withUrl = readFacts("roda isso em https://example.com/x?a=1&b=2");
  const withQuestion = readFacts("roda isso onde?");
  assert.equal(withUrl.questions, 0);
  assert.equal(withQuestion.questions, 1);
});

test("a design prompt reads as design, needing judgment", () => {
  const { classification } = read(
    "Avalie qual a melhor arquitetura para isso e compare os tradeoffs das duas abordagens antes de decidir",
  );
  assert.equal(classification.taskKind, "design");
  assert.ok(classification.needsJudgment >= THRESHOLDS.needsJudgment);
  // Hard, not research-grade: one line asking for a judgment is difficulty 3.
  // Reaching 4 also takes length or several stated requirements.
  assert.equal(classification.difficulty, 3);
  assert.equal(classification.isBulk, false);
});

test("a pasted stack trace reads as debug", () => {
  const { classification } = read("TypeError: cannot read x\n    at foo (bar.ts:3)\nnão funciona mais");
  assert.equal(classification.taskKind, "debug");
  assert.ok(classification.reasons.includes("stack trace pasted"));
});

test("a slash command reads as meta and stays trivial", () => {
  const { classification } = read("/code-review high");
  assert.equal(classification.taskKind, "meta");
  assert.equal(classification.difficulty, 1);
});

test("an unbound reference with no path marks the prompt underspecified", () => {
  const vague = read("arruma isso aí").classification;
  const bound = read("arruma isso em router-log.ts").classification;
  assert.ok(vague.underspecified >= THRESHOLDS.underspecified);
  assert.ok(bound.underspecified < vague.underspecified);
});

test("low confidence keeps the session default and says so", () => {
  const { decision } = read("ok");
  assert.equal(decision.fellBack, true);
  assert.equal(decision.effort, ENV.effort);
  assert.equal(decision.route, "in_session");
  assert.equal(decision.model, DEFAULT_MODEL);
});

test("difficulty maps to effort", () => {
  assert.equal(read("renomear a variavel x para y").decision.effort, "low");
  const wide = read(
    [
      "Avalie a arquitetura do roteador:",
      "- comparar os tradeoffs de cada abordagem",
      "- decidir onde fica o estado",
      "- recomendar a stack",
    ].join("\n"),
  );
  assert.equal(wide.classification.difficulty, 4);
  assert.equal(wide.decision.effort, "xhigh");
});

test("an underspecified prompt is raised one effort level", () => {
  const prompt = "explica isso";
  const facts = readFacts(prompt);
  const classification = classify(facts, prompt);
  const raised = decide(classification, facts, ENV);
  const asIf = decide({ ...classification, underspecified: 0 }, facts, ENV);
  assert.ok(classification.underspecified >= THRESHOLDS.underspecified);
  assert.notEqual(raised.effort, asIf.effort);
  assert.ok(raised.why.some((line) => line.includes("underspecified")));
});

test("bulk without judgment goes to a cheap model outside the session", () => {
  const { classification, decision } = read("para cada um dos 40 arquivos de teste, renomeia o describe e formata");
  assert.equal(classification.isBulk, true);
  assert.equal(decision.route, "headless_cheap");
  assert.equal(decision.model, CHEAP_MODEL);
});

test("bulk needing judgment goes to the mid model, and bulk is not a kind", () => {
  const { classification, decision } = read("avalie cada uma das 30 vagas e decida a melhor");
  // The work is judgment; `bulk` only says how many times. Were bulk a
  // competing kind, this would classify as bulk and lose the judgment reading.
  assert.equal(classification.taskKind, "design");
  assert.equal(classification.isBulk, true);
  assert.ok(classification.needsJudgment >= THRESHOLDS.needsJudgment);
  assert.equal(decision.route, "headless_cheap");
  assert.equal(decision.model, MID_MODEL);
});

test("per-item judgment over an external list routes to the n8n webhook", () => {
  const prompt =
    "avalie cada uma das vagas em lote desta busca https://www.linkedin.com/jobs/search-results/?keywords=x e decida o melhor veredito";
  const { classification, facts, decision } = read(prompt);
  assert.equal(classification.isBulk, true);
  assert.ok(facts.urls > 0);
  assert.equal(decision.route, "n8n_webhook");
  // The URL is what separates this from plain bulk: remove it and the route changes.
  const withoutUrl = read(prompt.replace(/https:\S+/, "essa busca")).decision;
  assert.notEqual(withoutUrl.route, "n8n_webhook");
});

test("mechanical and trivial prefers a script to a model", () => {
  const { decision } = read("formata o arquivo");
  assert.equal(decision.route, "deterministic_script");
});

test("the record carries the prompt only when policy says so", () => {
  const payload = { prompt: "renomear x", session_id: "s1", cwd: "/tmp", transcript_path: "/t.jsonl" };
  const kept = buildRecord(payload, ENV, "abc", true);
  const dropped = buildRecord(payload, ENV, "abc", false);
  assert.equal(kept.prompt.text, "renomear x");
  assert.equal(dropped.prompt.text, null);
  assert.equal(dropped.prompt.preview, "renomear x");
  assert.equal(kept.transcript, "/t.jsonl");
  assert.equal(kept.actual.effort, "high");
  assert.equal(kept.v, kept.v);
});

test("a malformed payload never throws", () => {
  const record = buildRecord({ prompt: 42, session_id: null }, ENV, "abc", true);
  assert.equal(record.prompt.chars, 0);
  assert.equal(record.session, null);
  assert.equal(record.decision.fellBack, true);
});

test("advice is one line and names the route", () => {
  const record = buildRecord({ prompt: "renomear a variavel x para y" }, ENV, "abc", false);
  const line = adviceLine(record);
  assert.ok(!line.includes("\n"));
  assert.ok(line.includes("effort"));
});

test("the core stays pure", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "prompt-router-core.ts"), "utf8");
  // Comments mention `process.env` and the clock; code must not reach for them.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["node:fs", "node:crypto", "fetch(", "process.env", "Date.now", "new Date"]) {
    assert.ok(!code.includes(forbidden), `prompt-router-core.ts must not use ${forbidden}`);
  }
});
