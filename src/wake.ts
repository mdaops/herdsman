import { Effect, Schema } from "effect";
import { Wake, socketPath } from "./bridge.ts";
import { sendWake } from "./client.ts";

const [sender, source, revision] = process.argv.slice(2);
const send = Effect.gen(function* () {
  const wake = yield* Schema.decodeUnknownEffect(Wake)({ sender, source, revision });
  return yield* sendWake(yield* Effect.sync(socketPath), wake);
});
Effect.runPromise(send).then(
  (result) => process.stdout.write(result),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
