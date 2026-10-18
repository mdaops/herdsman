import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Effect, Layer } from "effect";
import { Registry, RegistryLive, type RegistryApi } from "../src/registry.ts";
import { Uncertain, WakeTransport } from "../src/client.ts";
import {
  Review,
  ReviewError,
  ReviewPlatform,
  type Launcher,
  type ReviewInput,
} from "../src/review.ts";
export type { ReviewMode } from "../src/domain.ts";

// Keep behavioral tests focused on outcomes; all operations now run through layers.
const usingRegistry = <A, E>(dir: string, f: (registry: RegistryApi) => Effect.Effect<A, E>) =>
  Effect.flatMap(Registry, f).pipe(Effect.provide(RegistryLive(dir)));

export const bind = (dir: string, ...args: Parameters<RegistryApi["bind"]>) =>
  usingRegistry(dir, (registry) => registry.bind(...args));
export const list = (dir: string, ...args: Parameters<RegistryApi["list"]>) =>
  usingRegistry(dir, (registry) => registry.list(...args));
export const show = (dir: string, ...args: Parameters<RegistryApi["show"]>) =>
  usingRegistry(dir, (registry) => registry.show(...args));
export const wake = (dir: string, ...args: Parameters<RegistryApi["wake"]>) =>
  usingRegistry(dir, (registry) => registry.wake(...args));
export const unbind = (dir: string, ...args: Parameters<RegistryApi["unbind"]>) =>
  usingRegistry(dir, (registry) => registry.unbind(...args));

export type ReviewHooks = {
  launch: Launcher;
  notify: (title: string, body: string) => Promise<void>;
  wake: (source: string, revision: string) => Promise<unknown>;
};

export const review = (input: ReviewInput & { plansRoot: string }, hooks: ReviewHooks) => {
  const root = input.plansRoot;
  const registry = Registry.layer(join(root, ".review-test-state")).pipe(
    Layer.provide(
      Layer.succeed(WakeTransport, {
        identify: () => Effect.succeed("test-instance"),
        send: (_socket, event) =>
          Effect.tryPromise({
            try: () => hooks.wake(relative(root, event.source), event.revision),
            catch: (cause) => new Uncertain({ cause }),
          }).pipe(Effect.as("accepted by adapter; reconciliation not acknowledged\n")),
      }),
    ),
  );
  const platform = Layer.succeed(ReviewPlatform, {
    launch: (args, cwd, ready) =>
      Effect.tryPromise({
        try: () => hooks.launch(args, cwd, ready),
        catch: (cause) => new ReviewError({ operation: "test launch", cause }),
      }),
    notify: (title, body) =>
      Effect.tryPromise({
        try: () => hooks.notify(title, body),
        catch: (cause) => new ReviewError({ operation: "test notify", cause }),
      }),
  });
  const dependencies = Layer.merge(registry, platform);
  return Effect.gen(function* () {
    yield* Effect.tryPromise(async () => {
      await mkdir(join(root, "coordinators"), { recursive: true });
      await writeFile(
        join(root, "coordinators", input.coordinator + ".md"),
        "# Test coordinator\n",
      );
    });
    const bindings = yield* Registry;
    yield* bindings.bind({
      repository: input.repository,
      coordinator: input.coordinator,
      plansRoot: root,
      socket: join(root, "test.sock"),
    });
    const service = yield* Review;
    return yield* service.run(input);
  }).pipe(
    Effect.provide(Layer.merge(dependencies, Review.layer.pipe(Layer.provide(dependencies)))),
  );
};
