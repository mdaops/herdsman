import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect, Exit, Scope } from "effect";
import { content, instructions, listen, socketPath } from "./bridge.ts";

const mcp = new Server(
  { name: "herdsman", version: "0.0.1" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions,
  },
);
const scope = Scope.makeUnsafe();
const stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
mcp.onclose = () => {
  void stop();
};
await mcp.connect(new StdioServerTransport());
try {
  await Effect.runPromise(
    listen(socketPath(), (wake) =>
      Effect.tryPromise(() =>
        mcp.notification({
          method: "notifications/claude/channel",
          params: { content: content(wake), meta: { sender: wake.sender } },
        }),
      ),
    ).pipe(Scope.provide(scope)),
  );
} catch (error) {
  await stop();
  await mcp.close();
  throw error;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop().then(() => mcp.close());
  });
}
