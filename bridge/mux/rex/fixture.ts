// REX'S CONFORMANCE FIXTURE — the Rex adapter over an in-memory Rex.
//
// The fake answers the argv the adapter really sends, with the JSON shapes and the error sentences a
// live server gave (MUX_CONTRACT.md **RX**): `code=not_found` for a block or window that is gone,
// `code=session_not_found` for a session, `block target "…" not found` from `send-key`, and exit 4
// with "no Rex server is running" while the server is down. A block whose program exits is closed
// and forgotten, as a default Rex terminal is.

import type { MuxConformanceFixture, MuxConformanceWorld, MuxWrite } from "../conformance.ts";
import { RexMux } from "./adapter.ts";
import type { RexExec, RexRunResult, RexStreamClient, RexStreamHandlers } from "./exec.ts";
import { GRID_SCRIPT, SNAPSHOT_SCRIPT } from "./protocol.ts";

const GREEN = "\u001b[38;5;2m";
const RESET = "\u001b[0m";
const ROWS = 3;

interface FakeBlock {
  id: string;
  sessionId: string;
  windowId: string;
  title: string;
  cwd: string;
  argv0: string;
  pid: number;
  agentApp: string | null;
  agentState: string;
  lines: string[];
}

interface FakeWindow {
  id: string;
  sessionId: string;
  label: string;
  focusedBlockId: string;
  blockIds: string[];
}

interface FakeSession {
  id: string;
  label: string;
  activeWindowId: string;
  windowIds: string[];
  appAttached: boolean;
}

/** What the adapter writes to `rex api call METHOD -`, as far as this fake reads it. */
interface FakeApiBody {
  readonly session_id?: string;
  readonly window_id?: string;
  readonly block_id?: string;
  readonly label?: string;
  readonly method?: string;
  readonly args?: { readonly data?: string };
  readonly event?: { readonly type?: string; readonly payload?: { readonly text?: string } };
}

interface FakeGridArgs {
  readonly session_id?: string;
  readonly block_id?: string;
  readonly format?: string;
}

interface FakeListener {
  handlers: RexStreamHandlers;
  ended: boolean;
}

function uuid(sequence: number): string {
  const hex = sequence.toString(16).padStart(12, "0");
  return `01a1a320-0000-7000-8000-${hex}`;
}

function notFound(kind: "block" | "window", id: string): RexRunResult {
  const sentence = kind === "block" ? `block not found: ${id}` : `window ${id} not found`;
  return { code: 3, stdout: "", stderr: `Error: stream response "control-2" failed: ${sentence} (status=404 code=not_found)\n` };
}

function sessionNotFound(id: string): RexRunResult {
  return {
    code: 3,
    stdout: "",
    stderr: `Error: stream response "control-2" failed: session ${id} not found (status=404 code=session_not_found)\n`,
  };
}

const ok = (stdout = "{}"): RexRunResult => ({ code: 0, stdout, stderr: "" });

export class FakeRex implements RexExec {
  private sessions = new Map<string, FakeSession>();
  private windows = new Map<string, FakeWindow>();
  private blocks = new Map<string, FakeBlock>();
  private readonly listeners = new Set<FakeListener>();
  private readonly recorded: MuxWrite[] = [];
  private sequence = 100;
  private connected = true;

  constructor() {
    this.seed();
  }

  private nextId(kind: "session" | "window" | "block"): string {
    this.sequence += 1;
    return `${kind}:${uuid(this.sequence)}`;
  }

