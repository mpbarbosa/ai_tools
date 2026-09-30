#!/usr/bin/env node
/**
 * scripts/router-report.ts
 * ------------------------
 * Reads the router's JSONL and prints the distribution. All the arithmetic is
 * in `router-report-core.ts`; this file only finds the file and writes to
 * stdout.
 *
 *   node scripts/router-report.ts                    # the default log
 *   node scripts/router-report.ts path/to/other.jsonl
 *   node scripts/router-report.ts --json             # for further slicing
 *   node scripts/router-report.ts --sample 10        # longer hand-check lists
 */
import { readFileSync } from "node:fs";
import { readRows, renderReport, summarize } from "../router-report-core.ts";
import { logPath } from "../router-log.ts";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const positional = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
const path = positional[0] ?? logPath();
const sample = Number.parseInt(value("sample") ?? "5", 10);

let text: string;
try {
  text = readFileSync(path, "utf8");
} catch {
  // Not an error worth a stack trace: before the first prompt lands there is
  // legitimately no file.
  process.stdout.write(`No log at ${path}. Nothing recorded yet.\n`);
  process.exit(0);
}

const { rows, malformed } = readRows(text);
const summary = summarize(rows, malformed, Number.isFinite(sample) ? sample : 5);

process.stdout.write(
  flag("json") ? `${JSON.stringify(summary, null, 2)}\n` : `${renderReport(summary)}\n`,
);
