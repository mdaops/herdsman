import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Exit, Scope } from "effect";
import { bind, wake, review, type ReviewHooks, type ReviewMode } from "./fixtures.ts";
import { listen, type Wake } from "../src/bridge.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herdsman-review-"));
  await mkdir(join(root, "plans"));
  await writeFile(join(root, "plans", "example.md"), "# Plan\n\nDiscuss this change.\n");
  await writeFile(
    join(root, "change.patch"),
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
  );
  return root;
}

test("plan iteration, explicit acceptance and code review have distinct launch contracts", async () => {
  for (const mode of ["plan", "approve-plan", "code"] as ReviewMode[]) {
    const root = await fixture();
    let notified = false;
    let sent = false;
    const hooks: ReviewHooks = {
      launch: async (args, cwd, ready) => {
        assert.equal(cwd, root);
        assert.equal(args[0], mode === "code" ? "review" : "annotate");
        assert.equal(args.includes("--gate"), mode === "approve-plan");
        assert.equal(args.includes("--patch-file"), mode === "code");
        const snapshot = mode === "code" ? args[2] : args[1];
        assert.ok(snapshot.startsWith(join(root, "handoffs", "reviews")));
        assert.ok((await readFile(snapshot, "utf8")).length > 0);
        await ready("http://localhost:43210");
        return JSON.stringify({ decision: "annotated", feedback: "Clarify the boundary." });
      },
      notify: async (title, url) => {
        assert.ok(title.startsWith("production:"));
        assert.equal(url, "http://localhost:43210");
        notified = true;
      },
      wake: async (source, revision) => {
        const evidence = JSON.parse(await readFile(join(root, source), "utf8"));
        assert.equal(evidence.decision, "annotated");
        assert.equal(evidence.coordinator, "production");
        assert.equal(evidence.source.path, mode === "code" ? "change.patch" : "plans/example.md");
        assert.ok(!JSON.stringify(evidence).includes("localhost"));
        assert.match(revision, /^[0-9a-f]{64}$/);
        sent = true;
      },
    };
    try {
      const result = await Effect.runPromise(
        review(
          {
            plansRoot: root,
            repository: "test/plans",
            coordinator: "production",
            mode,
            source: mode === "code" ? join(root, "change.patch") : "plans/example.md",
          },
          hooks,
        ),
      );
      assert.equal(result.decision, "annotated");
      assert.equal(result.notification.status, "accepted");
      assert.ok(notified && sent);
      assert.equal(
        await readFile(join(root, "plans/example.md"), "utf8"),
        "# Plan\n\nDiscuss this change.\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("review completion wakes only its owning named coordinator", async () => {
  const root = await fixture();
  const scope = Scope.makeUnsafe();
  const received: Record<string, Wake[]> = { production: [], incident: [] };
  const state = join(root, "state");
  try {
    await mkdir(join(root, "coordinators"));
    for (const id of Object.keys(received)) {
      await writeFile(join(root, "coordinators", `${id}.md`), `# ${id} coordinator\n`);
      const socket = join(root, `${id}.sock`);
      await Effect.runPromise(
        listen(socket, (event) =>
          Effect.sync(() => {
            received[id].push(event);
          }),
        ).pipe(Scope.provide(scope)),
      );
      await Effect.runPromise(
        bind(state, { repository: "test/plans", coordinator: id, plansRoot: root, socket }),
      );
    }
    const result = await Effect.runPromise(
      review(
        {
          plansRoot: root,
          repository: "test/plans",
          coordinator: "incident",
          mode: "plan",
          source: "plans/example.md",
        },
        {
          launch: async () =>
            JSON.stringify({ decision: "annotated", feedback: "Clarify the incident scope." }),
          notify: async () => {},
          wake: (source, revision) =>
            Effect.runPromise(
              wake(state, "test/plans", "incident", { sender: "plannotator", source, revision }),
            ),
        },
      ),
    );
    assert.equal(received.production.length, 0);
    assert.equal(received.incident.length, 1);
    assert.equal(received.incident[0].source, result.decisionFile);
    assert.equal(JSON.parse(await readFile(result.decisionFile, "utf8")).decision, "annotated");
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(root, { recursive: true, force: true });
  }
});

test("approval with notes stays approved; failed wake retains durable decision", async () => {
  const root = await fixture();
  try {
    const result = await Effect.runPromise(
      review(
        {
          plansRoot: root,
          repository: "test/plans",
          coordinator: "incident",
          mode: "approve-plan",
          source: "plans/example.md",
        },
        {
          launch: async () =>
            JSON.stringify({ decision: "approved", feedback: "Keep this scoped." }),
          notify: async () => {},
          wake: async () => {
            throw new Error("Coordinator offline");
          },
        },
      ),
    );
    assert.equal(result.decision, "approved");
    assert.equal(result.notification.status, "failed");
    assert.equal(
      JSON.parse(await readFile(result.decisionFile, "utf8")).feedback,
      "Keep this scoped.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing decision and changed snapshot never wake as approved", async () => {
  for (const change of [false, true]) {
    const root = await fixture();
    try {
      await assert.rejects(
        Effect.runPromise(
          review(
            {
              plansRoot: root,
              repository: "test/plans",
              coordinator: "production",
              mode: "approve-plan",
              source: "plans/example.md",
            },
            {
              launch: async (args) => {
                if (change) {
                  await writeFile(args[1], "# Different plan");
                }
                return change ? JSON.stringify({ decision: "approved" }) : "";
              },
              notify: async () => {},
              wake: async () => {
                assert.fail("Invalid result must not wake as a decision");
              },
            },
          ),
        ),
      );
      const base = join(root, "handoffs/reviews/production");
      const [id] = await readdir(base);
      const files = await readdir(join(base, id));
      assert.ok(files.includes("failure.json"));
      assert.ok(!files.includes("decision.json"));
      assert.ok(files.includes("response.txt"), "raw response retained even if invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
