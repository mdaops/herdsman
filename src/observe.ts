import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Data, Effect, Schema } from "effect";

// Watches one worker's Herdr agent status and wakes its owning coordinator when
// the worker stops: finished, idle at a prompt, or blocked. The worker's own
// reporting can be skipped; this is the safety net. It only routes a hint: the
// coordinator inspects the worker and handoff, then decides or notifies the human.

export const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"]);
export type AgentStatus = typeof AgentStatus.Type;

const Agent = Schema.Struct({
  pane_id: Schema.String,
  terminal_id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  agent_status: AgentStatus,
});
export type Agent = typeof Agent.Type;

// One wake per stop: leaving `working`, or newly blocked. `unknown` is not a stop.
export function stopped(previous: AgentStatus, next: AgentStatus) {
  if (next === "blocked") {
    return previous !== "blocked";
  }
  return previous === "working" && (next === "idle" || next === "done");
}

// The worker can no longer be followed by this observer.
export class Lost extends Data.TaggedError("Lost")<{ message: string }> {}

export function herdrSocket() {
  return process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config", "herdr", "herdr.sock");
}

const Reply = Schema.Struct({
  id: Schema.String,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const Event = Schema.Struct({
  event: Schema.String,
  data: Schema.Struct({
    pane_id: Schema.optional(Schema.String),
    previous_pane_id: Schema.optional(Schema.String),
    pane: Schema.optional(Schema.Struct({ pane_id: Schema.String })),
    agent_status: Schema.optional(Schema.Unknown),
  }),
});
const Line = Schema.fromJsonString(Schema.Union([Reply, Event]));

// Herdr speaks newline-delimited JSON; each request gets its own connection.
function open(socket: string, method: string, params: unknown) {
  const connection = connect(socket);
  const lines = createInterface({ input: connection });
  connection.write(JSON.stringify({ id: "herdsman", method, params }) + "\n");
  return { connection, lines };
}

const reply = (text: string) => {
  const line = Schema.decodeUnknownSync(Line)(text);
  if (!("id" in line)) {
    throw new Error("Expected a Herdr reply");
  }
  if (line.error !== undefined) {
    throw new Error(`Herdr error: ${JSON.stringify(line.error)}`);
  }
  return line.result;
};

export const agentGet = (socket: string, target: string) =>
  Effect.tryPromise({
    try: async () => {
      const { connection, lines } = open(socket, "agent.get", { target });
      try {
        const failed = new Promise<never>((_, reject) => connection.once("error", reject));
        const first = lines[Symbol.asyncIterator]().next();
        const { value, done } = await Promise.race([first, failed]);
        if (done) {
          throw new Error("Herdr closed the connection");
        }
        return (reply(value) as { agent?: unknown } | undefined)?.agent;
      } finally {
        connection.destroy();
      }
    },
    catch: (cause) => new Lost({ message: `Cannot resolve worker ${target}: ${cause}` }),
  }).pipe(
    Effect.flatMap((agent) =>
      Schema.decodeUnknownEffect(Agent)(agent).pipe(
        Effect.mapError(() => new Lost({ message: `${target} is not a Herdr agent pane` })),
      ),
    ),
  );

export type Stop = { from: AgentStatus; to: AgentStatus; at: Date };

// Follows the worker pane until it closes, moves or Herdr disconnects. Stops are
// handled one at a time, in order. Resolves only with Lost.
export const follow = (socket: string, worker: Agent, onStop: (stop: Stop) => Promise<void>) =>
  Effect.tryPromise({
    try: () =>
      new Promise<never>((_, reject) => {
        const pane = worker.pane_id;
        const { connection, lines } = open(socket, "events.subscribe", {
          subscriptions: [
            { type: "pane.agent_status_changed", pane_id: pane },
            { type: "pane.closed" },
            { type: "pane.exited" },
            { type: "pane.moved" },
          ],
        });
        let status = worker.agent_status;
        let handled = Promise.resolve();
        const lose = (message: string) => {
          connection.destroy();
          reject(new Lost({ message }));
        };
        connection.on("error", (cause) => lose(`Herdr connection failed: ${cause.message}`));
        lines.on("close", () => lose("Herdr event stream ended"));
        lines.on("line", (text) => {
          let line: typeof Line.Type;
          try {
            line = Schema.decodeUnknownSync(Line)(text);
            if ("id" in line) {
              reply(text);
              return;
            }
          } catch (cause) {
            return lose(`Unexpected Herdr line: ${cause}`);
          }
          const data = line.data;
          if (data.previous_pane_id === pane) {
            return lose(`Worker pane ${pane} moved to ${data.pane?.pane_id}; restart the observer`);
          }
          if (data.pane_id !== pane) {
            return;
          }
          if (/closed|exited/.test(line.event)) {
            return lose(`Worker pane ${pane} ${line.event.replace(/^pane[._]/, "")}`);
          }
          const next = Schema.decodeUnknownOption(AgentStatus)(data.agent_status);
          if (next._tag === "None") {
            return;
          }
          const from = status;
          status = next.value;
          if (stopped(from, status)) {
            const stop = { from, to: status, at: new Date() };
            handled = handled.then(() => onStop(stop));
          }
        });
      }),
    catch: (cause) =>
      cause instanceof Lost ? cause : new Lost({ message: `Observer failed: ${cause}` }),
  });
