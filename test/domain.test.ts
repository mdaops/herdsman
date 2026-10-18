import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Layer, Schema } from "effect";
import { CoordinatorId, ReviewMode } from "../src/domain.ts";
import { Binding, Entry, Registry, Status } from "../src/registry.ts";
import { Uncertain, WakeTransport } from "../src/client.ts";
import type { Wake } from "../src/bridge.ts";

test("coordinator IDs validate before acquiring their brand", () => {
  const decode = Schema.decodeUnknownSync(CoordinatorId);
  const acceptId = (id: CoordinatorId) => id;
  assert.equal(acceptId(decode("orion-production")), "orion-production");
  // @ts-expect-error Ordinary strings cannot bypass the validated domain type.
  acceptId("orion-production");
  for (const id of ["", "../escape", "Upper", "-leading", "trailing-", "a".repeat(65)]) {
    assert.throws(() => decode(id), Error, id);
  }
  assert.equal(decode("a".repeat(64)).length, 64);
  assert.equal(
    Schema.is(Binding)({
      version: 1,
      repository: "test/plans",
      coordinator: "../escape",
      plansRoot: "/plans",
      profile: "/profile",
      socket: "/socket",
      instance: "instance",
      pane: null,
      boundAt: "now",
    }),
    false,
    "persisted records must validate the same ID",
  );
});

test("status, entry and review mode schemas distinguish their variants", () => {
  assert.deepEqual(Schema.decodeUnknownSync(Status)({ _tag: "Stale", instance: "new" }), {
    _tag: "Stale",
    instance: "new",
  });
  assert.equal(Schema.is(Status)({ _tag: "Stale" }), false);
  assert.equal(Schema.is(Status)({ _tag: "Unknown" }), false);
  assert.deepEqual(Schema.decodeUnknownSync(Entry)({ _tag: "Corrupt", path: "/record" }), {
    _tag: "Corrupt",
    path: "/record",
  });
  assert.equal(Schema.is(Entry)({ _tag: "Record" }), false);
  for (const mode of ["plan", "approve-plan", "code"]) {
    assert.equal(Schema.is(ReviewMode)(mode), true);
  }
  assert.equal(Schema.is(ReviewMode)("deploy"), false);
});

test("registry composes an injected transport and never retries an uncertain send", async () => {
  const root = await mkdtemp(join(tmpdir(), "herdsman-services-"));
  const sends: { socket: string; event: Wake; instance?: string }[] = [];
  const transport = Layer.succeed(WakeTransport, {
    identify: () => Effect.succeed("bound-instance"),
    send: (socket, event, instance) =>
      Effect.sync(() => {
        sends.push({ socket, event, instance });
      }).pipe(Effect.andThen(Effect.fail(new Uncertain({ cause: "connection lost after send" })))),
  });
  try {
    await mkdir(join(root, "coordinators"));
    await writeFile(join(root, "coordinators", "alpha.md"), "# Alpha\n");
    await writeFile(join(root, "handoff.md"), "# Saved evidence\n");
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* Registry;
        const binding = yield* registry.bind({
          repository: "test/plans",
          coordinator: "alpha",
          plansRoot: root,
          socket: join(root, "unused.sock"),
        });
        assert.equal(binding.coordinator, "alpha");
        const error = yield* registry
          .wake("test/plans", "alpha", {
            sender: "worker",
            source: "handoff.md",
            revision: "r1",
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "Uncertain");
      }).pipe(Effect.provide(Registry.layer(join(root, "state")).pipe(Layer.provide(transport)))),
    );
    assert.equal(sends.length, 1);
    assert.equal(sends[0].instance, "bound-instance");
    assert.equal(sends[0].event.source, join(root, "handoff.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
