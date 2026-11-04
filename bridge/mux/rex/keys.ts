// Neutral key spelling → `rex send-key`'s grammar.
//
// Rex's key syntax is the contract's own shape: modifiers joined with `+`, lower-case names
// (`ctrl+c`, `shift+tab`, `pageup`, `f12`). Every named key below was sent to `cat -v` in a Rex
// terminal and arrived as its usual escape sequence (MUX_CONTRACT.md **RX**). A `meta` chord
// is refused, because a PTY has no Super key, and `ctrl+Enter` is refused until a probe shows it
// arriving as itself rather than as a plain Enter (../keys.ts `EXTENDED_ONLY_CHORDS`).

import { isExtendedOnlyChord, parseMuxKey, type MuxNamedKey } from "../keys.ts";

const REX_NAMED_KEYS = {
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  Tab: "tab",
  Enter: "enter",
  Escape: "escape",
  Space: "space",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  F1: "f1",
  F2: "f2",
  F3: "f3",
  F4: "f4",
  F5: "f5",
  F6: "f6",
  F7: "f7",
  F8: "f8",
  F9: "f9",
  F10: "f10",
  F11: "f11",
  F12: "f12",
} satisfies Record<MuxNamedKey, string>;

export const REX_UNSENDABLE_KEYS: readonly MuxNamedKey[] = [];

export type RexKeyRejection = "unparsed" | "meta" | "extended";

export type RexKeyResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: RexKeyRejection };

const NAMED_BY_CONTRACT_SPELLING = new Map<string, string>(Object.entries(REX_NAMED_KEYS));

export function toRexKey(spelling: string): RexKeyResult {
  const parsed = parseMuxKey(spelling);
  if (parsed === null) return { ok: false, reason: "unparsed" };
  if (parsed.modifiers.includes("meta")) return { ok: false, reason: "meta" };
  if (isExtendedOnlyChord(spelling)) return { ok: false, reason: "extended" };
  const base = NAMED_BY_CONTRACT_SPELLING.get(parsed.key) ?? parsed.key.toLowerCase();
  return { ok: true, key: [...parsed.modifiers, base].join("+") };
}
