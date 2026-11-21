// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

// Drives a real Pi with the scripted provider through a proxy to otel-lgtm, then checks exact increase() values, trace trees and log records.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { match, P } from "ts-pattern";
import { decodeAttributes } from "../otlp-json.ts";
import { byStart, spanTrees } from "../span-tree.ts";
import type { TreeSpan } from "../span-tree.ts";
import { MODEL, PROVIDER } from "./faux-provider.ts";
import {
  LGTM_IMAGE,
  lokiStreams,
  prometheusQuery,
  removeLgtm,
  removeLgtmSync,
  startLgtm,
  tempoSpans,
} from "./lgtm.ts";
import type { Lgtm } from "./lgtm.ts";
import { PiRpc } from "./pi-rpc.ts";
import { startProxy } from "./proxy.ts";
import type { CollectorMode } from "./proxy.ts";

const POLL_MS = 500;
const STEP_TIMEOUT_MS = 60_000;
// The collector in otel-lgtm batches telemetry before it writes it to Prometheus, Tempo and Loki.
const INGEST_TIMEOUT_MS = 30_000;
const LINES_POLL_MS = 2000;
// Loki fields that vary between runs or repeat the resource, the scope or the severity.
const LOKI_UNCHECKED_FIELDS = new Set([
  "service_name",
  "service_version",
  "service_instance_id",
  "scope_name",
  "observed_timestamp",
  "detected_level",
  "severity_text",
  "severity_number",
  "trace_id",
  "span_id",
]);
const RANGE_PADDING_SECONDS = 60;
const RANGE = "1h";
const TOLERANCE = 1e-9;
const MS_PER_SECOND = 1000;
// Prometheus returns sample times in seconds with millisecond digits, so equal times can differ in the last bit.
const TIME_TOLERANCE_SECONDS = 0.0005;
const SCENARIOS_DIR = join(import.meta.dir, "scenarios");
const REPO_DIR = join(import.meta.dir, "..", "..");
const PI_SUBAGENTS_DIR =
  process.env["PI_SUBAGENTS_DIR"] ??
  join(homedir(), ".pi/agent/npm/node_modules/@tintinweb/pi-subagents");

type Step =
  | { prompt: string }
  | { start: string }
  | { sleepMs: number }
  | { compact: true }
  | { session: "new" | "switch-to-first" | "fork-first-message" }
  | { collector: CollectorMode };

interface Scenario {
  description: string;
  metricExportIntervalMs?: number;
  settings?: Record<string, unknown>;
  steps: Step[];
  expect: Record<string, number>;
  traces: string[];
  logs: string[];
}

function nowSeconds(): number {
  return Date.now() / MS_PER_SECOND;
}

async function piEnvironment(
  proxyUrl: string,
  scenario: Scenario,
): Promise<{ cwd: string; agentDir: string; env: Record<string, string> }> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-otlp-e2e-agent-"));
  // pi.project is the cwd's name, so the scenarios need it fixed
  const cwd = join(await mkdtemp(join(tmpdir(), "pi-otlp-e2e-work-")), "ariane-5");
  await Bun.write(join(cwd, "README.md"), "# e2e\n");
  await Bun.write(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: [
        PI_SUBAGENTS_DIR,
        join(import.meta.dir, "faux-provider.ts"),
        join(REPO_DIR, "src/index.ts"),
      ],
      defaultProvider: PROVIDER,
      defaultModel: MODEL,
      ...scenario.settings,
    }),
  );
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: proxyUrl,
  };
  if (scenario.metricExportIntervalMs !== undefined) {
    env["OTEL_METRIC_EXPORT_INTERVAL"] = String(scenario.metricExportIntervalMs);
  }
  return { cwd, agentDir, env };
}

