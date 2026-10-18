import { Effect } from "effect";
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
`;

const status = (s: Status) =>
  s._tag === "Live"
    ? "live"
    : s._tag === "Stale"
      ? "stale"
      : s._tag === "Offline"
        ? "offline"
        : `unreachable (${s.reason})`;
const name = (record: Binding) => `${record.repository} ${record.coordinator}`;

function describe(error: RegistryError) {
  switch (error._tag) {
    case "Invalid":
      return error.message;
    case "Unbound":
      return `No binding for ${error.repository} ${error.coordinator}`;
    case "AlreadyBound":
      return (
        `${name(error.record)} is already bound to instance ${error.record.instance} ` +
        `at ${error.record.socket}; unbind that exact instance first`
      );
    case "InstanceMismatch":
      return `${name(error.record)} is bound to instance ${error.record.instance}; nothing removed`;
    case "Displaced":
      return `A concurrent bind replaced the record; the non-matching record was left at ${error.path}`;
    case "Offline":
      return `Coordinator offline: nothing listening at ${error.socket} (no request delivered)`;
    case "Stale":
      return (
        `Binding is stale: receiver at ${error.socket} is no longer instance ${error.instance}; not delivered. ` +
        `Unbind and bind again after verifying the coordinator`
      );
    case "Rejected":
      return `Receiver rejected the request (HTTP ${error.status}): ${error.message}`;
    case "Uncertain":
      return `Delivery outcome uncertain: ${error.cause}. Reconcile before resending; do not retry blindly`;
  }
}

const [command, ...args] = process.argv.slice(2);
const arity: Record<string, [number, number]> = {
  bind: [4, 5],
  list: [0, 1],
  show: [2, 2],
  wake: [5, 5],
  unbind: [3, 3],
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