  private seed(): void {
    const work = this.addSession("Default", true, "/home/denis");
    const workFirstWindow = this.windows.get(work.activeWindowId);
    if (workFirstWindow) {
      const second = this.addBlock(work.id, workFirstWindow.id, "/home/denis");
      second.argv0 = "-bash";
      second.title = "bash";
    }
    const docs = this.addWindow(work.id, "docs", "/home/denis/docs");
    const docsBlock = this.blocks.get(docs.blockIds[0] ?? "");
    if (docsBlock) {
      docsBlock.argv0 = "vim";
      docsBlock.title = "vim";
    }
    const other = this.addSession("Work", false, "/home/denis/work");
    const devWindow = this.windows.get(other.activeWindowId);
    if (devWindow) devWindow.label = "dev";
    const agentBlock = this.blocks.get(devWindow?.blockIds[0] ?? "");
    if (agentBlock) {
      agentBlock.argv0 = "claude";
      agentBlock.title = "Claude Code";
      agentBlock.agentApp = "claude-code";
      agentBlock.agentState = "working";
      agentBlock.lines = ["╭─ Claude Code", "│ > hello", "╰─"];
    }
  }

  private addSession(label: string, appAttached: boolean, cwd: string): FakeSession {
    const session: FakeSession = { id: this.nextId("session"), label, activeWindowId: "", windowIds: [], appAttached };
    this.sessions.set(session.id, session);
    const window = this.addWindow(session.id, "", cwd);
    session.activeWindowId = window.id;
    return session;
  }

  private addWindow(sessionId: string, label: string, cwd: string): FakeWindow {
    const id = this.nextId("window");
    const window: FakeWindow = { id, sessionId, label: label || `Window ${id.slice(-8)}`, focusedBlockId: "", blockIds: [] };
    this.windows.set(id, window);
    this.sessions.get(sessionId)?.windowIds.push(id);
    const block = this.addBlock(sessionId, id, cwd);
    window.focusedBlockId = block.id;
    return window;
  }

  private addBlock(sessionId: string, windowId: string, cwd: string): FakeBlock {
    const block: FakeBlock = {
      id: this.nextId("block"),
      sessionId,
      windowId,
      title: `denis@host:${cwd}`,
      cwd,
      argv0: "-zsh",
      pid: this.sequence * 10,
      agentApp: null,
      agentState: "idle",
      lines: ["history 1", "history 2", "$ ls", "file-a  file-b", "$ "],
    };
    this.blocks.set(block.id, block);
    this.windows.get(windowId)?.blockIds.push(block.id);
    return block;
  }

  writes(): readonly MuxWrite[] {
    return this.recorded;
  }

  emitSessionEvent(sessionId: string, type: string, payload: Readonly<Record<string, string | number>> = {}): void {
    const line = JSON.stringify({ type: "session_event", payload: { session_id: sessionId, event: { type, payload } } });
    for (const listener of this.listeners) if (!listener.ended) listener.handlers.onLine(line);
  }

  async run(args: readonly string[], stdin?: string): Promise<RexRunResult> {
    await Promise.resolve();
    if (!this.connected) {
      return { code: 4, stdout: "", stderr: "Error: no Rex server is running at /run/user/1000/rex/server.sock, and autostart is disabled\n" };
    }
    const [verb, second] = args;
    if (verb === "ls") return ok(JSON.stringify({ sessions: [...this.sessions.values()].map((s) => ({ session_id: s.id, label: s.label })) }));
    if (verb === "do" && args[2] === SNAPSHOT_SCRIPT) return ok(this.treeJson());
    if (verb === "do" && args[2] === GRID_SCRIPT) {
      // SAFETY: the adapter passes the grid script a JSON object of these three strings.
      const gridArgs = JSON.parse(args[4] ?? "{}") as FakeGridArgs;
      return this.grid(gridArgs);
    }
    if (verb === "api" && second === "call" && args[3] === "-") {
      // SAFETY: the adapter writes a JSON object of the shape `FakeApiBody` lists to stdin.
      const body = JSON.parse(stdin ?? "{}") as FakeApiBody;
      return this.apiCall(args[2] ?? "", body);
    }
    if (verb === "send-key") return this.sendKey(args.slice(1));
    if (verb === "window" && second === "new") return this.newWindow(args.slice(2));
    if (verb === "new") return this.newSession(args.slice(1));
    return { code: 1, stdout: "", stderr: `Error: unknown command "${verb ?? ""}" for "rex"\n` };
  }

