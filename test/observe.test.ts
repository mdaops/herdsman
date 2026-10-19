import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { Effect, Exit, Scope } from "effect";
import { listen, type Wake } from "../src/bridge.ts";
import { stopped } from "../src/observe.ts";
import { bind } from "./fixtures.ts";

test("only a stop from working, or a new block, counts", () => {
  assert.equal(stopped("working", "idle"), true);
  assert.equal(stopped("working", "done"), true);
  assert.equal(stopped("working", "blocked"), true);
  assert.equal(stopped("idle", "blocked"), true);
  assert.equal(stopped("blocked", "blocked"), false);
  assert.equal(stopped("idle", "done"), false);
  assert.equal(stopped("blocked", "idle"), false);
  assert.equal(stopped("working", "unknown"), false);
  assert.equal(stopped("idle", "working"), false);
});

// Minimal Herdr: answers agent.get for one worker and pushes events to subscribers.
async function herdr(path: string, agent: Record<string, unknown>) {
  const subscribers: Socket[] = [];
  let subscribed: () => void;
  const ready = new Promise<void>((resolve) => (subscribed = resolve));
  const server = createServer((socket) => {
    createInterface({ input: socket }).on("line", (text) => {
      const request = JSON.parse(text);
      if (request.method === "agent.get") {
        socket.end(
          JSON.stringify({ id: request.id, result: { type: "agent_info", agent } }) + "\n",
        );
      } else if (request.method === "events.subscribe") {
        socket.write(
          JSON.stringify({ id: request.id, result: { type: "subscription_started" } }) + "\n",
        );
        subscribers.push(socket);
        subscribed();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    ready,
    push: (event: string, data: Record<string, unknown>) =>
      subscribers.forEach((s) => s.write(JSON.stringify({ event, data }) + "\n")),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("observer wakes the owning coordinator once per worker stop, then exits when the pane moves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdsman-observe-"));
  const scope = Scope.makeUnsafe();
  const root = join(dir, "plans");
  await mkdir(join(root, "coordinators"), { recursive: true });
  await mkdir(join(root, "plans"));
  await writeFile(join(root, "coordinators", "alpha.md"), "# Alpha\n");
  await writeFile(join(root, "plans", "task.md"), "# Task\n");
  const received: Wake[] = [];
  const socket = join(dir, "alpha.sock");
  await Effect.runPromise(
    listen(socket, (wake) => Effect.sync(() => void received.push(wake))).pipe(
      Scope.provide(scope),
    ),
  );
  const state = join(dir, "state");
  await Effect.runPromise(
    bind(state, { repository: "org/plans", coordinator: "alpha", plansRoot: root, socket }),
  );
  const fake = await herdr(join(dir, "herdr.sock"), {
    pane_id: "w1:p2",
    terminal_id: "term_1",
    name: "worker-a",
    agent_status: "working",
  });
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/coordinator.ts",
      "observe",
      "org/plans",
      "alpha",
      "worker-a",
      "plans/task.md",
    ],
    {
      env: {
        ...process.env,
        HERDR_SOCKET_PATH: join(dir, "herdr.sock"),
        HERDSMAN_STATE_DIR: state,
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(check(), `timed out; stdout=${stdout} stderr=${stderr}`);
  };
  try {
    await fake.ready;
    const status = (pane_id: string, agent_status: string) =>
      fake.push("pane.agent_status_changed", { pane_id, workspace_id: "w1", agent_status });
    status("w1:p2", "idle");
    await until(() => received.length === 1);
    status("w1:p2", "done");
    status("w1:p9", "blocked");
    status("w1:p2", "working");
    status("w1:p2", "unknown");
    status("w1:p2", "blocked");
    await until(() => received.length === 2);
    fake.push("pane_moved", { previous_pane_id: "w1:p2", pane: { pane_id: "w3:p1" } });
    assert.equal(await exited, 1);
    assert.equal(received.length, 2, "duplicate stops and other panes do not wake");
    for (const [wake, to] of received.map((wake, i) => [wake, ["idle", "blocked"][i]] as const)) {
      assert.equal(wake.sender, "herdr-observer:worker-a");
      assert.equal(wake.source, join(root, "plans", "task.md"));
      assert.match(wake.revision, new RegExp(`^${to}@\\d{4}-`));
    }
    assert.match(stdout, /worker-a working -> idle: accepted by adapter/);
    assert.match(stdout, /worker-a unknown -> blocked: accepted by adapter/);
    assert.match(stderr, /moved to w3:p1; restart the observer/);
  } finally {
    child.kill();
    await fake.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(dir, { recursive: true, force: true });
  }
});

test("observer refuses to start for an unbound coordinator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdsman-observe-"));
  try {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/coordinator.ts",
        "observe",
        "org/plans",
        "alpha",
        "worker-a",
        "plans/task.md",
      ],
      {
        env: {
          ...process.env,
          HERDR_SOCKET_PATH: join(dir, "missing.sock"),
          HERDSMAN_STATE_DIR: join(dir, "state"),
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    assert.equal(await new Promise((resolve) => child.on("exit", resolve)), 1);
    assert.match(stderr, /No binding for org\/plans alpha/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
