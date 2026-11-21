// SPDX-FileCopyrightText: 2026 Thomas Fazzari
// SPDX-License-Identifier: MIT

import { join } from "node:path";

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface Command {
  type: string;
  [key: string]: unknown;
}

interface RpcMessage {
  type: string;
  id?: string;
}

type RpcResponse<T> = { success: true; data: T } | { success: false; error: string };

export class PiRpc {
  readonly #proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  readonly #pending = new Map<string, Waiter<string>>();
  readonly #extensionErrors: string[] = [];
  #agentEnd: Waiter<void> | undefined;
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

  async request<T = unknown>(command: Command): Promise<T> {
    if (this.#exited) {
      throw new Error(`pi exited before ${command.type}`);
    }
    const id = String(++this.#nextId);
    const line = new Promise<string>((resolve, reject) =>
      this.#pending.set(id, { resolve, reject }),
    );
    await this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    await this.#proc.stdin.flush();
    const response: RpcResponse<T> = JSON.parse(await line);
    if (!response.success) {
      throw new Error(`${command.type} failed: ${response.error}`);
    }
    return response.data;
  }

  async prompt(message: string): Promise<void> {
    const ended = new Promise<void>((resolve, reject) => {
      this.#agentEnd = { resolve, reject };
    });
    // A failed request leaves ended unawaited, and its later rejection must not crash the runner
    ended.catch(() => undefined);
    await this.request({ type: "prompt", message });
    await ended;
  }

  kill(): void {
    this.#proc.kill();
  }

  // Closing stdin makes Pi quit, which runs session_shutdown with reason "quit"
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
    let message: RpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "response" && message.id !== undefined) {
      this.#pending.get(message.id)?.resolve(line);
      this.#pending.delete(message.id);
    }
    if (message.type === "agent_end") {
      this.#agentEnd?.resolve();
      this.#agentEnd = undefined;
    }
    if (message.type === "extension_error") {
      this.#extensionErrors.push(line);
    }
  }
}