  events(handlers: RexStreamHandlers): RexStreamClient {
    const listener: FakeListener = { handlers, ended: false };
    this.listeners.add(listener);
    return {
      kill: () => {
        listener.ended = true;
        this.listeners.delete(listener);
        handlers.onExit("closed");
      },
    };
  }

  private treeJson(): string {
    const sessions = [...this.sessions.values()].map((session) => ({
      view: {
        session_id: session.id,
        label: session.label,
        active_window_id: session.activeWindowId,
        windows: session.windowIds.flatMap((windowId) => {
          const window = this.windows.get(windowId);
          if (!window) return [];
          return [
            {
              window_id: window.id,
              label: window.label,
              focused_block_id: window.focusedBlockId,
              layers: [
                {
                  layer_id: `layer:${window.id.slice(7)}`,
                  kind: "tiled",
                  blocks: window.blockIds.map((blockId) => ({
                    block_id: blockId,
                    label: "shell",
                    creator_name: "com.superlogical.terminal",
                  })),
                },
              ],
            },
          ];
        }),
        clients: [
          { client_id: "client:cli", info: { kind: "cli" } },
          ...(session.appAttached ? [{ client_id: "client:app", info: { kind: "app" } }] : []),
        ],
      },
      blocks: [...this.blocks.values()]
        .filter((block) => block.sessionId === session.id)
        .map((block) => ({
          block_id: block.id,
          process: {
            last_exit: null,
            child: { pid: block.pid - 1, name: "zsh", argv0: "-zsh", cwd: block.cwd },
            foreground: { pid: block.pid, name: block.argv0.replace(/^-/u, ""), argv0: block.argv0, cwd: block.cwd },
          },
          status: {
            records:
              block.agentApp === null
                ? {}
                : [{ state: block.agentState, app: block.agentApp, effective_app: block.agentApp, owner: { pid: block.pid } }],
          },
          title: { title: block.title },
          size: { columns: 80, rows: ROWS },
        })),
    }));
    return JSON.stringify({ sessions: sessions.length === 0 ? {} : sessions });
  }

  private grid(request: FakeGridArgs): RexRunResult {
    const session = this.sessions.get(request.session_id ?? "");
    if (!session) return ok(JSON.stringify({ error: sessionNotFound(request.session_id ?? "").stderr.replace(/^Error: /u, "").trim() }));
    const block = this.blocks.get(request.block_id ?? "");
    if (!block || block.sessionId !== session.id) {
      return ok(JSON.stringify({ error: notFound("block", request.block_id ?? "").stderr.replace(/^Error: /u, "").trim() }));
    }
    const vt = request.format === "vt";
    const content = block.lines.map((line) => (vt ? `${RESET}${GREEN}${line.replaceAll("  ", "\u001b[2C")}${RESET}\r` : line)).join("\n");
    return ok(JSON.stringify({ rows: ROWS, content: `${content}\n` }));
  }

