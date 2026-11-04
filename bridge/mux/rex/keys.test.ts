import { describe, expect, test } from "bun:test";
import { MUX_NAMED_KEYS } from "../keys.ts";
import { toRexKey } from "./keys.ts";

describe("toRexKey", () => {
  test("spells every named key in lower case, as rex send-key takes it", () => {
    for (const key of MUX_NAMED_KEYS) {
      const result = toRexKey(key);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.key).toBe(key.toLowerCase());
    }
  });

  test("joins modifiers with a plus, in the contract's order", () => {
    expect(toRexKey("ctrl+c")).toEqual({ ok: true, key: "ctrl+c" });
    expect(toRexKey("shift+Tab")).toEqual({ ok: true, key: "shift+tab" });
    expect(toRexKey("alt+f")).toEqual({ ok: true, key: "alt+f" });
  });

  test("refuses a meta chord and ctrl+Enter", () => {
    expect(toRexKey("meta+a")).toEqual({ ok: false, reason: "meta" });
    expect(toRexKey("ctrl+Enter")).toEqual({ ok: false, reason: "extended" });
  });

  test("refuses a spelling the contract does not parse", () => {
    expect(toRexKey("C-c")).toEqual({ ok: false, reason: "unparsed" });
  });
});
