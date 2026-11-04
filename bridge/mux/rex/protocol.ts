// What Rex says, and what the adapter asks it — the Lua it runs, the JSON it reads back, and the
// sentences that tell a missing pane from a missing server.
//
// Rex is driven through its CLI and its JSON control API (`rex api`, `rex do`), never its socket
// directly. Every shape below was read off a live server (server 0.0.1793632279, CLI
// 0.0.1793645657, MUX_CONTRACT.md **RX**): `session.list`,
// `session.view`, the terminal block methods `process`, `program_status`, `title`, `size` and
// `format`, and `rex events --all --json`.

import { NO_BINARY_CODE, TIMED_OUT_CODE } from "./exec.ts";

/**
 * Reads the whole herd in one process: every session's view, and for each block its process,
 * reported status, title and size.
 *
 * One `rex do` instead of one `rex api call` per question, because a snapshot asks four questions
 * of every block. `session.view` and the block methods answer only on a connection attached to the
 * session, so the script attaches to each one first; a session that vanishes between the list and
 * the attach is skipped rather than failing the census.
 */
export const SNAPSHOT_SCRIPT = `
local sessions = {}
local listed = rex.call("session.list") or { sessions = {} }
for _, entry in ipairs(listed.sessions or {}) do
  local sessionId = entry.session_id
  local _, attachError = rex.call("session.attach", { session_id = sessionId })
  local view = nil
  if not attachError then view = rex.call("session.view", { session_id = sessionId }) end
  if view then
    local blocks = {}
    for _, window in ipairs(view.windows or {}) do
      for _, layer in ipairs(window.layers or {}) do
        for _, block in ipairs(layer.blocks or {}) do
          local function ask(method)
            local answer = rex.call("block.method", { session_id = sessionId, block_id = block.block_id, method = method })
            return answer
          end
          table.insert(blocks, {
            block_id = block.block_id,
            process = ask("process"),
            status = ask("program_status"),
            title = ask("title"),
            size = ask("size"),
          })
        end
      end
    end
    table.insert(sessions, { view = view, blocks = blocks })
  end
end
return { sessions = sessions }
`;

/**
 * Reads one block's screen and scrollback, and the screen's height so the viewport can be cut from
 * it. Arguments arrive as `rex.args`: `session_id`, `block_id` and `format` (`text` or `vt`).
 *
 * An error is RETURNED rather than raised, so the adapter reads Rex's own words (`code=not_found`)
 * instead of a Lua traceback.
 */
export const GRID_SCRIPT = `
local sessionId = rex.args.session_id
local blockId = rex.args.block_id
local _, attachError = rex.call("session.attach", { session_id = sessionId })
if attachError then return { error = attachError } end
local size, sizeError = rex.call("block.method", { session_id = sessionId, block_id = blockId, method = "size" })
if sizeError then return { error = sizeError } end
local formatted, formatError = rex.call("block.method", {
  session_id = sessionId,
  block_id = blockId,
  method = "format",
  args = { format = rex.args.format, trim = true },
})
if formatError then return { error = formatError } end
return { rows = size.rows, content = formatted.content }
`;

export interface RexProcessInfo {
  readonly pid?: number;
  readonly name?: string;
  readonly argv0?: string;
  readonly cwd?: string;
}

export interface RexProcess {
  readonly last_exit?: unknown;
  readonly child?: RexProcessInfo | null;
  readonly foreground?: RexProcessInfo | null;
}

export interface RexStatusRecord {
  readonly id?: string;
  readonly state?: string;
  readonly app?: string;
  readonly effective_app?: string;
  readonly owner?: { readonly pid?: number } | null;
}

export interface RexBlockFacts {
  readonly block_id: string;
  readonly process?: RexProcess | null;
  readonly status?: { readonly records?: LuaList<RexStatusRecord> } | null;
  readonly title?: { readonly title?: string } | null;
  readonly size?: { readonly rows?: number } | null;
}

export interface RexViewBlock {
  readonly block_id: string;
  readonly label?: string;
  readonly creator_name?: string;
}

export interface RexLayer {
  readonly layer_id?: string;
  readonly blocks: readonly RexViewBlock[];
}

export interface RexWindow {
  readonly window_id: string;
  readonly label?: string;
  readonly focused_block_id?: string;
  readonly layers: readonly RexLayer[];
}

export interface RexClient {
  readonly client_id?: string;
  readonly info?: { readonly kind?: string };
}

export interface RexView {
  readonly session_id: string;
  readonly label?: string;
  readonly active_window_id?: string;
  readonly windows: readonly RexWindow[];
  readonly clients: readonly RexClient[];
}

export interface RexSessionTree {
  readonly view: RexView;
  readonly blocks: readonly RexBlockFacts[];
}

export interface RexTree {
  readonly sessions: readonly RexSessionTree[];
}

/**
 * A list as a Lua script returns it. Rex's Lua encodes an empty table as `{}`, so an empty list
 * arrives as an empty object rather than `[]` (**RX**).
 */
