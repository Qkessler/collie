// REX, BEHIND THE CONTRACT — driving the Rex terminal multiplexer.
//
// ── WHAT IS WHAT ────────────────────────────────────────────────────────────────────────────────
//
// A Rex session is a space, a window is a tab, and a block is a pane. Ids are Rex's own UUIDv7s
// (`session:…`, `window:…`, `block:…`), which never move and are never reused, so they are the
// Collie ids as they stand. Every block call on Rex's API needs its session too, so the adapter
// keeps the block → session map from its last snapshot and takes a fresh one on a miss.
//
// ── AGENTS ──────────────────────────────────────────────────────────────────────────────────────
//
// Rex knows what an agent is: a program reports its state with OSC 7501, and the terminal's
// `program_status` method lists it (`app: claude-code, state: working`). So `agentDetection` is
// declared with no beacon decorator, as tuios does. A record counts only while the process that
// reported it is still the pane's foreground, so an agent that exited reads as a shell again.
//
// ── FOCUS ───────────────────────────────────────────────────────────────────────────────────────
//
// Every Rex session remembers an active window and each window a focused block. The pane a person
// is looking at is the focused block of the active window of a session a Rex APP is attached to (a
// client whose `info.kind` is `app`); the CLI's, an agent's and this adapter's own connections are
// not somebody looking.
// `setFocus` is declined: moving an app to another session is a client action
// (`session.select`) that has not been probed against a real app.

import { basename } from "node:path";
import type { JsonValue } from "../../json.ts";
import { MUX_AGENT_NAMES } from "../agents.ts";
import type { AgentStatus } from "../../types.ts";
import { declareCapabilities } from "../capabilities.ts";
import { EXTENDED_ONLY_CHORDS } from "../keys.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
  muxUnreachable,
  muxUnsupported,
  requestedCwd,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxPane,
  type MuxRefusalOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTab,
  type MuxTabRequest,
  type MuxWatchOptions,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeScope,
} from "../types.ts";
import { resolveRexBinary, SpawnRexExec, type RexExec, type RexRunResult } from "./exec.ts";
import { REX_UNSENDABLE_KEYS, toRexKey } from "./keys.ts";
import { REX_LOGO_SVG } from "./logo.ts";
import { rexBeaconMatcher } from "./markers.ts";
import {
  colourOnly,
  GRID_SCRIPT,
  isPositionalWindowLabel,
  listOf,
  parseGridRead,
  parseTree,
  refusalKind,
  type RexBlockFacts,
  type RexStatusRecord,
  type RexTree,
} from "./protocol.ts";
import { RexWatch, SNAPSHOT_ARGS } from "./watch.ts";

export const REX_MUX = "rex";

/** `MuxTarget.options` key carrying the rex binary's absolute path. */
export const REX_BINARY_OPTION = "rexBin";

/**
 * The scrollback a Rex terminal keeps, in lines. Rex documents it in bytes: "about 64 MiB of
 * scrollback. That is roughly 100,000 lines of plain text at 80 columns, and fewer in a wider
 * terminal or with styled output" (`rex capture --help`). Rex's own figure, read as an upper bound.
 */
const ASSUMED_SCROLLBACK_LINES = 100_000;

const AGENT_BY_REX_APP = new Map<string, string>([
  ["claude-code", "claude"],
  ["claude", "claude"],
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["pi", "pi"],
  ["omp", "omp"],
  ["grok", "grok"],
  ["hermes", "hermes"],
  ["antigravity", "antigravity"],
]);

for (const name of AGENT_BY_REX_APP.values()) {
  if (!MUX_AGENT_NAMES.includes(name)) throw new Error(`rex adapter maps to ${name}, which is not a Collie harness`);
}

/**
 * Rex's reported state in the contract's words. Rex's schema says to treat a state it does not list
 * as `idle`, and `error` has no Collie counterpart: the program stopped and waits for nobody.
 */
