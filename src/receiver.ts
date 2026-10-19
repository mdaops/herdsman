import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";

// Explicit endpoints remain caller-owned. Automatic endpoints belong to this
// receiver scope, not to a coordinator identity or a durable registry entry.
export const receiverSocket = Effect.fn("Receiver.socket")(function* (explicit?: string) {
  const configured = explicit ?? process.env.HERDSMAN_SOCKET;
  if (configured !== undefined) {
    return configured;
  }
  const directory = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "herdsman-"))),
    (directory) => Effect.promise(() => rmdir(directory)),
  );
  return join(directory, "wake.sock");
});

export type Receiver = { socket: string; instance: string };

export function receiverContext(harness: "pi" | "claude-code", receiver: Receiver) {
  const checkout = fileURLToPath(new URL("../", import.meta.url));
  return [
    "Herdsman receiver for THIS session (machine-local runtime, not role or authority):",
    JSON.stringify({ harness, ...receiver, checkout }),
    `Operating skill: ${join(checkout, "skills", "herdsman", "SKILL.md")}`,
    "The socket is listening. For Claude Code, channel opt-in/registration must also be verified.",
    "When authorized to coordinate, inspect existing bindings and bind your assigned plans-repository/coordinator ID to this socket.",
    "Installed but unbound is a setup step, not missing software. Do not silently skip authorized setup.",
    "Never infer ownership from a pane, overwrite another binding, or treat installation as assignment permission.",
    "Workers can send named wakes without a receiver of their own. Save/publish the source before notification.",
    "Use only this current endpoint; reload/session replacement changes it. Retire old bindings explicitly after verification.",
  ].join("\n");
}