export type LuaList<T> = readonly T[] | Readonly<Record<string, never>>;

export function listOf<T>(value: LuaList<T> | undefined | null): readonly T[] {
  if (value === undefined || value === null || !Array.isArray(value)) return [];
  // SAFETY: `Array.isArray` on a `LuaList<T>` leaves only the `readonly T[]` arm.
  return value as readonly T[];
}

interface RexLayerWire {
  readonly layer_id?: string;
  readonly blocks?: LuaList<RexViewBlock>;
}

interface RexWindowWire {
  readonly window_id: string;
  readonly label?: string;
  readonly focused_block_id?: string;
  readonly layers?: LuaList<RexLayerWire>;
}

interface RexViewWire {
  readonly session_id: string;
  readonly label?: string;
  readonly active_window_id?: string;
  readonly windows?: LuaList<RexWindowWire>;
  readonly clients?: LuaList<RexClient>;
}

interface RexSessionWire {
  readonly view?: RexViewWire | null;
  readonly blocks?: LuaList<RexBlockFacts>;
}

interface RexTreeWire {
  readonly sessions?: LuaList<RexSessionWire>;
}

function normaliseWindow(window: RexWindowWire): RexWindow {
  const layers = listOf(window.layers).map((layer) => ({
    layer_id: textOrUndefined(layer.layer_id),
    blocks: listOf(layer.blocks).filter((block) => typeof block.block_id === "string"),
  }));
  return {
    window_id: window.window_id,
    label: textOrUndefined(window.label),
    focused_block_id: textOrUndefined(window.focused_block_id),
    layers,
  };
}

function normaliseView(view: RexViewWire): RexView {
  return {
    session_id: view.session_id,
    label: textOrUndefined(view.label),
    active_window_id: textOrUndefined(view.active_window_id),
    windows: listOf(view.windows)
      .filter((window) => typeof window.window_id === "string")
      .map(normaliseWindow),
    clients: listOf(view.clients),
  };
}

function normaliseProcessInfo(info: RexProcessInfo | null | undefined): RexProcessInfo | null {
  if (info === undefined || info === null) return null;
  return {
    pid: typeof info.pid === "number" ? info.pid : undefined,
    name: textOrUndefined(info.name),
    argv0: textOrUndefined(info.argv0),
    cwd: textOrUndefined(info.cwd),
  };
}

function normaliseBlockFacts(facts: RexBlockFacts): RexBlockFacts {
  const process = facts.process ?? null;
  return {
    block_id: facts.block_id,
    process:
      process === null
        ? null
        : {
            last_exit: process.last_exit,
            child: normaliseProcessInfo(process.child),
            foreground: normaliseProcessInfo(process.foreground),
          },
    status: { records: listOf(facts.status?.records) },
    title: { title: textOrUndefined(facts.title?.title) },
    size: { rows: typeof facts.size?.rows === "number" ? facts.size.rows : undefined },
  };
}

export function parseTree(stdout: string): RexTree {
  // SAFETY: the snapshot script's own return value. Nothing is read off it unchecked: every list goes
  // through `listOf`, every id is checked to be a string, and every other scalar through `normalise*`.
  const parsed = JSON.parse(stdout) as RexTreeWire | null;
  if (parsed === null || typeof parsed !== "object" || parsed.sessions === undefined) {
    throw new Error("unexpected answer from the rex snapshot script: no sessions");
  }
  const sessions: RexSessionTree[] = [];
  for (const entry of listOf(parsed.sessions)) {
    const view = entry.view;
    if (view === undefined || view === null || typeof view.session_id !== "string") continue;
    const blocks = listOf(entry.blocks).filter((facts) => typeof facts.block_id === "string").map(normaliseBlockFacts);
    sessions.push({ view: normaliseView(view), blocks });
  }
  return { sessions };
}

export type RexGridRead =
  | { readonly ok: true; readonly rows: number; readonly content: string }
  | { readonly ok: false; readonly error: string };

interface RexGridWire {
  readonly rows?: number;
  readonly content?: string;
  readonly error?: string;
}

export function parseGridRead(stdout: string): RexGridRead {
  // SAFETY: the grid script's own return value; each field is checked before it is read.
  const parsed = JSON.parse(stdout) as RexGridWire | null;
  if (parsed === null || typeof parsed !== "object") return { ok: false, error: "unexpected answer from the rex grid script" };
  if (typeof parsed.error === "string") return { ok: false, error: parsed.error };
  if (typeof parsed.content !== "string") return { ok: false, error: "the rex grid script returned no content" };
  const rows = typeof parsed.rows === "number" && parsed.rows > 0 ? parsed.rows : 24;
  return { ok: true, rows, content: parsed.content };
}

/** One line of `rex events --all --json`, reduced to what decides a re-read. */
export interface RexEvent {
  readonly type: string;
  readonly sessionId?: string;
  readonly inner?: string;
  readonly blockId?: string;
  readonly blockEvent?: string;
}

