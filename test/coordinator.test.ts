import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { Effect, Exit, Scope } from "effect";
import { listen, type Wake } from "../src/bridge.ts";
import { bind, list, show, unbind, wake } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));
const event = { sender: "worker", source: "handoffs/h.md", revision: "r1" };

async function receiver(socket: string) {
  const scope = Scope.makeUnsafe();
  const received: Wake[] = [];
  const instance = await run(
    listen(socket, (wake) =>
      Effect.sync(() => {
        received.push(wake);
      }),
    ).pipe(Scope.provide(scope)),
  );
  return { socket, instance, received, close: () => run(Scope.close(scope, Exit.void)) };
}

async function plans(root: string) {
  await mkdir(join(root, "coordinators"), { recursive: true });
  await mkdir(join(root, "context"));
  await mkdir(join(root, "handoffs"));
  await writeFile(join(root, "context", "shared.md"), "# Shared context\n");
  for (const id of ["alpha", "beta"]) {
    await writeFile(
      join(root, "coordinators", `${id}.md`),
      `# Coordinator ${id}\n\nContext: [shared](../context/shared.md)\n`,
    );
  }
  await writeFile(join(root, "handoffs", "h.md"), "# Handoff\n");
  return root;
}

async function tree(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true })).sort();
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "herdsman-n-"));
  const state = await mkdtemp(join(dir, "state-"));
  const sockets = await mkdtemp(join(dir, "sock-"));
  const root = await plans(join(dir, "plans"));
  await writeFile(join(dir, "outside.md"), "# Outside\n");
  await symlink(join(dir, "outside.md"), join(root, "handoffs", "escape.md"));
  const a = await receiver(join(sockets, "a.sock"));
  const b = await receiver(join(sockets, "b.sock"));
  return {
    dir,
    state,
    sockets,
    root,
    a,
    b,
    async cleanup() {
      await a.close();
      await b.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const coordinator = promisify(execFile);
const cli = (state: string, ...args: string[]) =>
  coordinator(process.execPath, ["--import", "tsx", "src/coordinator.ts", ...args], {
    env: { ...process.env, HERDSMAN_STATE_DIR: state },
  });

test("named routing delivers only to the selected coordinator, isolated by repository", async () => {
  const f = await fixture();
  try {
    await run(
      bind(f.state, {
        repository: "org/one",
        coordinator: "alpha",
        plansRoot: f.root,
        socket: f.a.socket,
        pane: "w5:p17",
      }),
    );
    await run(
      bind(f.state, {
        repository: "org/one",
        coordinator: "beta",
        plansRoot: f.root,
        socket: f.b.socket,
      }),
    );
    await run(
      bind(f.state, {
        repository: "org/two",
        coordinator: "alpha",
        plansRoot: f.root,
        socket: f.b.socket,
      }),
    );
    assert.match(await run(wake(f.state, "org/one", "alpha", event)), /^accepted by adapter/);
    assert.deepEqual(f.a.received, [{ ...event, source: join(f.root, "handoffs", "h.md") }]);
    assert.equal(f.b.received.length, 0);
    await run(wake(f.state, "org/two", "alpha", event));
    await run(wake(f.state, "org/one", "beta", event));
    assert.equal(f.a.received.length, 1);
    assert.equal(f.b.received.length, 2);
    assert.equal((await failure(wake(f.state, "org/three", "alpha", event)))._tag, "Unbound");
  } finally {
    await f.cleanup();
  }
});

test("duplicate bind is rejected and a failed bind reserves nothing", async () => {
  const f = await fixture();
  try {
    const first = await run(
      bind(f.state, {
        repository: "org/one",
        coordinator: "alpha",
        plansRoot: f.root,
        socket: f.a.socket,
      }),
    );
    const duplicate = await failure(
      bind(f.state, {
        repository: "org/one",
        coordinator: "alpha",
        plansRoot: f.root,
        socket: f.b.socket,
      }),
    );
    assert.equal(duplicate._tag, "AlreadyBound");
    await run(wake(f.state, "org/one", "alpha", event));
    assert.equal(f.a.received.length, 1, "original binding kept");
    assert.equal(first.instance, f.a.instance);

    await f.b.close();
    assert.equal(
      (
        await failure(
          bind(f.state, {
            repository: "org/one",
            coordinator: "beta",
            plansRoot: f.root,
            socket: f.b.socket,
          }),
        )
      )._tag,
      "Offline",
    );
    assert.equal(
      (
        await failure(
          bind(f.state, {
            repository: "org/one",
            coordinator: "gamma",
            plansRoot: f.root,
            socket: f.a.socket,
          }),
        )
      )._tag,
      "Invalid",
    );
    assert.equal(
      (
        await failure(
          bind(f.state, {
            repository: "org/one",
            coordinator: "../alpha",
            plansRoot: f.root,
            socket: f.a.socket,
          }),
        )
      )._tag,
      "Invalid",
    );
    assert.equal((await readdir(join(f.state, "bindings"))).length, 1);
    assert.equal((await run(list(f.state))).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("a restarted receiver at the same socket is stale; offline is explicit", async () => {
  const f = await fixture();
  try {
    await run(
      bind(f.state, {
        repository: "org/one",
        coordinator: "alpha",
        plansRoot: f.root,
        socket: f.a.socket,
      }),
    );
    await f.a.close();
    const restarted = await receiver(f.a.socket);
    try {
      assert.notEqual(restarted.instance, f.a.instance);
      const stale = await failure(wake(f.state, "org/one", "alpha", event));
      assert.equal(stale._tag, "Stale");
      assert.equal(restarted.received.length, 0);
      const [entry] = await run(list(f.state));
      assert.equal(entry._tag === "Record" && entry.status._tag, "Stale");
    } finally {
      await restarted.close();
    }
    assert.equal((await failure(wake(f.state, "org/one", "alpha", event)))._tag, "Offline");
    const [entry] = await run(list(f.state));
    assert.equal(entry._tag === "Record" && entry.status._tag, "Offline");
  } finally {
    await f.cleanup();
  }
});

test("wake sources must stay inside the receiver's plans root", async () => {
  const f = await fixture();
  try {
    await run(
      bind(f.state, {
        repository: "org/one",
        coordinator: "alpha",
        plansRoot: f.root,
        socket: f.a.socket,
      }),
    );
    for (const source of [
      "../outside.md",
      "handoffs/../../outside.md",
      join(f.dir, "outside.md"),
      "handoffs/escape.md",
      "handoffs/missing.md",
      "handoffs",
    ]) {
      const error = await failure(wake(f.state, "org/one", "alpha", { ...event, source }));
      assert.equal(error._tag, "Invalid", source);
    }
    assert.equal(f.a.received.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("unbind removes only the expected instance", async () => {
  const f = await fixture();
  try {
    await run(
      bind(f.state, {
        repository: "org/one",
        coordinator: "alpha",
        plansRoot: f.root,
        socket: f.a.socket,
      }),
    );
    assert.equal(
      (await failure(unbind(f.state, "org/one", "alpha", f.b.instance)))._tag,
      "InstanceMismatch",
    );
    await run(wake(f.state, "org/one", "alpha", event));
    assert.equal(f.a.received.length, 1, "mismatch preserved the record");
    assert.equal(
      (await run(unbind(f.state, "org/one", "alpha", f.a.instance))).instance,
      f.a.instance,
    );
    assert.equal((await failure(wake(f.state, "org/one", "alpha", event)))._tag, "Unbound");
    assert.deepEqual(await readdir(join(f.state, "bindings")), []);
  } finally {
    await f.cleanup();
  }
});

test("list and show read durable profiles sharing one context file without copying it", async () => {
  const f = await fixture();
  try {
    const before = await tree(f.root);
    await cli(f.state, "bind", "org/one", "alpha", f.root, f.a.socket, "w5:p17");
    await cli(f.state, "bind", "org/one", "beta", f.root, f.b.socket);
    const { stdout: listed } = await cli(f.state, "list", "org/one");
    assert.deepEqual(listed.trim().split("\n").slice(1), [
      ["org/one", "alpha", "live", "w5:p17", join(f.root, "coordinators", "alpha.md")].join("\t"),
      ["org/one", "beta", "live", "-", join(f.root, "coordinators", "beta.md")].join("\t"),
    ]);
    for (const id of ["alpha", "beta"]) {
      const { stdout } = await cli(f.state, "show", "org/one", id);
      assert.ok(
        stdout.endsWith(`# Coordinator ${id}\n\nContext: [shared](../context/shared.md)\n`),
      );
      assert.match(stdout, new RegExp(`instance: ${id === "alpha" ? f.a.instance : f.b.instance}`));
    }
    const shown = await run(show(f.state, "org/one", "beta"));
    assert.equal(shown.status._tag, "Live");
    assert.deepEqual(await tree(f.root), before, "plans checkout unchanged");
    assert.deepEqual(
      (await tree(f.state)).filter((name) => !/^bindings(\/[0-9a-f]{64}\.json)?$/.test(name)),
      [],
      "state holds only binding records",
    );
    await assert.rejects(
      cli(f.state, "wake", "org/one", "alpha", "worker", "../outside.md", "r1"),
      /escapes/,
    );
    await assert.rejects(
      cli(f.state, "bind", "org/one", "alpha", f.root, f.b.socket),
      /already bound/,
    );
  } finally {
    await f.cleanup();
  }
});

test("a fresh plans checkout and state directory can bind the same durable id", async () => {
  const f = await fixture();
  try {
    await run(
      bind(f.state, {
        repository: "org/one",
        coordinator: "alpha",
        plansRoot: f.root,
        socket: f.a.socket,
      }),
    );
    const freshState = await mkdtemp(join(f.dir, "state-"));
    const freshRoot = await plans(join(f.dir, "fresh-plans"));
    const record = await run(
      bind(freshState, {
        repository: "org/one",
        coordinator: "alpha",
        plansRoot: freshRoot,
        socket: f.b.socket,
      }),
    );
    assert.equal(record.profile, join(freshRoot, "coordinators", "alpha.md"));
    await run(wake(freshState, "org/one", "alpha", event));
    assert.deepEqual(f.b.received, [{ ...event, source: join(freshRoot, "handoffs", "h.md") }]);
    assert.equal(f.a.received.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("receiver identity, pinned-instance rejection and direct-send compatibility", async () => {
  const f = await fixture();
  const call = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: f.a.socket, method, path, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  try {
    const identity = await call("GET", "/identity");
    assert.deepEqual(JSON.parse(identity.body), { instance: f.a.instance, protocol: 1 });
    const body = JSON.stringify({ ...event, source: "/abs/h.md" });
    assert.equal(
      (await call("POST", "/wake", { "x-herdsman-instance": f.b.instance }, body)).status,
      409,
    );
    assert.equal(f.a.received.length, 0);
    assert.equal((await call("POST", "/wake", {}, body)).status, 202);
    assert.equal(
      (await call("POST", "/wake", { "x-herdsman-instance": f.a.instance }, body)).status,
      202,
    );
    assert.equal(f.a.received.length, 2);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/wake.ts", "worker", "/abs/h.md", "r1"],
      { env: { ...process.env, HERDSMAN_SOCKET: f.a.socket } },
    );
    assert.match(stdout, /^accepted by adapter/);
    assert.equal(f.a.received.length, 3);
  } finally {
    await f.cleanup();
  }
});
