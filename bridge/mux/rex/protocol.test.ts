import { describe, expect, test } from "bun:test";
import {
  colourOnly,
  isPositionalWindowLabel,
  parseEvent,
  parseGridRead,
  parseTree,
  refusalKind,
} from "./protocol.ts";

const ESC = "\u001b";

describe("colourOnly", () => {
  test("keeps SGR colour and weight sequences", () => {
    expect(colourOnly(`${ESC}[0m${ESC}[38;5;2m>${ESC}[0m echo`)).toBe(`${ESC}[0m${ESC}[38;5;2m>${ESC}[0m echo`);
  });

  test("expands cursor-forward into the blanks it skipped", () => {
    expect(colourOnly(`a${ESC}[3Cb`)).toBe("a   b");
    expect(colourOnly(`a${ESC}[Cb`)).toBe("a b");
  });

  test("drops every other control sequence and the carriage returns of the vt format", () => {
    expect(colourOnly(`${ESC}[?25lone\r\ntwo${ESC}[2;3H${ESC}]0;title\u0007`)).toBe("one\ntwo");
  });
});

describe("isPositionalWindowLabel", () => {
  test("is Rex's own name for a window nobody named: Window and the id's last eight characters", () => {
    expect(isPositionalWindowLabel("Window 3e354e86", "window:01a1a320-7186-7ae8-8273-c4c73e354e86")).toBe(true);
  });

  test("is a chosen name otherwise", () => {
    expect(isPositionalWindowLabel("probe-tab2", "window:01a1a320-71af-75d4-aac8-769b4c91600d")).toBe(false);
    expect(isPositionalWindowLabel("Window 3e354e86", "window:01a1a320-71af-75d4-aac8-769b4c91600d")).toBe(false);
  });
});

describe("refusalKind", () => {
  test("a missing block, window or session is gone", () => {
    expect(
      refusalKind(3, 'Error: stream response "control-2" failed: block not found: block:x (status=404 code=not_found)'),
    ).toBe("gone");
    expect(
      refusalKind(0, 'stream response "control-7" failed: session session:x not found (status=404 code=session_not_found)'),
    ).toBe("gone");
    expect(refusalKind(3, 'Error: block target "block:x" not found')).toBe("gone");
  });

  test("no server, a missing binary or a timeout is unreachable", () => {
    expect(refusalKind(4, "Error: no Rex server is running at /tmp/nope.sock, and autostart is disabled")).toBe(
      "unreachable",
    );
    expect(refusalKind(127, "no rex binary found")).toBe("unreachable");
    expect(refusalKind(143, "rex did not answer")).toBe("unreachable");
  });

  test("anything else is Rex answering no, a missing folder included", () => {
    expect(refusalKind(1, "Error: bad_request: data is required")).toBe("refused");
    expect(refusalKind(1, "Error: working directory /nope not found")).toBe("refused");
  });
});

describe("parseTree", () => {
  test("reads sessions and treats an empty Lua table as an empty list", () => {
    const tree = parseTree(
      JSON.stringify({
        sessions: [
          {
            view: {
              session_id: "session:a",
              label: "work",
              active_window_id: "window:a",
              windows: [{ window_id: "window:a", label: "Window 0000000a", focused_block_id: "block:a", layers: {} }],
              clients: {},
            },
            blocks: {},
          },
        ],
      }),
    );
    expect(tree.sessions).toHaveLength(1);
    expect(tree.sessions[0]?.view.windows[0]?.layers).toEqual([]);
    expect(tree.sessions[0]?.blocks).toEqual([]);
    expect(tree.sessions[0]?.view.clients).toEqual([]);
  });

  test("an empty server is an empty list, not a malformed answer", () => {
    expect(parseTree(JSON.stringify({ sessions: {} })).sessions).toEqual([]);
  });

  test("a scalar of the wrong type is dropped rather than trusted", () => {
    const tree = parseTree(
      JSON.stringify({
        sessions: [
          {
            view: { session_id: "session:a", label: 7, windows: [{ window_id: 3 }], clients: [] },
            blocks: [{ block_id: "block:a", process: { foreground: { argv0: 5, pid: "x" } }, title: { title: {} } }, { block_id: 1 }],
          },
        ],
      }),
    );
    const session = tree.sessions[0];
    expect(session?.view.label).toBeUndefined();
    expect(session?.view.windows).toEqual([]);
    expect(session?.blocks).toHaveLength(1);
    expect(session?.blocks[0]?.process?.foreground?.argv0).toBeUndefined();
    expect(session?.blocks[0]?.process?.foreground?.pid).toBeUndefined();
    expect(session?.blocks[0]?.title?.title).toBeUndefined();
  });

  test("a listing without sessions is malformed", () => {
    expect(() => parseTree(JSON.stringify({ nope: true }))).toThrow();
  });
});

describe("parseGridRead", () => {
  test("returns the content and the screen height", () => {
    expect(parseGridRead(JSON.stringify({ rows: 24, content: "a\nb" }))).toEqual({ ok: true, rows: 24, content: "a\nb" });
  });

  test("returns the error a script reported", () => {
    expect(parseGridRead(JSON.stringify({ error: "block not found (status=404 code=not_found)" }))).toEqual({
      ok: false,
      error: "block not found (status=404 code=not_found)",
    });
  });
});

describe("parseEvent", () => {
  test("reads a server event and the session event inside it", () => {
    const line = JSON.stringify({
      type: "session_event",
      payload: {
        session_id: "session:a",
        event: { type: "block_event", payload: { block_id: "block:a", name: "title_changed", payload: {} } },
      },
    });
    expect(parseEvent(line)).toEqual({
      type: "session_event",
      sessionId: "session:a",
      inner: "block_event",
      blockId: "block:a",
      blockEvent: "title_changed",
    });
  });

  test("reads a top-level event", () => {
    expect(parseEvent(JSON.stringify({ type: "session_created", payload: { session_id: "session:a" } }))).toMatchObject({
      type: "session_created",
      sessionId: "session:a",
    });
  });

  test("ignores a line that is not an event", () => {
    expect(parseEvent("not json")).toBeNull();
    expect(parseEvent(JSON.stringify({ nope: 1 }))).toBeNull();
  });
});
