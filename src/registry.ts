import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { CoordinatorId } from "./domain.ts";
import { Wake, assertPrivateDirectory } from "./bridge.ts";
import { Offline, Rejected, Stale, Uncertain, WakeTransport, WakeTransportLive } from "./client.ts";

// Local routing hints for named coordinators. Not durable ownership, not a lock,
// and not an inventory of durable profiles: plans/coordinators/*.md is that.

export class Invalid extends Data.TaggedError("Invalid")<{ message: string }> {}
export class Unbound extends Data.TaggedError("Unbound")<{
  repository: string;
  coordinator: string;
}> {}
export class AlreadyBound extends Data.TaggedError("AlreadyBound")<{ record: Binding }> {}
export class InstanceMismatch extends Data.TaggedError("InstanceMismatch")<{ record: Binding }> {}
// Unbind took a non-matching record aside and a concurrent bind filled the slot.
export class Displaced extends Data.TaggedError("Displaced")<{ path: string }> {}

export const Binding = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.String,
  coordinator: CoordinatorId,
  plansRoot: Schema.String,
  profile: Schema.String,
  socket: Schema.String,
  instance: Schema.String,
  pane: Schema.NullOr(Schema.String),
  boundAt: Schema.String,
});
export type Binding = typeof Binding.Type;

export const Status = Schema.TaggedUnion({
  Live: {},
  Stale: { instance: Schema.String },
  Offline: {},
  Unreachable: { reason: Schema.String },
});
export type Status = typeof Status.Type;

export const Entry = Schema.TaggedUnion({
  Record: { record: Binding, status: Status },
  Corrupt: { path: Schema.String },
});
export type Entry = typeof Entry.Type;

export function stateDir() {
  const dir = process.env.HERDSMAN_STATE_DIR ?? join(homedir(), ".local", "state", "herdsman");
  if (!isAbsolute(dir)) {
    throw new Error("HERDSMAN_STATE_DIR must be an absolute path");
  }
  return dir;
}

const invalid = (message: string) => Effect.fail(new Invalid({ message }));
const code = (cause: unknown) => (cause as NodeJS.ErrnoException).code;
const io = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new Invalid({ message: `${what}: ${(cause as Error).message}` }),
  });

const checkIds = Effect.fn("Registry.checkIds")(function* (
  repository: string,
  coordinator: string,
) {
  // Repository labels may contain punctuation, but never terminal control characters.
  // oxlint-disable-next-line no-control-regex
  if (repository.length === 0 || repository.length > 256 || /[\0-\x1f\x7f]/.test(repository)) {
    return yield* invalid("Repository id must be 1-256 printable characters");
  }
  return yield* Schema.decodeUnknownEffect(CoordinatorId)(coordinator).pipe(
    Effect.mapError(
      () => new Invalid({ message: "Coordinator id must be a lowercase slug (a-z, 0-9, inner -)" }),
    ),
  );
});

const bindings = (dir: string) => join(dir, "bindings");
const recordPath = (dir: string, repository: string, coordinator: CoordinatorId) =>
  join(
    bindings(dir),
    createHash("sha256")
      .update(JSON.stringify([repository, coordinator]))
      .digest("hex") + ".json",
  );

// Read paths never create state. A missing directory means nothing is bound.
const registry = (dir: string, create: boolean) =>
  io("State directory", async () => {
    if (create) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await mkdir(bindings(dir), { mode: 0o700 }).catch((cause) => {
        if (code(cause) !== "EEXIST") {
          throw cause;
        }
      });
    }
    try {
      await assertPrivateDirectory(dir, "State directory");
      await assertPrivateDirectory(bindings(dir), "Bindings directory");
      return true;
    } catch (cause) {
      if (!create && code(cause) === "ENOENT") {
        return false;
      }
      throw cause;
    }
  });

const decode = (text: string, path: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Binding))(text).pipe(
    Effect.mapError(() => new Invalid({ message: `Invalid binding record ${path}` })),
  );

const readRecord = (path: string) =>
  io("Binding record", () =>
    readFile(path, "utf8").catch((cause) => {
      if (code(cause) === "ENOENT") {
        return undefined;
      }
      throw cause;
    }),
  ).pipe(
    Effect.flatMap((text) => (text === undefined ? Effect.succeed(undefined) : decode(text, path))),
  );

