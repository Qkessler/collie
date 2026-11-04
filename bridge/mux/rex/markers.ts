// HOW A BEACON NAMES ONE OF THIS ADAPTER'S PANES — Rex's half of the join.
//
// A Rex terminal exports `REX_BLOCK` (the block id, which IS the Collie pane id) and `REX_SERVER`
// (the server's address). The scope is that address, so a beacon written in a pane of some other
// Rex server on this host can never name a pane of this one.
//
// Rex already names the agent in a pane from its own wire, so this matcher is used for one thing:
// the session the agent is running, which Rex does not report. The decorator joins it in its
// session-only mode (bridge/beacon/decorate.ts, M74 spec 04), as it does for herdr-core.

import type { BeaconMatcher } from "../../beacon/decorate.ts";
import type { MuxPane } from "../types.ts";
import { globalArgs, type RexExec } from "./exec.ts";

/** The address `-S` is given for a configured endpoint, which is the spelling `REX_SERVER` carries. */
function configuredAddress(endpoint: string): string | null {
  const options = globalArgs(endpoint);
  const at = options.indexOf("-S");
  return at >= 0 ? (options[at + 1] ?? null) : null;
}

interface RexWhoami {
  readonly endpoint?: string;
}

export function rexBeaconMatcher(namespace: string, exec: RexExec, endpoint: string): BeaconMatcher {
  return {
    namespace,
    async scope(): Promise<string | null> {
      const configured = configuredAddress(endpoint);
      if (configured !== null) return configured;
      const answered = await exec.run(["whoami", "--json"]);
      if (answered.code !== 0) return null;
      try {
        // SAFETY: `rex whoami --json` prints one object; `endpoint` is read only when it is a string.
        const whoami = JSON.parse(answered.stdout) as RexWhoami | null;
        const reported = whoami?.endpoint;
        return reported !== undefined && reported.length > 0 ? reported : null;
      } catch {
        return null;
      }
    },
    matches(pane: Pick<MuxPane, "paneId">, marker, scope): boolean {
      return marker.scope === scope && marker.pane === pane.paneId;
    },
    notesWithoutHooks: {
      agentDetection: "Rex names the agent in a pane from the status the agent reports to the terminal.",
      agentSessionRef:
        "Pane history reads the agent's own session log, and Rex does not say which session a pane runs. `collie hooks install claude` supplies it.",
    },
  };
}
