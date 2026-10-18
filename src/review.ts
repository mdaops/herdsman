import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Context, Data, Effect, Layer, Schema } from "effect";
import { Registry, RegistryLive, stateDir } from "./registry.ts";
import { ReviewMode } from "./domain.ts";
const Decision = Schema.Struct({
  decision: Schema.Literals(["approved", "annotated", "dismissed"]),
  feedback: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);

// Choose a loopback port for this review so N concurrent reviews have unambiguous links.
// Plannotator still owns the actual server; failure to bind is a launch failure, not approval.
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No review port allocated");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export type Launcher = (
  args: string[],
  cwd: string,
  ready: (url: string) => Promise<void>,
) => Promise<string>;
export const launch: Launcher = async (args, cwd, ready) => {
  const port = await freePort();
  const child = spawn("plannotator", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PLANNOTATOR_REMOTE: "0", PLANNOTATOR_PORT: String(port) },
  });
  let ended = false;
  let stdout = "";
  let stderr = "";
  // Install completion handlers before waiting for startup. Keep the review alive until a decision.
  const completion = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      ended = true;
      resolve({ code: null, error });
    });
    child.once("close", (code) => {
      ended = true;
      resolve({ code });
    });
  });
  while (!ended) {
    const listening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(200);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (listening && !ended) {
      // A notification failure must not discard a still-running human review.
      await ready(`http://localhost:${port}`).catch((error) =>
        console.error("Review link notification failed:", error),
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = await completion;
  if (result.error || result.code !== 0) {
    throw new Error(
      `Plannotator failed (${result.code}): ${result.error?.message ?? stderr.trim()}`,
    );
  }
  return stdout.trim();
};

export class ReviewError extends Data.TaggedError("ReviewError")<{
  operation: string;
  cause: unknown;
}> {}

const io = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new ReviewError({ operation, cause }) });

// Process/UI boundary. The callback is Promise-based because the child-process
// launcher is outside the Effect runtime; orchestration remains effectful.
export class ReviewPlatform extends Context.Service<
  ReviewPlatform,
  {
    launch: (
      args: string[],
      cwd: string,
      ready: (url: string) => Promise<void>,
    ) => Effect.Effect<string, ReviewError>;
    notify: (title: string, body: string) => Effect.Effect<void, ReviewError>;
  }
>()("herdsman/ReviewPlatform") {}

export const ReviewPlatformLive = Layer.succeed(ReviewPlatform, {
  launch: Effect.fn("ReviewPlatform.launch")((args, cwd, ready) =>
    io("launch", () => launch(args, cwd, ready)),
  ),
  notify: Effect.fn("ReviewPlatform.notify")(function* (title, body) {
    if (process.env.HERDR_ENV === "1") {
      yield* io("notify", () =>
        exec("herdr", ["notification", "show", title, "--body", body, "--sound", "request"]),
      );
    }
  }),
});

export type ReviewInput = {
  repository: string;
  coordinator: string;
  mode: ReviewMode;
  source: string;
};