async function drive(
  pi: PiRpc,
  steps: Step[],
  setCollectorMode: (mode: CollectorMode) => void,
): Promise<void> {
  const state = await withTimeout(
    pi.request<{ sessionFile: string }>({ type: "get_state" }),
    "get_state",
  );
  for (const step of steps) {
    await withTimeout(runStep(pi, step, state.sessionFile, setCollectorMode), JSON.stringify(step));
  }
}

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: Timer | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} took over ${STEP_TIMEOUT_MS} ms`)),
      STEP_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runStep(
  pi: PiRpc,
  step: Step,
  firstSession: string,
  setCollectorMode: (mode: CollectorMode) => void,
): Promise<void> {
  await match(step)
    .returnType<Promise<unknown>>()
    .with({ prompt: P.select() }, (message) => pi.prompt(message))
    .with({ start: P.select() }, (message) => pi.request({ type: "prompt", message }))
    .with({ sleepMs: P.select() }, (ms) => Bun.sleep(ms))
    .with({ collector: P.select() }, (mode) => {
      setCollectorMode(mode);
      return Promise.resolve();
    })
    .with({ compact: true }, () => pi.request({ type: "compact" }))
    .with({ session: "new" }, () => pi.request({ type: "new_session" }))
    .with({ session: "switch-to-first" }, () =>
      pi.request({ type: "switch_session", sessionPath: firstSession }),
    )
    .with({ session: "fork-first-message" }, async () => {
      const { messages } = await pi.request<{ messages: { entryId: string }[] }>({
        type: "get_fork_messages",
      });
      await pi.request({ type: "fork", entryId: messages[0]?.entryId });
    })
    .exhaustive();
}

interface Check {
  passed: boolean;
  line: string;
}

// Evaluated at the series' last sample, so Prometheus does not extrapolate past the end of the run.
async function checkIncrease(
  prometheusUrl: string,
  selector: string,
  expected: number,
  finalFlushAfter: number,
): Promise<Check> {
  // The host clock, not the Docker VM's, set the sample times.
  const series = await prometheusQuery(prometheusUrl, `${selector}[${RANGE}]`, nowSeconds());
  const [only] = series;
  if (series.length !== 1 || only === undefined) {
    return { passed: false, line: `  FAIL ${selector}: ${series.length} series match` };
  }
  const samples = only.values ?? [];
  const lastTime = samples.at(-1)?.[0] ?? 0;
  if (lastTime + TIME_TOLERANCE_SECONDS < finalFlushAfter) {
    return { passed: false, line: `  FAIL ${selector}: the final flush never reached Prometheus` };
  }
  const [result] = await prometheusQuery(
    prometheusUrl,
    `increase(${selector}[${RANGE}])`,
    lastTime,
  );
  const actual = Number(result?.value?.[1]);
  const values = samples
    .map(([, value]) => value)
    .filter((value, i, all) => i === 0 || value !== all[i - 1]);
  const passed = Math.abs(actual - expected) < TOLERANCE;
  const verdict = passed ? "ok  " : "FAIL";
  const line = `  ${verdict} increase(${selector}) = ${actual}, expected ${expected}, samples ${values.join(" → ")}`;
  return { passed, line };
}

// Polls until every expectation holds or ingestion had enough time, then prints the last results.
async function checkScenario(
  prometheusUrl: string,
  expect: Record<string, number>,
  finalFlushAfter: number,
): Promise<boolean> {
  const deadline = performance.now() + INGEST_TIMEOUT_MS;
  for (;;) {
    const checks = await Promise.all(
      Object.entries(expect).map(([selector, expected]) =>
        checkIncrease(prometheusUrl, selector, expected, finalFlushAfter),
      ),
    );
    const passed = checks.every((check) => check.passed);
    if (passed || performance.now() > deadline) {
      for (const check of checks) {
        console.log(check.line);
      }
      return passed;
    }
    await Bun.sleep(POLL_MS);
  }
}

// Tempo returns OTLP JSON ids in base64, and Loki stores them in hex.
function hexId(base64: string): string {
  return Buffer.from(base64, "base64").toString("hex");
}

interface TraceLinks {
  spanNames: Map<string, string>;
  conversations: Map<string, string>;
}

// Names each span by its hex ids, and each session id by its order of first appearance in the traces.
function traceLinks(spans: TreeSpan[]): TraceLinks {
  const spanNames = new Map(
    spans.map((span) => [`${hexId(span.traceId)}/${hexId(span.spanId)}`, span.name]),
  );
  const conversations = new Map<string, string>();
  for (const span of byStart(spans)) {
    const id = String(decodeAttributes(span.attributes)["gen_ai.conversation.id"]);
    if (!conversations.has(id)) {
      conversations.set(id, `#${conversations.size + 1}`);
    }
  }
  return { spanNames, conversations };
}

// One line per log record of service pi since the given time: severity, body, attributes and the name of the span it points to.
async function lokiRecords(
  lokiUrl: string,
  sinceSeconds: number,
  links: TraceLinks,
): Promise<string[]> {
  const streams = await lokiStreams(lokiUrl, sinceSeconds, nowSeconds() + RANGE_PADDING_SECONDS);
  const lines: string[] = [];
  for (const { stream: fields, values } of streams) {
    const conversation = fields["gen_ai_conversation_id"] ?? "";
    const attributes = Object.entries({
      ...fields,
      gen_ai_conversation_id: links.conversations.get(conversation) ?? "no trace",
    })
      .filter(([key]) => !LOKI_UNCHECKED_FIELDS.has(key))
      .map(([key, value]) => `${key}=${value}`)
      .toSorted();
    let span = "";
    if (fields["span_id"] !== undefined) {
      const key = `${fields["trace_id"]}/${fields["span_id"]}`;
      span = `@${links.spanNames.get(key) ?? "unknown span"}`;
    }
    for (const [, body] of values) {
      lines.push(`${fields["severity_text"]} ${body}[${attributes.join(",")}]${span}`);
    }
  }
  return lines;
}