function agentStatus(state: string | undefined): AgentStatus {
  switch (state) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/** The agent a block's live status records name, or `null` when none names one Collie has a harness for. */
function reportedAgent(facts: RexBlockFacts | undefined): { agent: string; status: AgentStatus } | null {
  const foregroundPid = facts?.process?.foreground?.pid;
  const records = listOf<RexStatusRecord>(facts?.status?.records);
  for (const record of records) {
    const ownerPid = record.owner?.pid;
    if (ownerPid !== undefined && ownerPid !== foregroundPid) continue;
    const agent = AGENT_BY_REX_APP.get((record.effective_app ?? record.app ?? "").trim().toLowerCase());
    if (agent !== undefined) return { agent, status: agentStatus(record.state) };
  }
  return null;
}

function commandName(facts: RexBlockFacts | undefined): string | undefined {
  const argv0 = facts?.process?.foreground?.argv0 ?? facts?.process?.foreground?.name;
  if (!argv0) return undefined;
  return basename(argv0).replace(/^-/u, "") || undefined;
}

/** The JSON object a `rex api call METHOD -` reads off stdin. */
type RexCallBody = Readonly<Record<string, JsonValue>>;

/**
 * The size a pane Collie creates is asked for: a phone held upright. A block nobody owns keeps Rex's
 * default of 80 by 24, and an agent lays its screen out to whatever width it is given. Any line wider
 * than the phone's mirror wraps a second time and reads as hard-wrapped, at 80 columns and at 200
 * alike (seen on an iPhone 15, which shows 58 columns), so the width is the phone's. Rex applies a
 * resize at once only while no client owns the block, so a Rex app that attaches later still sizes
 * the pane to its own window.
 */
const CREATED_PANE_SIZE = { columns: 56, rows: 60 } as const;

interface RevisionEntry {
  revision: number;
  variants: Map<string, string>;
}

const REX_CAPABILITIES = declareCapabilities({
  supports: [
    "paneGrid",
    "gridScrollback",
    "agentDetection",
    "typeText",
    "sendKeys",
    "closePane",
    "createTab",
    "renameTab",
    "renameSpace",
    "closeTab",
    "createSpace",
    "pushTopologyEvents",
  ],
  spaces: "many",
  topologyLatency: { kind: "push" },
  unsupportedKeys: [...REX_UNSENDABLE_KEYS, ...EXTENDED_ONLY_CHORDS],
  notes: {
    agentDetection:
      "Rex names the agent in a pane from the status the agent reports to the terminal. An agent Collie has no harness for reads as a shell.",
    agentSessionRef: "Rex does not report which conversation an agent runs, so pane history is absent.",
    renamePane:
      "Rex gives every block a label of its own, so after a restart Collie could not tell a name it set from Rex's. Tabs and sessions can be renamed.",
    setFocus:
      "Showing a pane means moving a Rex app to its session, which is a client action not yet proven against a real app.",
    sendKeys: "A Super or Command chord is refused, and so is Ctrl+Enter until it is shown to arrive as itself.",
    listWorktrees: "Rex does not track git worktrees.",
    createWorktree: "Rex does not manage git worktrees.",
    openWorktree: "Rex does not manage git worktrees.",
    listSessions: "Every session of this Rex server is already a space here.",
  },
});

export class RexMux implements MuxAdapter {
  readonly mux = REX_MUX;
  readonly logo = REX_LOGO_SVG;
  readonly capabilities = REX_CAPABILITIES;

  private readonly revisions = new Map<string, RevisionEntry>();
  private sessionOfBlock = new Map<string, string>();
  private sessionOfWindow = new Map<string, string>();

  constructor(private readonly exec: RexExec) {}

  async reachable(): Promise<boolean> {
    try {
      return (await this.exec.run(["ls", "--json"])).code === 0;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<MuxSnapshot> {
    const looked = await this.attemptSnapshot();
    if (!looked.ok) throw new Error(looked.reason === "unreachable" ? looked.detail : `failed to read rex: ${looked.detail}`);
    return looked.value;
  }

  /** Every snapshot is a fresh round trip, so there is nothing to reset. */
  async refresh(): Promise<void> {
    return Promise.resolve();
  }

  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    const read = await this.readScreen(paneId, request.styling === "preserve" ? "vt" : "text");
    if (!read.ok) return read;
    const all = read.value.lines;
    const scoped = request.scope === "viewport" ? all.slice(Math.max(0, all.length - read.value.rows)) : all;
    const kept = scoped.slice(Math.max(0, scoped.length - request.lines));
    const text = kept.join("\n");
    return muxOk({
      paneId,
      text,
      truncated: scoped.length > kept.length,
      revision: this.advanceRevision(paneId, `${request.scope}|${request.styling}|${String(request.lines)}`, text),
    });
  }

  async readLogicalText(paneId: string, lines: number): Promise<MuxOutcome<string>> {
    const read = await this.readScreen(paneId, "text", true);
    if (!read.ok) return read;
    const all = read.value.lines;
    return muxOk(all.slice(Math.max(0, all.length - lines)).join("\n"));
  }

  async typeText(paneId: string, text: string): Promise<MuxAck> {
    if (text.length === 0) return muxAck();
    if (text.includes("\n") || text.includes("\r")) return this.paste(paneId, text);
    return this.blockCall(paneId, "block.method", { method: "write", args: { data: text } });
  }

  /** Rex's paste event wraps the text in paste markers exactly when the program asked for them (**RX**). */
  async pasteText(paneId: string, text: string): Promise<MuxAck> {
    if (text.length === 0) return muxAck();
    return this.paste(paneId, text);
  }

  async writeKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const translated: string[] = [];
    for (const key of keys) {
      const result = toRexKey(key);
      if (!result.ok) {
        if (result.reason === "meta") return muxRefused("Rex cannot send meta chords: a terminal has no Super or Command key");
        if (result.reason === "extended") {
          return muxRefused(`${key} is not known to reach a Rex pane as itself rather than as the plain key, so it is refused`);
        }
        return muxRefused(`Rex cannot send key: ${key}`);
      }
      translated.push(result.key);
    }
    if (translated.length === 0) return muxAck();
    return this.inSessionOf(paneId, async (sessionId) => {
      const sent = await this.attemptRun(["send-key", "-s", sessionId, "-b", paneId, ...translated]);
      return sent.ok ? muxAck() : sent;
    });
  }

  async renamePane(_paneId: string, _label: string | null): Promise<MuxAck> {
    return muxUnsupported("renamePane", "Rex gives every block a label of its own, so Collie names tabs and sessions instead");
  }

  async closePane(paneId: string): Promise<MuxAck> {
    return this.blockCall(paneId, "block.close", {});
  }

  async setFocus(_paneId: string): Promise<MuxAck> {
    return muxUnsupported("setFocus", "Moving a Rex app to a session has not been proven against a real app");
  }

  async createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const looked = await this.attemptSnapshot();
    if (!looked.ok) return looked;
    const space = looked.value.spaces.find((candidate) => candidate.spaceId === request.spaceId);
    if (!space) return muxGone(`space ${request.spaceId} is gone`);
    const args = ["window", "new", "-s", space.spaceId];
    const label = request.label?.trim();
    if (label) args.push(label);
    const cwd = requestedCwd(request.cwd);
    if (cwd) args.push("-c", cwd);
    args.push("--focus=false", "--json");
    const created = await this.attemptRun(args);
    if (!created.ok) return created;
    let parsed: { window_id?: string; block_ids?: string[] };
    try {
      parsed = JSON.parse(created.value.stdout);
    } catch {
      return muxRefused("rex created a tab but its answer did not parse");
    }
    return this.sizeCreated(this.createdPane(parsed, space.spaceId, space.label, cwd));
  }

  async renameTab(tabId: string, label: string): Promise<MuxAck> {
    const sessionId = await this.sessionForWindow(tabId);
    if (!sessionId.ok) return sessionId;
    return this.apiCall("session.set_window_label", { session_id: sessionId.value, window_id: tabId, label });
  }

  async renameSpace(spaceId: string, label: string): Promise<MuxAck> {
    return this.apiCall("session.set_label", { session_id: spaceId, label });
  }

  async closeTab(tabId: string): Promise<MuxAck> {
    const sessionId = await this.sessionForWindow(tabId);
    if (!sessionId.ok) return sessionId;
    return this.apiCall("session.close_window", { session_id: sessionId.value, window_id: tabId });
  }

  async createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    const label = request.label?.trim() || `session-${String(Date.now())}`;
    const args = ["new", label];
    const cwd = requestedCwd(request.cwd);
    if (cwd) args.push("-c", cwd);
    args.push("--json");
    const created = await this.attemptRun(args);
    if (!created.ok) return created;
    let parsed: { session_id?: string; initial_windows?: { window_id?: string; block_ids?: string[] }[] };
    try {
      parsed = JSON.parse(created.value.stdout);
    } catch {
      return muxRefused("rex created a session but its answer did not parse");
    }
    if (!parsed.session_id) return muxRefused("rex created a session but named none");
    return this.sizeCreated(this.createdPane(parsed.initial_windows?.[0] ?? {}, parsed.session_id, label, cwd));
  }

  async listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return muxUnsupported("listWorktrees", "Rex does not track git worktrees");
  }

  async createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return muxUnsupported("createWorktree", "Rex does not manage git worktrees");
  }

  async openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return muxUnsupported("openWorktree", "Rex does not manage git worktrees");
  }

  async listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return muxUnsupported("listSessions", "Every session of this Rex server is already a space here");
  }

  watch(options: MuxWatchOptions): MuxSubscription {
    return new RexWatch(this.exec, options);
  }

  private async paste(paneId: string, text: string): Promise<MuxAck> {
    return this.blockCall(paneId, "block.event", { event: { type: "paste", payload: { text } } });
  }

  private async readScreen(
    paneId: string,
    format: "text" | "vt",
    unwrap = false,
  ): Promise<MuxOutcome<{ lines: string[]; rows: number }>> {
    return this.inSessionOf(paneId, async (sessionId) => {
      const args = JSON.stringify({ session_id: sessionId, block_id: paneId, format, unwrap });
      const ran = await this.attemptRun(["do", "-e", GRID_SCRIPT, "--args", args, "--json"]);
      if (!ran.ok) return ran;
      let read;
      try {
        read = parseGridRead(ran.value.stdout);
      } catch {
        return muxRefused("unreadable answer from the rex grid script");
      }
      if (!read.ok) return refusalFromSentence(read.error);
      const content = format === "vt" ? colourOnly(read.content) : read.content.replaceAll("\r", "");
      return muxOk({ lines: content.replace(/\n$/u, "").split("\n"), rows: read.rows });
    });
  }

  private async blockCall(paneId: string, method: string, fields: RexCallBody): Promise<MuxAck> {
    return this.inSessionOf(paneId, (sessionId) => this.apiCall(method, { session_id: sessionId, block_id: paneId, ...fields }));
  }

  private async apiCall(method: string, body: RexCallBody): Promise<MuxAck> {
    const ran = await this.attemptRun(["api", "call", method, "-"], JSON.stringify(body));
    return ran.ok ? muxAck() : ran;
  }

  /**
   * Runs `act` against the session that holds `paneId`. The session comes from the last snapshot
   * when it is known; a block can move to another session (`session.move_block`), so a cached
   * session that answers `gone` earns one fresh look before the answer is believed.
   */
  private async inSessionOf<T>(paneId: string, act: (sessionId: string) => Promise<MuxOutcome<T>>): Promise<MuxOutcome<T>> {
    const cached = this.sessionOfBlock.get(paneId);
    if (cached !== undefined) {
      const answered = await act(cached);
      if (answered.ok || answered.reason !== "gone") return answered;
      this.sessionOfBlock.delete(paneId);
    }
    const looked = await this.attemptSnapshot();
    if (!looked.ok) return looked;
    const found = this.sessionOfBlock.get(paneId);
    if (found === undefined) return muxGone(`pane ${paneId} is gone`);
    if (found === cached) return muxGone(`pane ${paneId} is gone`);
    return act(found);
  }

  private async sessionForWindow(tabId: string): Promise<MuxOutcome<string>> {
    const looked = await this.attemptSnapshot();
    if (!looked.ok) return looked;
    const found = this.sessionOfWindow.get(tabId);
    return found === undefined ? muxGone(`tab ${tabId} is gone`) : muxOk(found);
  }

  private createdPane(
    window: { window_id?: string; block_ids?: string[] },
    spaceId: string,
    spaceLabel: string,
    cwd: string | undefined,
  ): MuxOutcome<MuxCreatedPane> {
    const paneId = window.block_ids?.[0];
    if (!window.window_id || !paneId) return muxRefused("rex created a pane but named none");
    this.remember(paneId, spaceId, window.window_id);
    return muxOk({ paneId, spaceId, spaceLabel, tabId: window.window_id, cwd: cwd ?? "" });
  }

  /**
   * Asks for {@link CREATED_PANE_SIZE} on a pane this adapter just created. The answer is not the
   * create's: a pane that cannot be resized is still a pane, so a refusal here changes nothing.
   */
  private async sizeCreated(created: MuxOutcome<MuxCreatedPane>): Promise<MuxOutcome<MuxCreatedPane>> {
    if (!created.ok) return created;
    await this.apiCall("block.method", {
      session_id: created.value.spaceId,
      block_id: created.value.paneId,
      method: "resize",
      args: { columns: CREATED_PANE_SIZE.columns, rows: CREATED_PANE_SIZE.rows },
    });
    return created;
  }

  private remember(paneId: string, sessionId: string, windowId: string): void {
    this.sessionOfBlock.set(paneId, sessionId);
    this.sessionOfWindow.set(windowId, sessionId);
  }

  private async attemptSnapshot(): Promise<MuxOutcome<MuxSnapshot>> {
    const ran = await this.attemptRun(SNAPSHOT_ARGS);
    if (!ran.ok) return ran;
    try {
      return muxOk(this.buildSnapshot(parseTree(ran.value.stdout)));
    } catch (err) {
      return muxRefused(`unreadable rex listing: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async attemptRun(args: readonly string[], stdin?: string): Promise<MuxOutcome<RexRunResult>> {
    let result: RexRunResult;
    try {
      result = await this.exec.run(args, stdin);
    } catch (err) {
      return muxUnreachable(err instanceof Error ? err.message : String(err));
    }
    return result.code === 0 ? muxOk(result) : refusalFor(result);
  }

  private advanceRevision(paneId: string, variant: string, text: string): number {
    const tracked = this.revisions.get(paneId) ?? { revision: 1, variants: new Map<string, string>() };
    this.revisions.set(paneId, tracked);
    const digest = contentDigest(text);
    const previous = tracked.variants.get(variant);
    if (previous === undefined) {
      if (tracked.variants.size > 0) tracked.revision += 1;
    } else if (previous !== digest) {
      tracked.revision += 1;
    }
    tracked.variants.delete(variant);
    tracked.variants.set(variant, digest);
    return tracked.revision;
  }

  private buildSnapshot(tree: RexTree): MuxSnapshot {
    const spaces: MuxSpace[] = [];
    const tabs: MuxTab[] = [];
    const panes: MuxPane[] = [];
    const sessionOfBlock = new Map<string, string>();
    const sessionOfWindow = new Map<string, string>();

    tree.sessions.forEach((session, sessionIndex) => {
      const view = session.view;
      const spaceId = view.session_id;
      const spaceLabel = view.label ?? spaceId;
      const spaceNumber = sessionIndex + 1;
      const shown = view.clients.some((client) => client.info?.kind === "app");
      const factsById = new Map(session.blocks.map((facts) => [facts.block_id, facts]));
      const activeTabId = view.active_window_id ?? view.windows[0]?.window_id ?? "";
      let spacePaneCount = 0;
      let spaceFolder: string | undefined;

      view.windows.forEach((window, windowIndex) => {
        const tabId = window.window_id;
        const rawLabel = window.label ?? "";
        const named = rawLabel.length > 0 && !isPositionalWindowLabel(rawLabel, tabId);
        const tabActive = tabId === activeTabId;
        const blockIds = window.layers.flatMap((layer) => layer.blocks.map((block) => block.block_id));
        sessionOfWindow.set(tabId, spaceId);
        let tabPaneCount = 0;

        for (const paneId of blockIds) {
          sessionOfBlock.set(paneId, spaceId);
          const facts = factsById.get(paneId);
          const alive = facts?.process?.last_exit == null;
          if (alive) tabPaneCount += 1;
          const cwd = facts?.process?.foreground?.cwd ?? facts?.process?.child?.cwd ?? "";
          if (spaceFolder === undefined && cwd) spaceFolder = cwd;
          const reported = reportedAgent(facts);
          const title = facts?.title?.title?.trim();
          const command = commandName(facts);
          const rows = facts?.size?.rows;
          panes.push({
            paneId,
            spaceId,
            spaceLabel,
            spaceNumber,
            tabId,
            tabLabel: named ? rawLabel : undefined,
            tabNamed: named ? true : undefined,
            cwd,
            focused: shown && tabActive && window.focused_block_id === paneId,
            alive,
            agent: reported?.agent ?? "shell",
            status: reported?.status ?? "unknown",
            terminalTitle: title || undefined,
            foregroundCommand: command,
            readableLines: (rows ?? 24) + ASSUMED_SCROLLBACK_LINES,
          });
        }
        spacePaneCount += tabPaneCount;
        tabs.push({
          tabId,
          spaceId,
          number: windowIndex + 1,
          label: named ? rawLabel : String(windowIndex + 1),
          focused: tabActive,
          paneCount: tabPaneCount,
        });
      });

      spaces.push({
        spaceId,
        number: spaceNumber,
        label: spaceLabel,
        focused: shown,
        activeTabId,
        tabCount: view.windows.length,
        paneCount: spacePaneCount,
        folder: spaceFolder,
      });
    });

    this.sessionOfBlock = sessionOfBlock;
    this.sessionOfWindow = sessionOfWindow;
    return { panes, spaces, tabs };
  }
}

function refusalFromSentence(sentence: string, code = 1): MuxRefusalOutcome {
  const kind = refusalKind(code, sentence);
  if (kind === "gone") return muxGone(sentence);
  if (kind === "unreachable") return muxUnreachable(sentence);
  return muxRefused(sentence);
}

function refusalFor(result: RexRunResult): MuxRefusalOutcome {
  return refusalFromSentence(result.stderr.trim() || `rex exited ${String(result.code)}`, result.code);
}

function contentDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

export const rexMuxFactory: MuxAdapterFactory = {
  mux: REX_MUX,
  create(target: MuxTarget) {
    const binary = resolveRexBinary(target.options[REX_BINARY_OPTION] ?? "");
    return new RexMux(new SpawnRexExec(binary, target.endpoint, target.timeoutMs || 5000));
  },
  beaconMatcher(target: MuxTarget) {
    const binary = resolveRexBinary(target.options[REX_BINARY_OPTION] ?? "");
    return rexBeaconMatcher(REX_MUX, new SpawnRexExec(binary, target.endpoint, target.timeoutMs || 5000), target.endpoint);
  },
  describeTarget(endpoint: string) {
    return endpoint.trim() ? `server ${endpoint.trim()}` : "its default server";
  },
};
