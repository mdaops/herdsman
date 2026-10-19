import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect, Exit, Scope } from "effect";
import { content, instructions, listen } from "./bridge.ts";
import { receiverContext, receiverSocket } from "./receiver.ts";

const scope = Scope.makeUnsafe();
let mcp: Server | undefined;
let ready = false;
const stop = () => {
  ready = false;
  return Effect.runPromise(Scope.close(scope, Exit.void));
};

try {
  const receiver = await Effect.runPromise(
    Effect.gen(function* () {
      const socket = yield* receiverSocket();
      const instance = yield* listen(socket, (wake) => {
        if (!mcp || !ready) {
          return Effect.fail(new Error("MCP channel is not initialized"));
        }
        const server = mcp;
        return Effect.tryPromise(() =>
          server.notification({
            method: "notifications/claude/channel",
            params: { content: content(wake), meta: { sender: wake.sender } },
          }),
        );
      });
      return { socket, instance };
    }).pipe(Scope.provide(scope)),
  );
  mcp = new Server(
    { name: "herdsman", version: "0.0.1" },
    {
      capabilities: { experimental: { "claude/channel": {} } },
      instructions: instructions + "\n\n" + receiverContext("claude-code", receiver),
    },
  );
  mcp.oninitialized = () => {
    ready = true;
  };
  mcp.onclose = () => {
    void stop().catch(console.error);
  };
  await mcp.connect(new StdioServerTransport());
} catch (error) {
  await stop();
  await mcp?.close();
  throw error;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop()
      .then(() => mcp?.close())
      .catch(console.error);
  });
}