// Polls until the lines equal the expected ones, in any order, or the timeout passes, then prints the comparison.
async function checkLines(
  label: string,
  read: () => Promise<string[]>,
  expected: string[],
  timeoutMs: number,
): Promise<boolean> {
  const wanted = expected.toSorted();
  const deadline = performance.now() + timeoutMs;
  let actual: string[] = [];
  for (;;) {
    actual = (await read()).toSorted();
    if (JSON.stringify(actual) === JSON.stringify(wanted) || performance.now() > deadline) {
      break;
    }
    await Bun.sleep(LINES_POLL_MS);
  }
  if (JSON.stringify(actual) === JSON.stringify(wanted)) {
    for (const line of actual) {
      console.log(`  ok   ${label} ${line}`);
    }
    return true;
  }
  for (const line of wanted) {
    console.log(`  want ${label} ${line}`);
  }
  for (const line of actual) {
    console.log(`  got  ${label} ${line}`);
  }
  console.log(`  FAIL the ${label} records differ`);
  return false;
}

async function checkTracesAndLogs(
  lgtm: Lgtm,
  scenario: Scenario,
  sinceSeconds: number,
  traceIds: string[],
): Promise<boolean> {
  let spans: TreeSpan[] = [];
  const tracesPassed = await checkLines(
    "trace",
    async () => {
      spans = await tempoSpans(lgtm.tempoUrl, traceIds);
      return spanTrees(spans);
    },
    scenario.traces,
    INGEST_TIMEOUT_MS,
  );
  const links = traceLinks(spans);
  const logsPassed = await checkLines(
    "log",
    () => lokiRecords(lgtm.lokiUrl, sinceSeconds, links),
    scenario.logs,
    INGEST_TIMEOUT_MS,
  );
  return tracesPassed && logsPassed;
}

async function runScenario(name: string): Promise<boolean> {
  const scenario: Scenario = await Bun.file(join(SCENARIOS_DIR, `${name}.json`)).json();
  console.log(`${name}: ${scenario.description}`);
  if (Object.keys(scenario.expect).length === 0) {
    throw new Error(`${name} has no expectations`);
  }
  const lgtm = await startLgtm();
  const startedAt = nowSeconds() - RANGE_PADDING_SECONDS;
  const proxy = startProxy(lgtm.otlpUrl);
  const { cwd, agentDir, env } = await piEnvironment(proxy.url, scenario);
  const pi = new PiRpc(cwd, env);
  let exitCode: number;
  try {
    await drive(pi, scenario.steps, proxy.setMode);
    exitCode = await withTimeout(pi.quit(), "quit");
  } finally {
    pi.kill();
    await proxy.stop();
    await rm(dirname(cwd), { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
  let passed = exitCode === 0 && pi.extensionErrors.length === 0;
  if (!passed) {
    console.log(
      `  FAIL pi exited with ${exitCode}, extension errors: ${pi.extensionErrors.join("\n")}`,
    );
  }
  // The last metrics request forwarded before Pi exited is the final flush.
  const finalFlush = proxy.lastForwardedMetricsSeconds();
  passed = (await checkScenario(lgtm.prometheusUrl, scenario.expect, finalFlush)) && passed;
  return (await checkTracesAndLogs(lgtm, scenario, startedAt, proxy.traceIds())) && passed;
}

if (LGTM_IMAGE === "") {
  throw new Error("LGTM_IMAGE is not set. Run the scenarios with mise run e2e.");
}
if (!(await Bun.file(join(PI_SUBAGENTS_DIR, "package.json")).exists())) {
  throw new Error(`pi-subagents not found in ${PI_SUBAGENTS_DIR}. Set PI_SUBAGENTS_DIR.`);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    removeLgtmSync();
    process.exit(1);
  });
}

const requested = Bun.argv.slice(2);
const available = (await readdir(SCENARIOS_DIR)).map((file) => basename(file, ".json"));
const names = requested.length > 0 ? requested : available;
let failed = 0;
try {
  for (const name of names) {
    if (!(await runScenario(name))) {
      failed++;
    }
  }
} finally {
  await removeLgtm();
}
if (failed > 0) {
  console.log(`${failed} of ${names.length} scenarios failed`);
  process.exit(1);
}
console.log(`${names.length} scenarios passed`);
