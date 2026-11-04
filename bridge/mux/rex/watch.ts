// Rex watch: `rex events --all --json` for changes Rex announces, and a census backstop for the ones
// it does not (a Rex app attaching to a session moves focus, and client events are not topology).
//
// LIFECYCLE IS THIS FILE'S, and it is the Tern watch's shape (../tern/watch.ts): `end()` is the one
// way out. It clears the census timer, kills the stream child and fires `onDown` exactly once.

import type { MuxSubscription, MuxWatchOptions } from "../types.ts";
import type { RexExec, RexStreamClient } from "./exec.ts";
import { listOf, parseEvent, parseTree, refusalKind, SNAPSHOT_SCRIPT, type RexEvent, type RexTree } from "./protocol.ts";

export const RESYNC_MS = 5000;

export const SNAPSHOT_ARGS: readonly string[] = ["do", "-e", SNAPSHOT_SCRIPT, "--json"];

export type WatchTimer = ReturnType<typeof setTimeout>;

export interface WatchClock {
  setInterval(fn: () => void, ms: number): WatchTimer;
  clearInterval(handle: WatchTimer): void;
}

export const REAL_CLOCK: WatchClock = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * The server events that add or remove a space. Both were seen on the live stream (MUX_CONTRACT.md
 * **RX**): `rex new` sends `session_created` and `rex kill` sends `session_destroyed`.
 */
const SPACE_EVENTS: ReadonlySet<string> = new Set(["session_created", "session_destroyed"]);

/**
 * The session events that change what a snapshot says, each one seen on the live stream across the
 * adapter's own writes or named by Rex's `help.all`. Client comings and goings are not among them.
 */
const TOPOLOGY_SESSION_EVENTS: ReadonlySet<string> = new Set([
  "block_created",
  "block_closed",
  "window_created",
  "window_closed",
  "window_label_changed",
  "active_window_changed",
  "session_label_changed",
  "session_view_changed",
]);

/**
 * The block events that change a pane's row: its title, folder, process or reported status. The
 * names are the terminal block's own event list (`rex block inspect`), and the first three were seen
 * on the live stream.
 */
const PANE_BLOCK_EVENTS: ReadonlySet<string> = new Set([
  "title_changed",
  "pwd_changed",
  "process_changed",
  "child_exited",
  "program_status_changed",
  "program_status_removed",
]);

function clientKinds(clients: readonly { readonly info?: { readonly kind?: string } }[]): string {
  return clients.map((client) => client.info?.kind ?? "").join(",");
}

export function censusSignature(tree: RexTree): string {
  const parts: string[] = [];
  for (const session of tree.sessions) {
    const view = session.view;
    parts.push(`s:${view.session_id}:${view.label ?? ""}:${view.active_window_id ?? ""}:${clientKinds(view.clients)}`);
    for (const window of view.windows) {
      parts.push(`w:${window.window_id}:${window.label ?? ""}:${window.focused_block_id ?? ""}`);
      for (const layer of window.layers) for (const block of layer.blocks) parts.push(`b:${block.block_id}`);
    }
    for (const block of session.blocks) {
      const states = listOf(block.status?.records).map((record) => `${record.effective_app ?? ""}=${record.state ?? ""}`);
      parts.push(`f:${block.block_id}:${block.title?.title ?? ""}:${block.process?.foreground?.pid ?? ""}:${states.join(",")}`);
    }
  }
  return parts.join(";");
}

function changesARow(event: RexEvent): boolean {
  if (event.type !== "session_event" || event.inner === undefined) return false;
  if (TOPOLOGY_SESSION_EVENTS.has(event.inner)) return true;
  return event.inner === "block_event" && event.blockEvent !== undefined && PANE_BLOCK_EVENTS.has(event.blockEvent);
}

export class RexWatch implements MuxSubscription {
  private client: RexStreamClient | null = null;
  private timer: WatchTimer | null = null;
  private closed = false;
  private up = false;
  private syncing = false;
  private lastSignature: string | null = null;

  constructor(
    private readonly exec: RexExec,
    private readonly options: MuxWatchOptions,
    private readonly clock: WatchClock = REAL_CLOCK,
  ) {
    this.start();
  }

  private start(): void {
    this.client = this.exec.events({
      onLine: (line) => this.handleLine(line),
      onExit: (reason) => this.end(reason),
    });
    if (this.closed) {
      this.client.kill();
      this.client = null;
      return;
    }
    this.timer = this.clock.setInterval(() => void this.census(), RESYNC_MS);
    void this.census();
  }

  private handleLine(line: string): void {
    if (this.closed) return;
    const event = parseEvent(line);
    if (!event) return;
    if (SPACE_EVENTS.has(event.type)) {
      this.options.onTopologyChange();
      return;
    }
    if (!changesARow(event)) return;
    this.options.onTopologyChange();
    if (event.blockId !== undefined) this.options.onPaneChange(event.blockId);
  }

  private async census(): Promise<void> {
    if (this.closed || this.syncing) return;
    this.syncing = true;
    try {
      const result = await this.exec.run(SNAPSHOT_ARGS);
      if (this.closed) return;
      if (result.code !== 0) {
        if (!this.up || refusalKind(result.code, result.stderr) === "unreachable") {
          this.end(result.stderr.trim() || `rex exited ${String(result.code)}`);
        }
        return;
      }
      const signature = censusSignature(parseTree(result.stdout));
      if (!this.up) {
        this.up = true;
        this.options.onUp();
      }
      if (this.lastSignature !== null && this.lastSignature !== signature) this.options.onTopologyChange();
      this.lastSignature = signature;
    } catch {
      // A listing that did not parse is transient; the next census asks again.
    } finally {
      this.syncing = false;
    }
  }

  private end(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
    const client = this.client;
    this.client = null;
    client?.kill();
    this.options.onDown(reason);
  }

  close(): void {
    this.end("closed");
  }
}
