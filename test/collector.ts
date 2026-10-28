// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

const UNAVAILABLE_DELAY_MS = 100;

interface ReceivedRequest {
  path: string;
  contentType: string | null;
  body: any;
}

// Local stand-in for the OTLP/HTTP receiver of a collector.
export class Collector {
  readonly requests: ReceivedRequest[] = [];
  mode: "ok" | "reject" | "unavailable" | "hang" = "ok";
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor(port = 0) {
    this.#server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: async (request) => this.#receive(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  bodies(path: string): any[] {
    return this.requests.filter((request) => request.path === path).map((request) => request.body);
  }

  async waitFor(path: string, count = 1): Promise<void> {
    const deadline = performance.now() + 3000;
    while (this.bodies(path).length < count) {
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${count} requests to ${path}`);
      }
      await Bun.sleep(10);
    }
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  async #receive(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    this.requests.push({
      path,
      contentType: request.headers.get("content-type"),
      body: await request.json(),
    });
    if (this.mode === "hang") {
      return new Promise<Response>(() => {});
    }
    if (this.mode === "reject") {
      return new Response(null, { status: 400 });
    }
    if (this.mode === "unavailable") {
      await Bun.sleep(UNAVAILABLE_DELAY_MS);
      return new Response(null, { status: 503 });
    }
    return Response.json({});
  }
}

export async function unusedPort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) {
    throw new Error("the probe server has no TCP port");
  }
  return port;
}
