// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

// Drives a real Pi with the scripted provider through a proxy to otel-lgtm, then checks exact increase() values, trace trees and log records.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { decodeAttributes } from "../otlp-json.ts";
import { byStart, spanTrees } from "../span-tree.ts";
import type { TreeSpan } from "../span-tree.ts";
import { MODEL, PROVIDER } from "./faux-provider.ts";

const LGTM_IMAGE = "grafana/otel-lgtm:0.38.0";
const CONTAINER = `pi-otlp-e2e-${process.pid}`;
const LGTM_OTLP_PORT = "4318/tcp";
const LGTM_PROMETHEUS_PORT = "9090/tcp";
const LGTM_TEMPO_PORT = "3200/tcp";
const LGTM_LOKI_PORT = "3100/tcp";
const READY_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const STEP_TIMEOUT_MS = 60_000;
// The collector in otel-lgtm batches metrics before it writes them to Prometheus.
const INGEST_TIMEOUT_MS = 30_000;
// Tempo search only finds a trace once its ingester flushes it, which takes about 20 s.
const TRACE_SEARCH_TIMEOUT_MS = 90_000;
const TRACE_SEARCH_LIMIT = 100;
const LINES_POLL_MS = 2000;
const LOG_QUERY_LIMIT = 1000;
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
const NANOS_PER_MS = 1_000_000n;
const NANOS_PER_SECOND = 1_000_000_000n;
const FETCH_TIMEOUT_MS = 5000;
// Prometheus returns sample times in seconds with millisecond digits, so equal times can differ in the last bit.
const TIME_TOLERANCE_SECONDS = 0.0005;
const SCENARIOS_DIR = join(import.meta.dir, "scenarios");
const REPO_DIR = join(import.meta.dir, "..", "..");
const PI_SUBAGENTS_DIR =
  process.env["PI_SUBAGENTS_DIR"] ??
  join(homedir(), ".pi/agent/npm/node_modules/@tintinweb/pi-subagents");

type CollectorMode = "accept" | "refuse" | "ingest-then-refuse";

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

async function run(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} exited with ${code}: ${stderr}`);
  }
  return stdout;
}

interface Lgtm {
  otlpUrl: string;
  prometheusUrl: string;
  tempoUrl: string;
  lokiUrl: string;
}

async function lgtmReady(lgtm: Lgtm): Promise<boolean> {
  try {
    const prometheus = await fetch(`${lgtm.prometheusUrl}/-/ready`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const tempo = await fetch(`${lgtm.tempoUrl}/ready`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const loki = await fetch(`${lgtm.lokiUrl}/ready`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const otlp = await fetch(`${lgtm.otlpUrl}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceMetrics: [] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return prometheus.ok && tempo.ok && loki.ok && otlp.ok;
  } catch {
    return false;
  }
}

async function hostUrl(containerPort: string): Promise<string> {
  const binding = (await run(["docker", "port", CONTAINER, containerPort])).split("\n")[0];
  return `http://${binding}`;
}

// A fresh container per scenario, on ports Docker picks, so Prometheus, Tempo and Loki hold only that scenario's data.
async function startLgtm(): Promise<Lgtm> {
  await run(["docker", "rm", "-f", CONTAINER]);
  await run([
    "docker",
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-p",
    `127.0.0.1::${LGTM_OTLP_PORT}`,
    "-p",
    `127.0.0.1::${LGTM_PROMETHEUS_PORT}`,
    "-p",
    `127.0.0.1::${LGTM_TEMPO_PORT}`,
    "-p",
    `127.0.0.1::${LGTM_LOKI_PORT}`,
    LGTM_IMAGE,
  ]);
  const lgtm = {
    otlpUrl: await hostUrl(LGTM_OTLP_PORT),
    prometheusUrl: await hostUrl(LGTM_PROMETHEUS_PORT),
    tempoUrl: await hostUrl(LGTM_TEMPO_PORT),
    lokiUrl: await hostUrl(LGTM_LOKI_PORT),
  };
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (!(await lgtmReady(lgtm))) {
    if (performance.now() > deadline) {
      throw new Error(`${LGTM_IMAGE} was not ready after ${READY_TIMEOUT_MS} ms`);
    }
    await Bun.sleep(POLL_MS);
  }
  return lgtm;
}

// The latest data point time in an OTLP JSON metrics request, in epoch seconds.
function latestPointSeconds(body: any): number {
  let latestNanos = 0n;
  for (const resource of body.resourceMetrics) {
    for (const scope of resource.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of (metric.sum ?? metric.histogram).dataPoints) {
          const nanos = BigInt(point.timeUnixNano);
          if (nanos > latestNanos) {
            latestNanos = nanos;
          }
        }
      }
    }
  }
  return Number(latestNanos / NANOS_PER_MS) / MS_PER_SECOND;
}

