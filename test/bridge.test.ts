import assert from "node:assert/strict";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Exit, Scope } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { listen, type Wake } from "../src/bridge.ts";
import piExtension from "../src/pi.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const wake = { sender: "worker", source: "handoffs/example.md", revision: "abc123" };
function post(socketPath: string, body: unknown = wake) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path: "/wake", method: "POST" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "herdsman-"));
  return { dir, path: join(dir, "wake.sock"), scope: Scope.makeUnsafe() };
}

test("validated wake crosses the boundary; invalid bodies never reach the adapter", async () => {
  const f = await fixture();
  const received: Wake[] = [];
  try {
    await Effect.runPromise(
      listen(f.path, (wake) =>
        Effect.sync(() => {
          received.push(wake);
        }),
      ).pipe(Scope.provide(f.scope)),
    );
    assert.equal((await post(f.path)).status, 202);
    assert.deepEqual(received, [wake]);
    for (const body of [{}, { ...wake, revision: 7 }, { ...wake, source: "" }]) {
      assert.equal((await post(f.path, body)).status, 400);
    }
    assert.equal((await post(f.path, { ...wake, source: "x".repeat(9000) })).status, 413);
    assert.equal(received.length, 1);
    await assert.rejects(
      Effect.runPromise(listen(f.path, () => Effect.void).pipe(Scope.provide(f.scope))),
    );
    assert.equal((await post(f.path)).status, 202, "collision did not steal the listener");
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
    await assert.rejects(post(f.path), "closed listener must fail, not queue silently");
  } finally {
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("rejects a non-private socket parent", async () => {
  const f = await fixture();
  try {
    await chmod(f.dir, 0o755);
    await assert.rejects(
      Effect.runPromise(listen(f.path, () => Effect.void).pipe(Scope.provide(f.scope))),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        /private directory/.test(error.cause.message),
    );
  } finally {
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("adapter failure is not acknowledged as success", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(
      listen(f.path, () => Effect.fail(new Error("test delivery failure"))).pipe(
        Scope.provide(f.scope),
      ),
    );
    assert.equal((await post(f.path)).status, 502);
  } finally {
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("Pi adapter requests attributed follow-up without an editor API; lifecycle releases socket", async () => {
  const f = await fixture();
  const previous = process.env.HERDSMAN_SOCKET;
  process.env.HERDSMAN_SOCKET = f.path;
  const handlers = new Map<string, () => Promise<void>>();
  const messages: unknown[] = [];
  piExtension({
    on: (name: string, handler: () => Promise<void>) => handlers.set(name, handler),
    sendMessage: (...args: unknown[]) => {
      messages.push(args);
    },
  } as unknown as ExtensionAPI);
  try {
    await handlers.get("session_start")!();
    assert.equal((await post(f.path)).status, 202);
    assert.equal(messages.length, 1);
    const [message, options] = messages[0] as [Record<string, unknown>, unknown];
    assert.equal(message.customType, "herdsman-wake");
    assert.deepEqual(message.details, wake);
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
    await handlers.get("session_shutdown")!();
    await handlers.get("session_shutdown")!();
    await assert.rejects(post(f.path));
  } finally {
    await handlers.get("session_shutdown")!();
    if (previous === undefined) {
      delete process.env.HERDSMAN_SOCKET;
    } else {
      process.env.HERDSMAN_SOCKET = previous;
    }
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("live Pi opt-in binds only the selected session and releases on session switch", async () => {
  const f = await fixture();
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  piExtension(
    {
      on: (name: string, handler: (...args: unknown[]) => Promise<void>) =>
        handlers.set(name, handler),
      sendMessage: () => {},
    } as unknown as ExtensionAPI,
    { socket: f.path, sessionFile: "/selected.jsonl" },
  );
  const start = (file: string) =>
    handlers.get("session_start")!(
      {},
      {
        sessionManager: { getSessionFile: () => file },
      },
    );
  try {
    await start("/other.jsonl");
    await assert.rejects(post(f.path));
    await start("/selected.jsonl");
    assert.equal((await post(f.path)).status, 202);
    await start("/other.jsonl");
    await assert.rejects(post(f.path));
  } finally {
    await handlers.get("session_shutdown")!();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("CC adapter emits a real MCP channel notification, without permission relay", async () => {
  const f = await fixture();
  const client = new Client({ name: "spike-test", version: "0.0.1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cc.ts"],
    env: { ...(process.env as Record<string, string>), HERDSMAN_SOCKET: f.path },
    stderr: "pipe",
  });
  const notification = new Promise<unknown>((resolve) =>
    client.setNotificationHandler(
      z.object({
        method: z.literal("notifications/claude/channel"),
        params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
      }),
      resolve,
    ),
  );
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerCapabilities()?.experimental, { "claude/channel": {} });
    // MCP initialization and socket binding are separate startup steps.
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await post(f.path);
        break;
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code!)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(response?.status, 202);
    const event = (await notification) as { params: { content: string; meta: unknown } };
    assert.deepEqual(event.params.meta, { sender: "worker" });
    assert.ok(event.params.content.includes(JSON.stringify(wake)));
  } finally {
    await client.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
