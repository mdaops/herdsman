import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";
import { z } from "zod";
import piExtension from "../src/pi.ts";
import { identify, sendWake } from "../src/client.ts";

const Endpoint = Schema.Struct({ socket: Schema.String, instance: Schema.String });
const endpoint = (context: string) =>
  Schema.decodeUnknownSync(Endpoint)(
    JSON.parse(context.split("\n").find((line) => line.startsWith('{"harness":'))!),
  );
const event = { sender: "worker", source: "/saved/handoff.md", revision: "r1" };

function pi(options?: { socket?: string }) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const messages: unknown[] = [];
  piExtension(
    {
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      sendMessage: (...args: unknown[]) => messages.push(args),
    } as unknown as ExtensionAPI,
    options,
  );
  return {
    messages,
    start: () => handlers.get("session_start")!(),
    stop: () => handlers.get("session_shutdown")!(),
    context: () => {
      const input = {
        systemPromptOptions: { sections: { unrelated: "preserved" } as Record<string, string> },
      };
      handlers.get("before_agent_start")!(input);
      assert.equal(input.systemPromptOptions.sections.unrelated, "preserved");
      return input.systemPromptOptions.sections.herdsman_receiver;
    },
  };
}

test("fresh Pi receivers expose isolated endpoints without per-session configuration", async () => {
  const previous = process.env.HERDSMAN_SOCKET;
  delete process.env.HERDSMAN_SOCKET;
  const a = pi();
  const b = pi();
  try {
    assert.equal(a.context(), undefined, "no readiness advertised before session start");
    await a.start();
    await b.start();
    const first = endpoint(a.context());
    const second = endpoint(b.context());
    assert.notEqual(first.socket, second.socket);
    assert.notEqual(first.instance, second.instance);
    assert.equal((await stat(dirname(first.socket))).mode & 0o077, 0);
    assert.equal(await Effect.runPromise(identify(first.socket)), first.instance);
    assert.equal(a.messages.length, 0, "installation must not trigger a model turn");
    await Effect.runPromise(sendWake(first.socket, event, first.instance));
    assert.equal(a.messages.length, 1);
    assert.equal(b.messages.length, 0);
    await Effect.runPromise(sendWake(second.socket, event, second.instance));
    assert.equal(b.messages.length, 1);

    await a.start(); // session replacement / reload lifecycle
    const replacement = endpoint(a.context());
    assert.notEqual(replacement.socket, first.socket);
    assert.notEqual(replacement.instance, first.instance);
    await assert.rejects(stat(dirname(first.socket)), { code: "ENOENT" });
    await a.stop();
    assert.equal(a.context(), undefined);
    await assert.rejects(stat(dirname(replacement.socket)), { code: "ENOENT" });
  } finally {
    await a.stop();
    await b.stop();
    if (previous === undefined) {
      delete process.env.HERDSMAN_SOCKET;
    } else {
      process.env.HERDSMAN_SOCKET = previous;
    }
  }
});

test("Pi reports setup failure rather than advertising an unusable receiver", async () => {
  const receiver = pi({ socket: "relative.sock" });
  try {
    await assert.rejects(async () => receiver.start());
    assert.match(receiver.context(), /setup failed/);
    assert.ok(!receiver.context().includes('"instance"'));
    assert.equal(receiver.messages.length, 0);
  } finally {
    await receiver.stop();
  }
});

test("fresh CC adapters publish separate endpoints in MCP instructions and clean up on disconnect", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "HERDSMAN_SOCKET" && entry[1] !== undefined,
    ),
  );
  const clients = [0, 1].map((i) => new Client({ name: `receiver-test-${i}`, version: "1" }));
  const received: unknown[][] = [[], []];
  const endpoints: { socket: string; instance: string }[] = [];
  try {
    for (const [i, client] of clients.entries()) {
      client.setNotificationHandler(
        z.object({
          method: z.literal("notifications/claude/channel"),
          params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
        }),
        (notification) => {
          received[i].push(notification);
        },
      );
      await client.connect(
        new StdioClientTransport({
          command: "npm",
          args: [
            "--prefix",
            fileURLToPath(new URL("../", import.meta.url)),
            "run",
            "--silent",
            "cc",
          ],
          cwd: tmpdir(),
          env,
          stderr: "pipe",
        }),
      );
      await client.ping(); // initialization notification has been processed in stream order
      endpoints.push(endpoint(client.getInstructions()!));
    }
    assert.notEqual(endpoints[0].socket, endpoints[1].socket);
    for (const [i, address] of endpoints.entries()) {
      assert.equal(await Effect.runPromise(identify(address.socket)), address.instance);
      await Effect.runPromise(sendWake(address.socket, event, address.instance));
      // MCP notification processing is asynchronous to the HTTP acknowledgment.
      for (let n = 0; n < 50 && received[i].length === 0; n++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(received[i].length, 1);
    }
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
  for (const address of endpoints) {
    await assert.rejects(stat(dirname(address.socket)), { code: "ENOENT" });
  }
});