  private apiCall(method: string, body: FakeApiBody): RexRunResult {
    const sessionId = String(body.session_id ?? "");
    const session = this.sessions.get(sessionId);
    if (!session) return sessionNotFound(sessionId);
    if (method === "session.set_label") {
      session.label = String(body.label ?? "");
      this.emitSessionEvent(session.id, "session_label_changed", { label: session.label });
      return ok(JSON.stringify({ revision: this.sequence }));
    }
    if (method === "session.set_window_label" || method === "session.close_window") {
      const window = this.windows.get(String(body.window_id ?? ""));
      if (!window || window.sessionId !== session.id) return notFound("window", String(body.window_id ?? ""));
      if (method === "session.set_window_label") {
        window.label = String(body.label ?? "");
      } else {
        for (const blockId of window.blockIds) this.forgetBlock(blockId);
      }
      this.emitSessionEvent(session.id, "session_view_changed", { revision: this.sequence });
      return ok(JSON.stringify({ revision: this.sequence }));
    }
    const block = this.blocks.get(String(body.block_id ?? ""));
    if (!block || block.sessionId !== session.id) return notFound("block", String(body.block_id ?? ""));
    if (method === "block.close") {
      this.forgetBlock(block.id);
      this.emitSessionEvent(session.id, "block_closed", { block_id: block.id });
      return ok(JSON.stringify({ block_id: block.id, revision: this.sequence }));
    }
    if (method === "block.method" && body.method === "write") {
      const data = body.args?.data ?? "";
      this.recorded.push({ paneId: block.id, kind: "text", payload: [data] });
      this.paint(block, data);
      return ok(JSON.stringify({ bytes_written: Buffer.byteLength(data, "utf8") }));
    }
    if (method === "block.event") {
      if (body.event?.type !== "paste") return { code: 1, stdout: "", stderr: "Error: bad_request: unknown event\n" };
      const text = body.event.payload?.text ?? "";
      this.recorded.push({ paneId: block.id, kind: "text", payload: [text] });
      this.paint(block, text);
      return ok();
    }
    return { code: 1, stdout: "", stderr: `Error: method_not_found: ${method}\n` };
  }

  private paint(block: FakeBlock, text: string): void {
    const last = block.lines.length - 1;
    block.lines[last] = `${block.lines[last] ?? ""}${text}`;
  }

  private sendKey(rest: readonly string[]): RexRunResult {
    const sessionId = rest[rest.indexOf("-s") + 1] ?? "";
    const blockId = rest[rest.indexOf("-b") + 1] ?? "";
    const keys = rest.filter((_, index) => index !== rest.indexOf("-s") && index !== rest.indexOf("-s") + 1 && index !== rest.indexOf("-b") && index !== rest.indexOf("-b") + 1);
    const session = this.sessions.get(sessionId);
    const block = this.blocks.get(blockId);
    if (!session) return { code: 3, stdout: "", stderr: `Error: block target "${blockId}" not found: session scope: session "${sessionId}" not found\n` };
    if (!block || block.sessionId !== session.id) return { code: 3, stdout: "", stderr: `Error: block target "${blockId}" not found\n` };
    this.recorded.push({ paneId: block.id, kind: "keys", payload: keys });
    return ok("");
  }

  private optionValue(rest: readonly string[], flag: string): string | undefined {
    const at = rest.indexOf(flag);
    return at >= 0 ? rest[at + 1] : undefined;
  }

  private newWindow(rest: readonly string[]): RexRunResult {
    const sessionId = this.optionValue(rest, "-s") ?? "";
    const session = this.sessions.get(sessionId);
    if (!session) return { code: 3, stdout: "", stderr: `Error: session target "${sessionId}" not found\n` };
    const flagsWithValues = new Set(["-s", "-c"]);
    const label = rest.find((word, index) => !word.startsWith("-") && !flagsWithValues.has(rest[index - 1] ?? "")) ?? "";
    const window = this.addWindow(session.id, label, this.optionValue(rest, "-c") ?? "/home/denis");
    this.emitSessionEvent(session.id, "window_created", { window_id: window.id, label: window.label });
    return ok(JSON.stringify({ window_id: window.id, block_ids: window.blockIds, revision: this.sequence }));
  }

  private newSession(rest: readonly string[]): RexRunResult {
    const label = rest[0] && !rest[0].startsWith("-") ? rest[0] : "session";
    const session = this.addSession(label, false, this.optionValue(rest, "-c") ?? "/home/denis");
    const window = this.windows.get(session.activeWindowId);
    for (const listener of this.listeners) {
      if (!listener.ended) listener.handlers.onLine(JSON.stringify({ type: "session_created", payload: { session_id: session.id } }));
    }
    return ok(
      JSON.stringify({
        session_id: session.id,
        initial_windows: [{ window_id: window?.id, block_ids: window?.blockIds ?? [], revision: 1 }],
      }),
    );
  }

