import { Effect, Match } from "effect";
import { agentGet, follow, herdrSocket, type Lost } from "./observe.ts";
import {
  type Binding,
  type RegistryError,
  type Status,
  Registry,
  RegistryLive,
  stateDir,
} from "./registry.ts";

const usage = `Usage: npm run coordinator -- <command>
  bind <repository-id> <coordinator-id> <absolute-plans-root> <absolute-socket> [herdr-pane]
  list [repository-id]
  show <repository-id> <coordinator-id>
  wake <repository-id> <coordinator-id> <sender> <repo-relative-source> <revision>
  unbind <repository-id> <coordinator-id> <expected-instance>
  wake-receiver <absolute-plans-root> <absolute-socket> <expected-instance> <sender> <repo-relative-source> <revision>
  observe <repository-id> <coordinator-id> <herdr-worker> <repo-relative-source>
`;

const status = Match.type<Status>().pipe(
  Match.tagsExhaustive({
    Live: () => "live",
    Stale: () => "stale",
    Offline: () => "offline",
    Unreachable: (s) => `unreachable (${s.reason})`,
  }),
);
const name = (record: Binding) => `${record.repository} ${record.coordinator}`;

const describe = Match.type<RegistryError | Lost>().pipe(
  Match.tagsExhaustive({
    Invalid: (error) => error.message,
    Unbound: (error) => `No binding for ${error.repository} ${error.coordinator}`,
    AlreadyBound: (error) =>
      `${name(error.record)} is already bound to instance ${error.record.instance} ` +
      `at ${error.record.socket}; unbind that exact instance first`,
    InstanceMismatch: (error) =>
      `${name(error.record)} is bound to instance ${error.record.instance}; nothing removed`,
    Displaced: (error) =>
      `A concurrent bind replaced the record; the non-matching record was left at ${error.path}`,
    Offline: (error) =>
      `Coordinator offline: nothing listening at ${error.socket} (no request delivered)`,
    Stale: (error) =>
      `Binding is stale: receiver at ${error.socket} is no longer instance ${error.instance}; not delivered. ` +
      `Unbind and bind again after verifying the coordinator`,
    Rejected: (error) => `Receiver rejected the request (HTTP ${error.status}): ${error.message}`,
    Uncertain: (error) =>
      `Delivery outcome uncertain: ${error.cause}. Reconcile before resending; do not retry blindly`,
    Lost: (error) => error.message,
  }),
);

const [command, ...args] = process.argv.slice(2);
const arity: Record<string, [number, number]> = {
  bind: [4, 5],
  list: [0, 1],
  show: [2, 2],
  wake: [5, 5],
  unbind: [3, 3],
  "wake-receiver": [6, 6],
  observe: [4, 4],
};
const run = Effect.gen(function* () {
  const registry = yield* Registry;
  // Dispatch the validated CLI command; registry methods own domain behavior.
  switch (command) {
    case "bind": {
      const [repository, coordinator, plansRoot, socket, pane] = args;
      const record = yield* registry.bind({ repository, coordinator, plansRoot, socket, pane });
      return `Bound ${name(record)} to instance ${record.instance}\n`;
    }
    case "list": {
      const lines = ["repository\tcoordinator\tstatus\tpane\tprofile"];
      for (const entry of yield* registry.list(args[0])) {
        lines.push(
          entry._tag === "Corrupt"
            ? `invalid record ${entry.path}`
            : [
                entry.record.repository,
                entry.record.coordinator,
                status(entry.status),
                entry.record.pane ?? "-",
                entry.record.profile,
              ].join("\t"),
        );
      }
      return lines.join("\n") + "\n";
    }
    case "show": {
      const { record, status: s, profile } = yield* registry.show(args[0], args[1]);
      return [
        `repository: ${record.repository}`,
        `coordinator: ${record.coordinator}`,
        `status: ${status(s)}`,
        `instance: ${record.instance}`,
        `socket: ${record.socket}`,
        `pane: ${record.pane ?? "-"}`,
        `plans root: ${record.plansRoot}`,
        `profile: ${record.profile}`,
        `bound at: ${record.boundAt}`,
        "",
        profile,
      ].join("\n");
    }
    case "wake": {
      const [repository, coordinator, sender, source, revision] = args;
      return yield* registry.wake(repository, coordinator, { sender, source, revision });
    }
    case "wake-receiver": {
      const [plansRoot, socket, instance, sender, source, revision] = args;
      return yield* registry.wakeReceiver(
        { plansRoot, socket, instance },
        { sender, source, revision },
      );
    }
    case "observe": {
      // Long-running: one wake per worker stop, each outcome logged, no resends.
      const [repository, coordinator, target, source] = args;
      yield* registry.load(repository, coordinator);
      const socket = herdrSocket();
      const worker = yield* agentGet(socket, target);
      const label = worker.name ?? worker.pane_id;
      const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
      log(
        `observing ${label} (${worker.pane_id}, ${worker.agent_status}) for ${name({ repository, coordinator } as Binding)}`,
      );
      return yield* follow(socket, worker, async (stop) => {
        const revision = `${stop.to}@${stop.at.toISOString()}`;
        const outcome = await Effect.runPromise(
          registry
            .wake(repository, coordinator, { sender: `herdr-observer:${label}`, source, revision })
            .pipe(
              Effect.map((result) => result.trim()),
              Effect.catch((error) => Effect.succeed(`not woken: ${describe(error)}`)),
            ),
        );
        log(`${label} ${stop.from} -> ${stop.to}: ${outcome}`);
      });
    }
    case "unbind": {
      const record = yield* registry.unbind(args[0], args[1], args[2]);
      return `Unbound ${name(record)} instance ${record.instance}\n`;
    }
  }
  return "";
});

const bounds = arity[command];
if (!bounds || args.length < bounds[0] || args.length > bounds[1]) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  Effect.runPromise(
    run.pipe(
      Effect.provide(RegistryLive(stateDir())),
      Effect.catch((error) => Effect.fail(new Error(describe(error)))),
    ),
  ).then(
    (output) => process.stdout.write(output),
    (error) => {
      process.stderr.write(`herdsman: ${error instanceof Error ? error.message : error}\n`);
      process.exitCode = 1;
    },
  );
}