// Forwards OTLP requests to otel-lgtm, or fails them on demand.
function startProxy(otlpUrl: string) {
  let mode: CollectorMode = "accept";
  let lastForwardedMetricsSeconds = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (mode === "refuse") {
        return new Response(null, { status: 503 });
      }
      const body = await request.text();
      if (path === "/v1/metrics") {
        lastForwardedMetricsSeconds = latestPointSeconds(JSON.parse(body));
      }
      const upstream = await fetch(`${otlpUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (mode === "ingest-then-refuse" && path === "/v1/metrics") {
        mode = "accept";
        return new Response(null, { status: 503 });
      }
      return new Response(await upstream.arrayBuffer(), { status: upstream.status });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    setMode: (next: CollectorMode) => {
      mode = next;
    },
    lastForwardedMetricsSeconds: () => lastForwardedMetricsSeconds,
    stop: () => server.stop(true),
  };
}

interface Waiter {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

class PiRpc {
  readonly #proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  readonly #pending = new Map<string, Waiter>();
  readonly #extensionErrors: string[] = [];
  #agentEnd: Waiter | undefined;
  #exited = false;
  #nextId = 0;

  constructor(cwd: string, env: Record<string, string>) {
    this.#proc = Bun.spawn(
      ["pi", "--mode", "rpc", "--offline", "--session-dir", join(cwd, ".sessions")],
      {
        cwd,
        env: { ...process.env, ...env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    this.#read().catch((error: unknown) => {
      console.error("pi output could not be read:", error);
    });
  }

  get extensionErrors(): string[] {
    return this.#extensionErrors;
  }

  async request(command: Record<string, unknown>): Promise<any> {
    if (this.#exited) {
      throw new Error(`pi exited before ${String(command["type"])}`);
    }
    const id = String(++this.#nextId);
    const response = new Promise<any>((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
    await this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    await this.#proc.stdin.flush();
    const result = await response;
    if (!result.success) {
      throw new Error(`${String(command["type"])} failed: ${result.error}`);
    }
    return result.data;
  }

  async prompt(message: string): Promise<void> {
    const ended = new Promise<void>((resolve, reject) => {
      this.#agentEnd = { resolve, reject };
    });
    // A failed request leaves ended unawaited, and its later rejection must not crash the runner.
    ended.catch(() => undefined);
    await this.request({ type: "prompt", message });
    await ended;
  }

  kill(): void {
    this.#proc.kill();
  }

  // Closing stdin makes Pi quit, which runs session_shutdown with reason "quit".
  async quit(): Promise<number> {
    await this.#proc.stdin.end();
    return this.#proc.exited;
  }

  async #read(): Promise<void> {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.#proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          this.#handle(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      }
    } finally {
      this.#exited = true;
      const exited = new Error("pi exited while a request was pending");
      for (const waiter of this.#pending.values()) {
        waiter.reject(exited);
      }
      this.#agentEnd?.reject(exited);
      this.#agentEnd = undefined;
    }
  }

  #handle(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "response") {
      this.#pending.get(message.id)?.resolve(message);
      this.#pending.delete(message.id);
    }
    if (message.type === "agent_end") {
      this.#agentEnd?.resolve(undefined);
      this.#agentEnd = undefined;
    }
    if (message.type === "extension_error") {
      this.#extensionErrors.push(line);
    }
  }
}

async function piEnvironment(
  proxyUrl: string,
  scenario: Scenario,
): Promise<{ cwd: string; agentDir: string; env: Record<string, string> }> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-otlp-e2e-agent-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-otlp-e2e-work-"));
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
  const state = await withTimeout(pi.request({ type: "get_state" }), "get_state");
  const firstSession: string = state.sessionFile;
  for (const step of steps) {
    await withTimeout(runStep(pi, step, firstSession, setCollectorMode), JSON.stringify(step));
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
  if ("prompt" in step) {
    await pi.prompt(step.prompt);
  } else if ("start" in step) {
    await pi.request({ type: "prompt", message: step.start });
  } else if ("sleepMs" in step) {
    await Bun.sleep(step.sleepMs);
  } else if ("collector" in step) {
    setCollectorMode(step.collector);
  } else if ("compact" in step) {
    await pi.request({ type: "compact" });
  } else if (step.session === "new") {
    await pi.request({ type: "new_session" });
  } else if (step.session === "switch-to-first") {
    await pi.request({ type: "switch_session", sessionPath: firstSession });
  } else {
    const { messages } = await pi.request({ type: "get_fork_messages" });
    await pi.request({ type: "fork", entryId: messages[0].entryId });
  }
}

async function query(prometheusUrl: string, promql: string, time?: number): Promise<any[]> {
  const params = new URLSearchParams({ query: promql });
  if (time !== undefined) {
    params.set("time", String(time));
  }
  const response = await fetch(`${prometheusUrl}/api/v1/query?${params.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json: any = await response.json();
  if (json.status !== "success") {
    throw new Error(`${promql}: ${JSON.stringify(json)}`);
  }
  return json.data.result;
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
  const series = await query(prometheusUrl, `${selector}[${RANGE}]`, Date.now() / MS_PER_SECOND);
  if (series.length !== 1) {
    return { passed: false, line: `  FAIL ${selector}: ${series.length} series match` };
  }
  const samples: [number, string][] = series[0].values;
  const lastTime = samples.at(-1)?.[0] ?? 0;
  if (lastTime + TIME_TOLERANCE_SECONDS < finalFlushAfter) {
    return { passed: false, line: `  FAIL ${selector}: the final flush never reached Prometheus` };
  }
  const [result] = await query(prometheusUrl, `increase(${selector}[${RANGE}])`, lastTime);
  const actual = Number(result?.value[1]);
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

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return response.json();
}

// Tempo returns OTLP JSON ids in base64, and Loki stores them in hex.
function hexId(base64: string): string {
  return Buffer.from(base64, "base64").toString("hex");
}

// Every span Tempo holds for service pi since the given time.
async function tempoSpans(tempoUrl: string, sinceSeconds: number): Promise<TreeSpan[]> {
  const params = new URLSearchParams({
    tags: "service.name=pi",
    limit: String(TRACE_SEARCH_LIMIT),
    start: String(Math.floor(sinceSeconds)),
    end: String(Math.ceil(Date.now() / MS_PER_SECOND) + RANGE_PADDING_SECONDS),
  });
  const search = await getJson(`${tempoUrl}/api/search?${params.toString()}`);
  const found: any[] = search.traces ?? [];
  const ids = new Set<string>(found.map((trace) => trace.traceID));
  const spans: TreeSpan[] = [];
  for (const id of ids) {
    const { trace } = await getJson(`${tempoUrl}/api/v2/traces/${id}`);
    const resources: any[] = trace.resourceSpans;
    const traceSpans: any[] = resources
      .flatMap((resource) => resource.scopeSpans)
      .flatMap((scope) => scope.spans);
    spans.push(...traceSpans.map((span) => ({ ...span, attributes: span.attributes ?? [] })));
  }
  return spans;
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
  const endSeconds = Math.ceil(Date.now() / MS_PER_SECOND) + RANGE_PADDING_SECONDS;
  const params = new URLSearchParams({
    query: '{service_name="pi"}',
    start: String(BigInt(Math.floor(sinceSeconds)) * NANOS_PER_SECOND),
    end: String(BigInt(endSeconds) * NANOS_PER_SECOND),
    limit: String(LOG_QUERY_LIMIT),
  });
  const json = await getJson(`${lokiUrl}/loki/api/v1/query_range?${params.toString()}`);
  const streams: any[] = json.data.result;
  const lines: string[] = [];
  for (const result of streams) {
    const fields: Record<string, string> = result.stream;
    const values: [string, string][] = result.values;
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
): Promise<boolean> {
  let spans: TreeSpan[] = [];
  const tracesPassed = await checkLines(
    "trace",
    async () => {
      spans = await tempoSpans(lgtm.tempoUrl, sinceSeconds);
      return spanTrees(spans);
    },
    scenario.traces,
    TRACE_SEARCH_TIMEOUT_MS,
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
  const startedAt = Date.now() / MS_PER_SECOND - RANGE_PADDING_SECONDS;
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
    await rm(cwd, { recursive: true, force: true });
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
  return (await checkTracesAndLogs(lgtm, scenario, startedAt)) && passed;
}

if (!(await Bun.file(join(PI_SUBAGENTS_DIR, "package.json")).exists())) {
  throw new Error(`pi-subagents not found in ${PI_SUBAGENTS_DIR}. Set PI_SUBAGENTS_DIR.`);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    Bun.spawnSync(["docker", "rm", "-f", CONTAINER]);
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
  await run(["docker", "rm", "-f", CONTAINER]);
}
if (failed > 0) {
  console.log(`${failed} of ${names.length} scenarios failed`);
  process.exit(1);
}
console.log(`${names.length} scenarios passed`);