const makeRegistry = Effect.fn("Registry.make")(function* (dir: string) {
  const transport = yield* WakeTransport;

  const load = Effect.fn("Registry.load")(function* (repository: string, coordinator: string) {
    const id = yield* checkIds(repository, coordinator);
    const unbound = new Unbound({ repository, coordinator });
    if (!(yield* registry(dir, false))) {
      return yield* Effect.fail(unbound);
    }
    const record = yield* readRecord(recordPath(dir, repository, id));
    if (!record) {
      return yield* Effect.fail(unbound);
    }
    if (record.repository !== repository || record.coordinator !== coordinator) {
      return yield* invalid(
        `Binding record for ${repository}/${coordinator} names another coordinator`,
      );
    }
    return record;
  });

  // Resolves a root-relative path to a real regular file that stays inside root,
  // rejecting absolute paths, traversal and symlink escapes.
  const resolveInside = Effect.fn("Registry.resolveInside")(function* (
    root: string,
    path: string,
    what: string,
  ) {
    const inside = (base: string, target: string) => {
      const rel = relative(base, target);
      return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
    };
    if (path.length === 0 || isAbsolute(path)) {
      return yield* invalid(`${what} must be a relative path`);
    }
    if (!inside(root, resolve(root, path))) {
      return yield* invalid(`${what} escapes ${root}`);
    }
    const real = yield* io(what, () => realpath(resolve(root, path))).pipe(
      Effect.mapError(
        (error) => new Invalid({ message: `${what} does not exist in ${root}: ${error.message}` }),
      ),
    );
    if (!inside(root, real)) {
      return yield* invalid(`${what} resolves outside ${root} through a symlink`);
    }
    if (!(yield* io(what, () => stat(real))).isFile()) {
      return yield* invalid(`${what} is not a regular file`);
    }
    return real;
  });

  const bind = Effect.fn("Registry.bind")(function* (input: {
    repository: string;
    coordinator: string;
    plansRoot: string;
    socket: string;
    pane?: string;
  }) {
    const coordinator = yield* checkIds(input.repository, input.coordinator);
    if (!isAbsolute(input.plansRoot)) {
      return yield* invalid("Plans root must be an absolute path");
    }
    if (!isAbsolute(input.socket)) {
      return yield* invalid("Socket must be an absolute path");
    }
    if (input.pane !== undefined && !/^[^\s]{1,128}$/.test(input.pane)) {
      return yield* invalid("Herdr pane must be a single token");
    }
    const plansRoot = yield* io("Plans root", () => realpath(input.plansRoot));
    const profile = yield* resolveInside(
      plansRoot,
      `coordinators/${input.coordinator}.md`,
      "Coordinator profile",
    );
    const instance = yield* transport.identify(input.socket);
    const record: Binding = {
      version: 1,
      repository: input.repository,
      coordinator,
      plansRoot,
      profile,
      socket: input.socket,
      instance,
      pane: input.pane ?? null,
      boundAt: new Date().toISOString(),
    };
    yield* registry(dir, true);
    const path = recordPath(dir, input.repository, coordinator);
    // Publish a complete record with an exclusive link; never replace a binding.
    const temp = join(bindings(dir), `.${randomUUID()}.tmp`);
    yield* io("Binding record", () =>
      writeFile(temp, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 }),
    );
    const linked = yield* io("Binding record", () =>
      link(temp, path).then(
        () => true,
        (cause) => {
          if (code(cause) === "EEXIST") {
            return false;
          }
          throw cause;
        },
      ),
    ).pipe(Effect.ensuring(Effect.promise(() => unlink(temp).catch(() => {}))));
    if (!linked) {
      const existing = yield* load(input.repository, coordinator);
      return yield* Effect.fail(new AlreadyBound({ record: existing }));
    }
    return record;
  });

  const probe = Effect.fn("Registry.probe")((record: Binding) =>
    transport.identify(record.socket).pipe(
      Effect.map((instance): Status =>
        instance === record.instance ? { _tag: "Live" } : { _tag: "Stale", instance },
      ),
      Effect.catchTags({
        Offline: () => Effect.succeed<Status>({ _tag: "Offline" }),
        Rejected: (error) => Effect.succeed<Status>({ _tag: "Unreachable", reason: error.message }),
        Uncertain: (error) =>
          Effect.succeed<Status>({ _tag: "Unreachable", reason: String(error.cause) }),
      }),
    ),
  );

  const list = Effect.fn("Registry.list")(function* (repository?: string) {
    if (!(yield* registry(dir, false))) {
      return [];
    }
    const names = (yield* io("Bindings directory", () => readdir(bindings(dir))))
      .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
      .sort();
    const entries: Entry[] = [];
    for (const name of names) {
      const path = join(bindings(dir), name);
      const record = yield* readRecord(path).pipe(
        Effect.catchTag("Invalid", () => Effect.succeed(null)),
      );
      if (record === undefined) {
        continue;
      } // Unbound concurrently.
      if (record === null) {
        entries.push({ _tag: "Corrupt", path });
        continue;
      }
      if (repository !== undefined && record.repository !== repository) {
        continue;
      }
      entries.push({ _tag: "Record", record, status: yield* probe(record) });
    }
    return entries.sort((a, b) =>
      a._tag === "Record" && b._tag === "Record"
        ? a.record.repository.localeCompare(b.record.repository) ||
          a.record.coordinator.localeCompare(b.record.coordinator)
        : 0,
    );
  });

  // The durable profile itself, read from the plans checkout. Its shared-context
  // links are left as written; nothing is copied into runtime state.
  const show = Effect.fn("Registry.show")(function* (repository: string, coordinator: string) {
    const record = yield* load(repository, coordinator);
    const profile = yield* io("Coordinator profile", () => readFile(record.profile, "utf8"));
    return { record, status: yield* probe(record), profile };
  });

  // Never refreshes a stale instance and never retries: the receiver rejects a
  // changed instance, and an uncertain outcome is reported, not resent.
  const wake = Effect.fn("Registry.wake")(function* (
    repository: string,
    coordinator: string,
    input: {
      sender: string;
      source: string;
      revision: string;
    },
  ) {
    const record = yield* load(repository, coordinator);
    const source = yield* resolveInside(record.plansRoot, input.source, "Source");
    const event = yield* Schema.decodeUnknownEffect(Wake)({ ...input, source }).pipe(
      Effect.mapError(
        () => new Invalid({ message: "Sender, source and revision must be 1-2048 characters" }),
      ),
    );
    return yield* transport.send(record.socket, event, record.instance);
  });

  // Removes only the record holding the expected instance. The record is moved
  // aside atomically before checking, so a newer binding is never deleted.
  const unbind = Effect.fn("Registry.unbind")(function* (
    repository: string,
    coordinator: string,
    expected: string,
  ) {
    const current = yield* load(repository, coordinator);
    if (current.instance !== expected) {
      return yield* Effect.fail(new InstanceMismatch({ record: current }));
    }
    const path = recordPath(dir, repository, current.coordinator);
    const aside = join(bindings(dir), `.${randomUUID()}.unbinding`);
    const moved = yield* io("Binding record", () =>
      rename(path, aside).then(
        () => true,
        (cause) => {
          if (code(cause) === "ENOENT") {
            return false;
          }
          throw cause;
        },
      ),
    );
    if (!moved) {
      return yield* Effect.fail(new Unbound({ repository, coordinator }));
    }
    const taken = yield* readRecord(aside);
    if (taken?.instance === expected) {
      yield* io("Binding record", () => unlink(aside));
      return taken;
    }
    // Replaced between check and move: put the newer record back.
    const restored = yield* io("Binding record", () =>
      link(aside, path).then(
        () => true,
        (cause) => {
          if (code(cause) === "EEXIST") {
            return false;
          }
          throw cause;
        },
      ),
    );
    if (!restored) {
      return yield* Effect.fail(new Displaced({ path: aside }));
    }
    yield* io("Binding record", () => unlink(aside));
    return yield* Effect.fail(new InstanceMismatch({ record: taken! }));
  });

  return { load, bind, probe, list, show, wake, unbind };
});

export type RegistryApi = Effect.Success<ReturnType<typeof makeRegistry>>;
export class Registry extends Context.Service<Registry, RegistryApi>()("herdsman/Registry") {
  static layer = (dir: string) => Layer.effect(Registry, makeRegistry(dir));
}

export const RegistryLive = (dir: string) =>
  Registry.layer(dir).pipe(Layer.provide(WakeTransportLive));

export type RegistryError =
  | Invalid
  | Unbound
  | AlreadyBound
  | InstanceMismatch
  | Displaced
  | Offline
  | Stale
  | Rejected
  | Uncertain;