interface RexEventWire {
  readonly type?: string;
  readonly payload?: {
    readonly session_id?: string;
    readonly event?: {
      readonly type?: string;
      readonly payload?: { readonly block_id?: string; readonly name?: string } | null;
    } | null;
  } | null;
}

function textOrUndefined(value: string | null | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseEvent(line: string): RexEvent | null {
  let parsed: RexEventWire | null;
  try {
    // SAFETY: one line of Rex's event stream; every field is checked before it is read.
    parsed = JSON.parse(line.trim()) as RexEventWire | null;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
  const sessionId = textOrUndefined(parsed.payload?.session_id);
  if (parsed.type !== "session_event") return { type: parsed.type, sessionId };
  const inner = textOrUndefined(parsed.payload?.event?.type);
  const blockId = textOrUndefined(parsed.payload?.event?.payload?.block_id);
  const name = textOrUndefined(parsed.payload?.event?.payload?.name);
  return { type: parsed.type, sessionId, inner, blockId, blockEvent: inner === "block_event" ? name : undefined };
}

/**
 * Rex's name for a window nobody named: `Window ` and the last eight characters of its id
 * (`window:01a1a320-7186-7ae8-8273-c4c73e354e86` → `Window 3e354e86`, probed). It is a placeholder,
 * so the tab is reported unnamed, as Herdr reports a positional tab.
 */
export function isPositionalWindowLabel(label: string, windowId: string): boolean {
  return label === `Window ${windowId.slice(-8)}`;
}

const ESCAPE = "\u001b";
const BELL = "\u0007";

function isCsiParameter(char: string): boolean {
  return char >= "0" && char <= "?";
}

function isCsiIntermediate(char: string): boolean {
  return char >= " " && char <= "/";
}

function isCsiFinal(char: string): boolean {
  return char >= "@" && char <= "~";
}

/** Where an OSC string that starts at `start` ends: after its BEL or its `ESC \\`, or the input's end. */
function oscEnd(vt: string, start: number): number {
  for (let index = start; index < vt.length; index += 1) {
    if (vt[index] === BELL) return index + 1;
    if (vt[index] === ESCAPE && vt[index + 1] === "\\") return index + 2;
  }
  return vt.length;
}

/**
 * The `vt` format reduced to what the contract allows on a grid: text and SGR colour, nothing else
 * (ADR 0008). Rex writes a run of blanks as cursor-forward (`ESC[nC`), which is spelled back out as
 * spaces; the vt format's `\r\n` line ends become `\n`; any other control sequence is dropped.
 */
export function colourOnly(vt: string): string {
  let out = "";
  let index = 0;
  while (index < vt.length) {
    const char = vt[index] ?? "";
    if (char !== ESCAPE) {
      if (char !== "\r") out += char;
      index += 1;
      continue;
    }
    const introducer = vt[index + 1];
    if (introducer === "]") {
      index = oscEnd(vt, index + 2);
      continue;
    }
    if (introducer !== "[") {
      index += 2;
      continue;
    }
    let cursor = index + 2;
    while (cursor < vt.length && isCsiParameter(vt[cursor] ?? "")) cursor += 1;
    const parameters = vt.slice(index + 2, cursor);
    while (cursor < vt.length && isCsiIntermediate(vt[cursor] ?? "")) cursor += 1;
    const final = vt[cursor] ?? "";
    if (!isCsiFinal(final)) {
      index = cursor;
      continue;
    }
    if (final === "m" && /^[0-9;:]*$/u.test(parameters)) out += vt.slice(index, cursor + 1);
    if (final === "C" && /^[0-9]*$/u.test(parameters)) out += " ".repeat(Math.max(1, Number(parameters || "1")));
    index = cursor + 1;
  }
  return out;
}

export type RexRefusalKind = "gone" | "unreachable" | "refused";

/**
 * Rex's sentences for something that is not there any more, and only those: the API's own codes and
 * the CLI's `… target "<id>" not found`. A bare "not found" is not enough, because a missing folder
 * for a new tab says it too and is a refusal, not a pane that went away.
 */
const GONE_PATTERNS: readonly RegExp[] = [/code=not_found\b/u, /code=session_not_found\b/u, /target "[^"]*" not found/u];
const UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /no rex server is running/u,
  /connection refused/u,
  /broken pipe/u,
  /server disconnected/u,
];

/**
 * Which of the contract's refusals a failed call is, from its exit code and Rex's own sentence.
 *
 * A missing block, window or session is `gone` (`code=not_found` / `code=session_not_found`, or the
 * CLI's `target … not found`); no server, no binary or a call killed on its budget is
 * `unreachable`; anything else is Rex understanding and saying no.
 */
export function refusalKind(code: number, stderr: string): RexRefusalKind {
  const said = stderr.toLowerCase();
  if (code === NO_BINARY_CODE || code === TIMED_OUT_CODE) return "unreachable";
  if (UNREACHABLE_PATTERNS.some((pattern) => pattern.test(said))) return "unreachable";
  if (GONE_PATTERNS.some((pattern) => pattern.test(said))) return "gone";
  return "refused";
}
