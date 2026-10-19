import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Effect } from "effect";
import { sendWake } from "../src/client.ts";

test("a named send fails closed if the socket is replaced by a legacy receiver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdsman-legacy-"));
  let delivered = 0;
  const server = createServer((req, res) => {
    // Original spike: no identity support and unknown headers ignored.
    if (req.method === "POST" && req.url === "/wake") {
      delivered++;
      res.writeHead(202);
    } else {
      res.writeHead(404);
    }
    res.end();
  });
  const socket = join(dir, "receiver.sock");
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await assert.rejects(
      Effect.runPromise(
        sendWake(
          socket,
          {
            sender: "worker",
            source: "handoff.md",
            revision: "r1",
          },
          "old-instance",
        ),
      ),
    );
    assert.equal(delivered, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