  private forgetBlock(blockId: string): void {
    const block = this.blocks.get(blockId);
    if (!block) return;
    this.blocks.delete(blockId);
    const window = this.windows.get(block.windowId);
    if (!window) return;
    window.blockIds = window.blockIds.filter((id) => id !== blockId);
    if (window.focusedBlockId === blockId) window.focusedBlockId = window.blockIds[0] ?? "";
    if (window.blockIds.length > 0) return;
    this.windows.delete(window.id);
    const session = this.sessions.get(window.sessionId);
    if (!session) return;
    session.windowIds = session.windowIds.filter((id) => id !== window.id);
    if (session.activeWindowId === window.id) session.activeWindowId = session.windowIds[0] ?? "";
    if (session.windowIds.length === 0) this.sessions.delete(session.id);
  }

  // ── Conformance perturbations ───────────────────────────────────

  async reconnect(): Promise<void> {
    this.connected = false;
    await Promise.resolve();
    this.connected = true;
  }

  async restartMux(): Promise<void> {
    this.sessions = new Map([...this.sessions].map(([id, session]) => [id, { ...session, windowIds: [...session.windowIds] }]));
    this.windows = new Map([...this.windows].map(([id, window]) => [id, { ...window, blockIds: [...window.blockIds] }]));
    this.blocks = new Map([...this.blocks].map(([id, block]) => [id, { ...block, lines: [...block.lines] }]));
    await Promise.resolve();
  }

  async renameOutOfBand(paneId: string, label: string): Promise<void> {
    const block = this.blocks.get(paneId);
    const window = block ? this.windows.get(block.windowId) : undefined;
    if (window) window.label = label;
    await Promise.resolve();
  }

  async setProgramTitle(paneId: string, title: string): Promise<void> {
    const block = this.blocks.get(paneId);
    if (block) block.title = title;
    await Promise.resolve();
  }

  async changePane(paneId: string): Promise<void> {
    const block = this.blocks.get(paneId);
    if (block) block.lines.push(`paint ${String(this.sequence++)}`);
    await Promise.resolve();
  }

  async endPane(paneId: string): Promise<void> {
    this.forgetBlock(paneId);
    await Promise.resolve();
  }

  async focusOutOfBand(paneId: string): Promise<void> {
    const block = this.blocks.get(paneId);
    if (!block) return;
    const window = this.windows.get(block.windowId);
    const session = this.sessions.get(block.sessionId);
    if (!window || !session) return;
    window.focusedBlockId = block.id;
    session.activeWindowId = window.id;
    for (const candidate of this.sessions.values()) candidate.appAttached = candidate.id === session.id;
    await Promise.resolve();
  }

  async pokeTopologyOutOfBand(): Promise<void> {
    const window = [...this.windows.values()][0];
    if (window) window.label = "silent-rename";
    await Promise.resolve();
  }

  async pokeTopology(): Promise<void> {
    const session = [...this.sessions.values()][0];
    if (session) this.emitSessionEvent(session.id, "session_view_changed", { revision: this.sequence });
    await Promise.resolve();
  }
}

export function rexWorld(fake: FakeRex): MuxConformanceWorld {
  return {
    adapter: new RexMux(fake),
    writes: () => fake.writes(),
    reconnect: () => fake.reconnect(),
    restartMux: () => fake.restartMux(),
    renameOutOfBand: (paneId, label) => fake.renameOutOfBand(paneId, label),
    setProgramTitle: (paneId, title) => fake.setProgramTitle(paneId, title),
    changePane: (paneId) => fake.changePane(paneId),
    endPane: (paneId) => fake.endPane(paneId),
    focusOutOfBand: (paneId) => fake.focusOutOfBand(paneId),
    pokeTopologyOutOfBand: () => fake.pokeTopologyOutOfBand(),
    pokeTopology: () => fake.pokeTopology(),
    close: () => Promise.resolve(),
  };
}

export const rexConformanceFixture: MuxConformanceFixture = {
  mux: "rex",
  create(): Promise<MuxConformanceWorld> {
    return Promise.resolve(rexWorld(new FakeRex()));
  },
};
