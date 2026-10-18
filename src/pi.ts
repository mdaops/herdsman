import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Scope } from "effect";
import { content, listen, socketPath } from "./bridge.ts";

export default function (
  pi: ExtensionAPI,
  options: { socket?: string; sessionFile?: string } = {},
) {
  let scope: Scope.Closeable | undefined;
  const stop = async () => {
    const current = scope;
    scope = undefined;
    if (current) {
      await Effect.runPromise(Scope.close(current, Exit.void));
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    await stop();
    if (options.sessionFile && ctx.sessionManager.getSessionFile() !== options.sessionFile) {
      return;
    }
    scope = Scope.makeUnsafe();
    try {
      await Effect.runPromise(
        listen(options.socket ?? socketPath(), (wake) =>
          Effect.sync(() => {
            pi.sendMessage(
              {
                customType: "herdsman-wake",
                content: content(wake),
                display: true,
                details: wake,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          }),
        ).pipe(Scope.provide(scope)),
      );
    } catch (error) {
      await stop();
      throw error;
    }
  });
  pi.on("session_shutdown", stop);
}
