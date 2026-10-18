import { request } from "node:http";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { type Wake, instanceHeader, protocol } from "./bridge.ts";

// Nothing listens at the socket: the request was never delivered.
export class Offline extends Data.TaggedError("Offline")<{ socket: string }> {}
// The receiver restarted since binding; it refused the pinned instance.
export class Stale extends Data.TaggedError("Stale")<{ socket: string; instance: string }> {}
// The receiver answered with an unexpected outcome.
export class Rejected extends Data.TaggedError("Rejected")<{ status: number; message: string }> {}
// Failure after connecting: delivery may have happened. Do not retry blindly.
export class Uncertain extends Data.TaggedError("Uncertain")<{ cause: unknown }> {}

const Identity = Schema.Struct({
  instance: Schema.NonEmptyString,
  protocol: Schema.Literal(protocol),
});

const call = Effect.fn("WakeTransport.request")(
  (
    socket: string,
    method: string,
    path: string,
    headers: Record<string, string | number>,
    body?: string,
  ) =>
    Effect.tryPromise({
      try: () =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = request({ socketPath: socket, path, method, headers }, (res) => {
            let response = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              response += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode!, body: response }));
            res.on("error", reject);
          });
          req.on("error", reject);
          req.setTimeout(5000, () =>
            req.destroy(new Error("Timed out; delivery is uncertain. Do not retry blindly.")),
          );
          req.end(body);
        }),
      catch: (cause) =>
        ["ENOENT", "ECONNREFUSED"].includes((cause as NodeJS.ErrnoException).code!)
          ? new Offline({ socket })
          : new Uncertain({ cause }),
    }),
);

export const identify = Effect.fn("WakeTransport.identify")(function* (socket: string) {
  const reply = yield* call(socket, "GET", "/identity", {});
  if (reply.status !== 200) {
    return yield* Effect.fail(
      new Rejected({
        status: reply.status,
        message: "Receiver does not support identity: " + reply.body.trim(),
      }),
    );
  }
  const identity = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))(
    reply.body,
  ).pipe(
    Effect.mapError(
      () => new Rejected({ status: reply.status, message: "Invalid identity response" }),
    ),
  );
  return identity.instance;
});

// Callers decode the wake first. Without an instance this is the direct spike send; with one, the receiver
// rejects it unless it is still the same listen() lifetime.
export const sendWake = Effect.fn("WakeTransport.send")(function* (
  socket: string,
  wake: Wake,
  instance?: string,
) {
  const body = JSON.stringify(wake);
  // A separate route fails closed against the old receiver, which ignores unknown headers.
  const reply = yield* call(
    socket,
    "POST",
    instance === undefined ? "/wake" : "/wake/pinned",
    {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(instance === undefined ? {} : { [instanceHeader]: instance }),
    },
    body,
  );
  if (reply.status === 202) {
    return reply.body;
  }
  if (reply.status === 409 && instance !== undefined) {
    return yield* Effect.fail(new Stale({ socket, instance }));
  }
  return yield* Effect.fail(new Rejected({ status: reply.status, message: reply.body.trim() }));
});

export class WakeTransport extends Context.Service<
  WakeTransport,
  {
    readonly identify: typeof identify;
    readonly send: typeof sendWake;
  }
>()("herdsman/WakeTransport") {}

export const WakeTransportLive = Layer.succeed(WakeTransport, { identify, send: sendWake });
