// HOW THE REX ADAPTER TALKS TO REX — the subprocess seam.
//
// Rex is a server with a CLI client, `rex`. This file is the only place in the adapter that spawns,
// and the conformance fixture swaps {@link RexExec} for an in-memory one.
//
// SPAWN HYGIENE:
//  • No shell: arguments go to Bun.spawn as an array.
//  • Fixed binary paths are probed; PATH is not read, because a service and a login shell differ.
//  • `--autostart=false` on every call: a missing server is reported, never started by Collie.
//  • `--color=never`, so an error sentence carries no escapes for the classifier to trip on.
//  • Typed text rides stdin as JSON, never argv: no argv size cap, and it never shows in `ps`.
//  • A hung child is killed on its budget: SIGTERM, then SIGKILL a moment later.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface RexRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RexStreamHandlers {
  onLine(line: string): void;
  onExit(reason: string): void;
}

export interface RexStreamClient {
  kill(): void;
}

/** What the adapter needs from Rex. `args` never carries the global options; the transport adds them. */
export interface RexExec {
  run(args: readonly string[], stdin?: string): Promise<RexRunResult>;
  events(handlers: RexStreamHandlers): RexStreamClient;
}

export function rexBinaryCandidates(home: string = process.env.HOME ?? ""): readonly string[] {
  const local = home.length > 0 ? [`${home}/.local/bin/rex`] : [];
  return [...local, "/usr/bin/rex", "/bin/rex", "/usr/local/bin/rex", "/opt/homebrew/bin/rex", "/opt/local/bin/rex"];
}

export function resolveRexBinary(
  configured: string,
  exists: (path: string) => boolean = existsSync,
  candidates: readonly string[] = rexBinaryCandidates(),
): string | null {
  const named = configured.trim();
  if (named.length > 0) return isAbsolute(named) && exists(named) ? named : null;
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/**
 * The options every call carries. An endpoint is passed to `-S` as written: Rex reads a value with
 * `unix://` or a port as an address and anything else as a host label. A bare absolute path is a
 * socket, so it is spelled as a `unix://` address.
 */
export function globalArgs(endpoint: string): readonly string[] {
  const options = ["--autostart=false", "--color=never"];
  const named = endpoint.trim();
  if (named.length === 0) return options;
  return [...options, "-S", isAbsolute(named) ? `unix://${named}` : named];
}

/**
 * Where a local Rex server listens when nothing names one: `$XDG_RUNTIME_DIR/rex/server.sock`, the
 * address `rex whoami --json` reports and `REX_SERVER` carries (MUX_CONTRACT.md **RX**).
 */
export function defaultRexSocket(runtimeDir: string | undefined = process.env.XDG_RUNTIME_DIR, uid: number = process.getuid?.() ?? 1000): string {
  const base = runtimeDir && runtimeDir.trim() !== "" ? runtimeDir.trim() : `/run/user/${String(uid)}`;
  return `${base}/rex/server.sock`;
}

export const NO_REX_BINARY = "no rex binary found — set COLLIE_REX_BIN to its absolute path";
export const TIMED_OUT_CODE = 143;
export const NO_BINARY_CODE = 127;
export const KILL_GRACE_MS = 1000;

export function timedOutMessage(args: readonly string[], timeoutMs: number): string {
  const verb = args.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ") || "the call";
  return `rex did not answer \`${verb}\` within ${String(timeoutMs)}ms and was killed`;
}

export class SpawnRexExec implements RexExec {
  constructor(
    private readonly binary: string | null,
    private readonly endpoint: string,
    private readonly timeoutMs: number,
  ) {}

  async run(args: readonly string[], stdin?: string): Promise<RexRunResult> {
    if (this.binary === null) return { code: NO_BINARY_CODE, stdout: "", stderr: NO_REX_BINARY };
    const child = Bun.spawn([this.binary, ...globalArgs(this.endpoint), ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });

    let killed = false;
    let hardKill: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
      hardKill = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, this.timeoutMs);

    try {
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const code = await child.exited;
      if (killed) return { code: TIMED_OUT_CODE, stdout: "", stderr: timedOutMessage(args, this.timeoutMs) };
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (hardKill !== null) clearTimeout(hardKill);
    }
  }

  events(handlers: RexStreamHandlers): RexStreamClient {
    if (this.binary === null) {
      queueMicrotask(() => handlers.onExit(NO_REX_BINARY));
      return { kill: () => undefined };
    }
    const child = Bun.spawn([this.binary, ...globalArgs(this.endpoint), "events", "--all", "--json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });

    let ended = false;
    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      handlers.onExit(reason);
    };

    void (async () => {
      try {
        await pumpLines(child.stdout, handlers.onLine);
        end("the rex event stream ended");
      } catch (err) {
        end(err instanceof Error ? err.message : String(err));
      }
    })();

    return {
      kill: () => {
        child.kill();
        end("closed");
      },
    };
  }
}

async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let cut = buffered.indexOf("\n");
    while (cut >= 0) {
      onLine(buffered.slice(0, cut).replace(/\r$/u, ""));
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf("\n");
    }
  }
  if (buffered.length > 0) onLine(buffered);
}