const makeReview = Effect.gen(function* () {
  const registry = yield* Registry;
  const platform = yield* ReviewPlatform;

  const run = Effect.fn("Review.run")(function* (input: ReviewInput) {
    const owner = yield* registry.load(input.repository, input.coordinator);
    const root = owner.plansRoot;
    const source = yield* io("resolve source", () => realpath(resolve(root, input.source)));
    const rel = relative(root, source);
    const reject = (message: string) =>
      Effect.fail(new ReviewError({ operation: "validate source", cause: message }));
    if (
      input.mode !== "code" &&
      (isAbsolute(input.source) || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    ) {
      return yield* reject(
        "Plan source must be repository-relative and stay inside the plans checkout",
      );
    }
    if (input.mode !== "code" && !source.endsWith(".md")) {
      return yield* reject("Plan review requires Markdown");
    }
    if (input.mode === "code" && !source.endsWith(".patch")) {
      return yield* reject("Code review requires an explicit .patch snapshot");
    }

    const bytes = yield* io("read source", () => readFile(source, "utf8"));
    const id = randomUUID();
    const sourceName = input.mode === "code" ? "source.patch" : "source.md";
    const directory = join(root, "handoffs", "reviews", owner.coordinator, id);
    const localDirectory = join(root, "local", "herdsman-reviews", owner.coordinator);
    yield* io("create evidence directory", () => mkdir(directory, { recursive: true }));
    yield* io("create local directory", () => mkdir(localDirectory, { recursive: true }));
    const snapshot = join(directory, sourceName);
    const localRecord = join(localDirectory, id + ".json");
    yield* io("save snapshot", () => writeFile(snapshot, bytes, { flag: "wx" }));
    const request = {
      id,
      repository: input.repository,
      coordinator: owner.coordinator,
      mode: input.mode,
      openedAt: new Date().toISOString(),
      source: {
        path: input.mode === "code" ? basename(source) : rel,
        sha256: digest(bytes),
        snapshot: sourceName,
      },
    };
    yield* io("save request", () =>
      writeFile(join(directory, "request.json"), JSON.stringify(request, null, 2) + "\n", {
        flag: "wx",
      }),
    );
    const local = {
      id,
      repository: input.repository,
      coordinator: owner.coordinator,
      mode: input.mode,
      source: request.source.path,
      evidence: relative(root, directory),
      launcherPid: process.pid,
      url: null as string | null,
      state: "starting",
    };
    const saveLocal = () =>
      io("save local state", () => writeFile(localRecord, JSON.stringify(local, null, 2) + "\n"));
    yield* saveLocal();
    const args =
      input.mode === "code"
        ? ["review", "--patch-file", snapshot, "--json"]
        : ["annotate", snapshot, ...(input.mode === "approve-plan" ? ["--gate"] : []), "--json"];

    const ready = Effect.fn("Review.ready")(function* (url: string) {
      local.url = url;
      local.state = "open";
      yield* saveLocal();
      console.log(`Review ready: ${owner.coordinator} · ${input.mode} · ${url}`);
      console.log(`Local review record: ${localRecord}`);
      yield* platform.notify(
        `${owner.coordinator}: ${input.mode === "plan" ? "plan feedback" : "review ready"} · ${basename(source)}`,
        url,
      );
    });

    const decision = yield* Effect.gen(function* () {
      const output = yield* platform.launch(args, root, (url) => Effect.runPromise(ready(url)));
      yield* io("save response", () =>
        writeFile(join(directory, "response.txt"), output + "\n", { flag: "wx" }),
      );
      const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Decision))(
        output,
      ).pipe(Effect.mapError((cause) => new ReviewError({ operation: "decode decision", cause })));
      const reviewed = yield* io("verify snapshot", () => readFile(snapshot, "utf8"));
      if (digest(reviewed) !== request.source.sha256) {
        return yield* reject(
          "Reviewed snapshot changed; decision cannot authorize the original source",
        );
      }
      return result;
    }).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          local.state = "failed";
          yield* saveLocal();
          yield* io("save failure", () =>
            writeFile(
              join(directory, "failure.json"),
              JSON.stringify(
                {
                  ...request,
                  error: String(error),
                  operation: error.operation,
                  cause: String(error.cause),
                },
                null,
                2,
              ) + "\n",
            ),
          );
        }),
      ),
    );

    const evidence =
      JSON.stringify({ ...request, closedAt: new Date().toISOString(), ...decision }, null, 2) +
      "\n";
    const decisionFile = join(directory, "decision.json");
    yield* io("save decision", () => writeFile(decisionFile, evidence, { flag: "wx" }));
    local.state = "closed";
    yield* saveLocal();
    // Save evidence first. A failed hint never alters the human decision.
    const notification = yield* registry
      .wake(input.repository, owner.coordinator, {
        sender: "plannotator",
        source: relative(root, decisionFile),
        revision: digest(evidence),
      })
      .pipe(
        Effect.match({
          onSuccess: () => ({ status: "accepted" as const }),
          onFailure: (error) => ({ status: "failed" as const, error: String(error) }),
        }),
      );
    yield* io("save delivery", () =>
      writeFile(
        join(localDirectory, id + ".delivery.json"),
        JSON.stringify(notification, null, 2) + "\n",
      ),
    );
    return { decision: decision.decision, decisionFile, notification };
  });
  return { run };
});

export class Review extends Context.Service<Review, Effect.Success<typeof makeReview>>()(
  "herdsman/Review",
) {
  static layer = Layer.effect(Review, makeReview);
}

export const ReviewLive = (dir: string) =>
  Review.layer.pipe(Layer.provide(Layer.merge(RegistryLive(dir), ReviewPlatformLive)));

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, repository, coordinator, source, ...extra] = process.argv.slice(2);
  if (!Schema.is(ReviewMode)(mode) || !repository || !coordinator || !source || extra.length) {
    console.error(
      "Usage: tsx src/review.ts <plan|approve-plan|code> <repository> <coordinator> <plan-path|absolute-patch>",
    );
    process.exitCode = 2;
  } else {
    const run = Effect.gen(function* () {
      const review = yield* Review;
      return yield* review.run({ repository, coordinator, mode, source });
    }).pipe(Effect.provide(ReviewLive(stateDir())));
    Effect.runPromise(run).then(
      (result) => {
        console.log(JSON.stringify(result));
        if (result.notification.status === "failed") {
          process.exitCode = 1;
        }
      },
      (error) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
