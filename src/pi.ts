import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Exit, Scope } from "effect";
import { content, listen } from "./bridge.ts";
import { receiverContext, receiverSocket, type Receiver } from "./receiver.ts";

export default function (
  pi: ExtensionAPI,
  options: { socket?: string; sessionFile?: string } = {},
) {
  let scope: Scope.Closeable | undefined;
  let receiver: Receiver | undefined;
  let failure: string | undefined;
  const stop = async () => {
    const current = scope;
    scope = undefined;
    receiver = undefined;
    if (current) {
      await Effect.runPromise(Scope.close(current, Exit.void));
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    await stop();
    failure = undefined;
    if (options.sessionFile && ctx.sessionManager.getSessionFile() !== options.sessionFile) {
      return;
    }
    scope = Scope.makeUnsafe();
    try {
      receiver = await Effect.runPromise(
        Effect.gen(function* () {
          const socket = yield* receiverSocket(options.socket);
          const instance = yield* listen(socket, (wake) =>
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
          );
          return { socket, instance };
        }).pipe(Scope.provide(scope)),
      );
    } catch (error) {
      await stop();
      failure = String(error);
      throw error;
    }
  });
  pi.on("before_agent_start", (event) => {
    // Replace just our structured prompt section; never touch the input editor
    // or initiate a model turn merely because an extension was installed.
    if (receiver) {
      event.systemPromptOptions.sections.herdsman_receiver = receiverContext("pi", receiver);
    } else if (failure) {
      event.systemPromptOptions.sections.herdsman_receiver = `Herdsman receiver setup failed: ${failure}`;
    } else {
      delete event.systemPromptOptions.sections.herdsman_receiver;
    }
  });
  pi.on("session_shutdown", stop);
}
