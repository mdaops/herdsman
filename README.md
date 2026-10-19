# Herdsman

Personal coordination software for working with multiple coding agents across
[Pi][pi], [Claude Code][cc], Herdr and Plannotator.

**This is highly personal software, built around how I like to work.** I want to
keep talking to a coordinator while its workers make progress, share context
between projects, and review plans and code in a proper review surface. I do not
want worker updates pasted into my terminal editor as if I typed them.

Herdsman connects those tools. It is not a general-purpose agent platform, a task
database, or a replacement for any of them. The interfaces are early and may
change with my workflow. It is suitable for a controlled local trial, not an
unattended production orchestration service.

## The model

A **coordinator** is a durable identity with a remit and authority, not a process,
product repository or initiative. It can own one task and retire, persist through
many sessions, or span several initiatives. Multiple coordinators can reference
shared context without owning the same assignments.

```text
Plans repository: profiles, shared context, plans, assignments, handoffs
    │
    ├── orion-production                    durable coordinator ID
    │     ├── production database           owned work
    │     └── migration verification
    │
    └── orion-incident                      another coordinator ID
          ├── review logs
          └── rollback constraints

Both reference the same Orion context. Neither needs an always-running parent.
```

The running Pi or Claude Code session is replaceable. On another machine, the
coordinator recovers from published checkpoints and establishes a fresh local
binding. Old transcripts, socket paths and browser URLs are not recovery state.

My operating rule is to sync and stop/release work before switching machines.
The coordinator owns that sync; Herdsman does not perform it. Unsynced work may
remain unavailable on the next machine. Git is not a distributed ownership lock.

## What it does

- Routes wake events by **plans-repository ID + coordinator ID**.
- Pins named delivery to a particular receiver lifetime, rejecting stale bindings.
- Injects attributed events through native Pi/CC APIs without touching the editor.
- Lists local bindings and displays the actual durable coordinator profile.
- Opens coordinator-owned Plannotator plan feedback, approval and code reviews.
- Saves review evidence before waking the owning coordinator.
- Uses Herdr notifications to bring a human to the relevant review link.

The workflow around it uses one Herdr space per coordinator, with labelled worker
tabs. The canonical [Herdsman operating skill](skills/herdsman/SKILL.md) ships here.
My broader coordinator/plan skills live separately in `mdaops/dotfiles` and reference
that skill; durable workflow documents live in the plans repository. Installation is
explicit: the runtime does not install skills or automatically move panes.

## Architecture

```text
Worker saves or publishes a handoff
    │
    └── named wake(repository, coordinator, source, revision)
          │
          ▼
      local binding directory
          │  socket + expected receiver instance
          ▼
      HTTP over a private Unix-domain socket
          ├── Pi extension → custom follow-up message
          └── CC MCP channel → attributed channel event
                                    │
                                    ▼
                          coordinator reads the source
                          and reconciles durable state
```

There is no broker, durable event queue, polling coordinator or background sync
service. A wake is a hint to inspect a source, not the source of truth or a grant
of authority. Assignments must authorize autonomous reconciliation independently.

Pi queues a follow-up after the current turn. CC can absorb a channel event between
tool steps in the current turn. Both preserve the editor; identical turn scheduling
is not part of the shared contract.

### Three separate kinds of state

| State                | Location                                           | Purpose                                               |
| -------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| Durable work         | Plans repository and referenced artifacts          | Profiles, context, decisions, checkpoints             |
| Local routing        | `HERDSMAN_STATE_DIR`                               | Receiver instance, socket, checkout and optional pane |
| Local review session | Plans checkout's ignored `local/herdsman-reviews/` | Live URL and launcher state                           |

The default routing directory is `~/.local/state/herdsman`. The CLI reads profiles
from `coordinators/<id>.md`; it does not copy context into the registry or interpret
the profile as an executable permissions policy. The runtime list is not a complete
inventory of durable coordinators: profiles can exist with no local binding.

## Requirements

- Node.js 24 and npm.
- Pi or Claude Code for the receiving session.
- Plannotator for review commands; Herdr for optional human notifications/grouping.
- A Unix filesystem supporting sockets and private directories.

Effect **4.0.5** provides validation, typed effects and scoped listener cleanup.
The CC adapter uses the MCP SDK over stdio.

| Environment     | Status                                           |
| --------------- | ------------------------------------------------ |
| Arch Linux      | Automated and live harness tests passed          |
| macOS           | Intended target; not yet tested                  |
| Windows via WSL | Intended target; not yet tested                  |
| Native Windows  | Not supported by this Unix-socket implementation |

Under WSL, keep sockets and runtime state on its Linux filesystem, not a Windows
mount. Tool installations, credentials and paths are configured on each machine.

## Teach the agent to use Herdsman

The Pi package installation below installs both the receiver extension and the
[operating skill](skills/herdsman/SKILL.md). For CC, or skill-only use without an
inbound receiver, use the links below. The adapter delivers events; the skill explains binding,
save-before-wake,
reconciliation, uncertain delivery, review handling and recovery. Neither grants
authority: the agent still needs an explicit assignment.

From the reviewed checkout root, link the canonical directory into the relevant
harness locations. Install just the harness you use, or both:

```sh
export HERDSMAN_DIR="$(pwd -P)"
for root in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
  dest="$root/herdsman"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf 'Already exists; inspect rather than overwrite: %s\n' "$dest"
  else
    mkdir -p "$root"
    ln -s "$HERDSMAN_DIR/skills/herdsman" "$dest"
  fi
done
```

- **Pi:** discovers `~/.agents/skills/herdsman/SKILL.md`. Reload resources with
  `/reload` or start a new session; invoke explicitly with `/skill:herdsman`.
  Reload also replaces any active Herdsman receiver instance: inspect and explicitly
  retire/rebind its old registration as described below.
- **Claude Code:** discovers `~/.claude/skills/herdsman/SKILL.md`, including symlinked
  directories. In a new session, verify `/herdsman` appears and invoke it explicitly
  if needed. See the [Claude Code skills documentation][cc-skills].
- For project-only installation, use the project `.agents/skills/` location for Pi
  or `.claude/skills/` for CC instead. Respect project trust prompts.

Keep one active copy per harness to avoid name collisions or stale instructions.
If copying instead of linking, set HERDSMAN_DIR to the runtime checkout: copied
instructions do not include the runtime. If moving machines/checkouts, recreate
links locally. The skill resolves symlinks before using its checkout-relative paths.

Verify discovery in the actual harness; a filesystem link alone does not prove the
model loaded the skill. Do not type reload commands into another person's editor.
Loading the skill does not start a receiver, bind a coordinator, alter tool
permissions or approve a channel consent prompt. Follow the setup below separately.

Your coordinator-start/dispatch instructions should say to read the installed
Herdsman skill when using this integration, rather than maintaining another copy
of its procedure. If unavailable, point them explicitly at this checkout's
`skills/herdsman/SKILL.md`.

## Install receiver support once per machine

From the reviewed checkout:

```sh
npm ci
npm run validate
export HERDSMAN_DIR="$(pwd -P)"
```

Installing support is separate from assigning a coordinator role. Each loaded
receiver allocates its own private temporary directory and socket by default.
Normal shutdown/session replacement closes the listener and removes that owned
directory. A crash may leave its directory behind; later sessions choose new paths
rather than taking it over. No coordinator bindings are created automatically.

### Pi

Install this local Pi package once:

```sh
pi install "$HERDSMAN_DIR"
```

The manifest supplies the receiver extension and canonical skill. Fresh Pi sessions
now start their own receivers without environment variables or hand-written loaders.
Existing sessions need a normal user `/reload`; Herdsman never types it for them.
Remove the old one-session spike loader when migrating, so it does not compete with
the package. Package installation is explicit trust in executable extension code.

Before each agent run, the extension supplies a structured `herdsman_receiver`
context section containing **this session's** socket, instance, checkout and skill
path. It preserves other prompt sections and never touches the input editor or
starts a model turn merely to announce readiness. A startup failure is reported,
not advertised as a usable receiver.

The coordinator reads its durable role/assignment, inspects existing registrations
and binds its assigned namespace/ID to that endpoint within its runtime authority.
Installed-but-unbound is a setup step, not missing software. If a reload or permission
is still needed, report that blocker rather than quietly dispatching without wakes.

For an isolated invocation without a persistent installation:

```sh
pi --extension "$HERDSMAN_DIR"
```

The listener starts on session start and closes on shutdown/replacement. Delivery
still uses `pi.sendMessage()` with an attributed custom follow-up. The optional
programmatic `sessionFile` guard remains available for isolated tests, but is not
part of ordinary installation.

### Claude Code

Register the server once at user scope after inspecting any existing entry:

```sh
claude mcp get herdsman
# Only add if absent; do not overwrite another configured server.
claude mcp add --scope user --transport stdio herdsman -- \
  npm --prefix "$HERDSMAN_DIR" run --silent cc
```

This command records the absolute checkout path and works from other directories.
It does not opt a session into experimental channels or approve trust prompts.

Start sessions that need to **receive** notifications with:

```sh
claude --dangerously-load-development-channels server:herdsman
```

Each adapter process allocates a different endpoint. Its MCP initialization
instructions identify that endpoint and the local checkout to Claude. The adapter
does not accept delivery before MCP initialization. CC must also have registered
the channel: confirm its startup notice and a processed test event. A listening
socket or successful MCP initialization alone does not prove channel opt-in.

Custom Channels require explicit consent and supported Anthropic authentication/
account policy. The development flag enables the research-preview channel, not
unattended tool approval. It also presents a development-channel confirmation on
launch. Current official documentation provides no per-user persistent approval
for a custom channel on Pro/Max. Default to human confirmation. A user can separately
delegate the exact known local startup confirmation to their coordinator, subject to
the checks below. Never disable ordinary tool permissions to hide this requirement.

The supported non-development path is an approved channel plugin: Anthropic's
allowlist, or a Team/Enterprise administrator's `allowedChannelPlugins` policy.
Merely packaging a private plugin does not approve it. See [channel controls][channels].
Already-running CC sessions need a restart with the
appropriate configuration to gain the receiver; do not restart unrelated work.

The adapter declares only `claude/channel`: no reply tool or permission relay.
Managed interactive workers should launch with receiving support by default because
coordinators need to deliver later assignment revisions. Only explicitly sender-only
workers need no receiver: their outbound CLI reporting works without one. Pi and CC
can each coordinate or work; the harness does not determine the role. Refreshing CC
skills does not add startup channel flags to an already-running process.

The project-local `.mcp.example.json` remains an alternative when launching from
this checkout with an explicit MCP config.

### Optional delegated startup confirmation

A user may give a narrow standing authorization for their coordinator to confirm
only the development-channel warning for their trusted local Herdsman receiver.
This is not a built-in Claude approval setting. Installing Herdsman or this skill
creates no such authorization; no generic auto-accept loop is installed.

The [skill](skills/herdsman/SKILL.md) specifies the checks: verify the recorded grant
for this machine, intended worker/process/launch, effective MCP command and trusted
checkout, and the exact blocked warning listing only `server:herdsman`. Confirm the
selected development option once, then inspect the result and record setup evidence.

Any different dialog, additional channel, unknown configuration override, changed
provenance, unexpected foreground process or uncertain outcome stops for the human.
Project trust, new MCP-server consent, tool permissions and organizational policy
are outside this delegation. The grant also does not authorize a launch/restart
that was not otherwise permitted. Keep machine-specific grants in ignored local
state and honor revocation. Do not turn setup consent into authority for worker actions.

### Explicit sockets and migration

`HERDSMAN_SOCKET` (or the Pi adapter's programmatic socket option) still overrides
automatic allocation for isolated setups. Its parent must already be an owned
private directory with no group/other access. Never export one fixed socket for
all sessions. Collisions fail closed; the listener never removes another endpoint.
Explicit socket parent directories remain caller-owned.

Reload/restart changes the instance, and automatic sockets also change path.
Old named records remain stale/offline until explicitly retired after checking
ownership. The coordinator then binds its current advertised endpoint; the runtime
does not silently reclaim registrations or grant takeover authority.

## Bind and notify a coordinator

Create the durable profile in your plans checkout first. Its filename is the ID:

```markdown
# Orion production coordinator

Coordinator ID: orion-production
Plans repository ID: example/plans
Remit: production database preparation and migration verification.
Authority: the explicitly assigned work; no implied deployment permission.
Context: ../context/orion.md
Owned work: references to the relevant plans and assignments.
Recovery checkpoint: published handoffs and their reviewed revisions.
```

Then, from the Herdsman checkout:

```sh
npm run coordinator -- bind example/plans orion-production \
  /absolute/path/to/plans "$SOCKET"
npm run coordinator -- list example/plans
npm run coordinator -- show example/plans orion-production
npm run coordinator -- wake example/plans orion-production \
  database-worker handoffs/database--prepare.md revision-1
```

Set SOCKET from this session's receiver context/instructions, not another pane or
a guessed temporary path. `example/plans` is a logical namespace; the CLI does not
fetch that repository.
An optional final `bind` argument records a verified Herdr pane ID. It is a local
navigation hint, not ownership proof. Discover it rather than using a focused pane
or an inherited ID from before a pane move.

The sender supplies a repository-relative source path. It must resolve to a regular
file inside the receiver's plans checkout; absolute paths, escapes and symlinks
escaping that root are rejected. Across checkouts, publish and synchronize the
source first. The wire event uses its resolved local path.

Registration probes the receiver and atomically creates a complete binding. It
refuses to replace an existing record, even a stale one. After verifying the old
binding should be retired:

```sh
npm run coordinator -- unbind example/plans orion-production '<expected-instance>'
```

Unbind removes a routing hint; it neither stops the agent nor transfers ownership.
Reloading/restarting a receiver creates a new instance and requires a fresh binding.
`list` distinguishes live, stale, offline and unreachable records.

### Two-way worker delivery

A worker is not a durable coordinator just because it receives updates. During
initial setup, the coordinator assigns a local runtime-record path; the worker saves
its current socket/instance from its own harness context, verifies identity, and
records its session/assignment association there. Keep that record in ignored
`local/` state, not in a durable profile. Confirm a bounded test event is actually
processed before claiming bidirectional readiness.

For an existing CC conversation launched without a channel, an authorized restart
must use its exact `--resume` ID, cwd and model plus the channel flag. Preserve unsent
drafts and work. Stop at consent prompts unless the exact development warning is
covered by the verified narrow delegation above. Do not replace its conversation
or substitute terminal notifications.

The coordinator publishes the revised assignment first, verifies the intended
worker's endpoint record, then sends a pinned wake:

```sh
npm run coordinator -- wake-receiver \
  "$PLANS_DIR" "$WORKER_SOCKET" "$WORKER_INSTANCE" \
  coordinator-a plans/open/example.md revision-2
```

All six arguments are required. Plans root and socket are absolute; source is an
existing regular file relative to that root. Absolute source paths, traversal and
escaping symlinks are rejected. The instance pin cannot be omitted. This command
creates no profile or binding and does not infer ownership. A stale pin is rejected,
not updated. Workers still use named `wake` to report back to their coordinator.

This explicit worker route shares the same source validation and pinned transport
as named delivery. It is **not** an automatic fallback for a failed named send.
No durable worker directory, scheduler or broker is added.

### Delivery contract

```json
{
  "sender": "database-worker",
  "source": "/local/plans/handoffs/database--prepare.md",
  "revision": "abc123"
}
```

| Endpoint            | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `GET /identity`     | Fresh receiver instance UUID and protocol version            |
| `POST /wake/pinned` | Named delivery with `x-herdsman-instance`                    |
| `POST /wake`        | Legacy direct spike path, without mandatory instance pinning |

A mismatched pin returns 409 before delivery. The separate pinned route makes older
receivers fail closed rather than silently ignoring an unfamiliar header. Normal
coordination should use the named CLI, not the direct `npm run wake` spike helper.

**HTTP 202 means the adapter accepted the send operation, not that the model read,
acted on, or reconciled the source.** Pi returns before turn completion; CC confirms
a transport write, not model processing. There are no automatic retries or
exactly-once guarantees. Reconcile before retrying an uncertain send, and make
checkpoint reconciliation idempotent. Startup recovery must inspect unreviewed
published checkpoints even when a wake was missed.

## Review and iterate in Plannotator

Review is a coordinator checkpoint, not an automatic worker-exit hook. After a
material return, distinguish your own source inspection from the human's review
surface: ready code normally gets a frozen code review; a substantive proposal
needing human input gets feedback-only plan annotation. Deployment prerequisites
do not prevent source review. Explicit approval gates require separate authority.

Before reporting ready work, record the exact revision's review disposition in
its existing plan: open, already reviewed, blocked, deferred or not needed, with
evidence/reason and next action. Give the human the live link or concrete opening
blocker, not merely a PR URL or activation checklist. Reuse matching reviews instead
of opening duplicates. These skill instructions improve decision-making but are
not runtime enforcement; the CLI cannot force a coordinator to invoke it.

An existing named binding supplies the coordinator's plans checkout:

```sh
# Collaborative feedback, without an approval gate
npm run review -- plan example/plans orion-production plans/drafts/database.md

# Explicit plan acceptance
npm run review -- approve-plan example/plans orion-production plans/next/database.md

# A selected code diff, supplied as a patch
npm run review -- code example/plans orion-production /absolute/path/to/change.patch
```

The wrapper freezes the source, opens the appropriate Plannotator surface, prints
the live URL and sends a coordinator-labelled Herdr notification when available.
Keep the launcher running in a terminal or persistent background process until the
human finishes. It is not a fire-and-forget browser opener.

On completion it saves the result, then wakes the owning coordinator through named
routing. Durable artifacts are written under:

```text
handoffs/reviews/<coordinator>/<review-id>/
  request.json       owner, mode, source reference and content hash
  source.md         frozen plan (source.patch for code)
  response.txt       raw returned response, when available
  decision.json     validated human decision
  failure.json      explicit failure instead of a valid decision, when applicable
```

These artifacts become cross-machine durable only when the coordinator publishes
them. Live URLs and delivery outcomes remain under ignored `local/` state.

The coordinator applies feedback to the original plan/code, not the frozen
snapshot. Approval applies to that snapshot; it does not approve later edits or
authorize merging/deployment. Approval with notes remains approval. Dismissal,
missing output, launch failure or a changed snapshot is not approval. A failed
wake leaves the saved decision available for recovery.

Code mode deliberately uses a static patch. Record the product repository and
base/head provenance in the associated assignment or plan; the wrapper does not
infer them from a patch. Use Plannotator directly for a freely switchable checkout
diff, but direct sessions do not gain automatic result-wake handling. Reopen local
sessions with `plannotator sessions`; recreate reviews rather than reusing another
machine's URL.

## Trust and current limits

- Same-machine, same-OS-user trust. Private directories exclude other ordinary
  users; any process with this user's access can send. Sender labels are not
  authenticated agent identities.
- A receiver instance pin is a routing guard, not a distributed ownership lock or
  an authorization token. The agent must enforce its existing assignment scope.
- No remote transport, automatic launcher, durable event queue, background sync,
  automatic takeover or deduplication service.
- A wake may lead to a real permission dialog. It never approves that dialog.
- The local registry may require manual recovery if conflicting bind/unbind
  operations displace a record. It reports that condition instead of discarding it.
- Review launchers must stay alive to capture results. Crashed/interrupted reviews
  are not automatically resumed or completed.
- Source access and review feedback still cross trust boundaries. This is personal
  workflow software, not an isolation boundary between mutually untrusted agents.

## Validation and development

```sh
npm ci
npm run format    # Oxfmt: apply the committed formatting rules
npm run validate  # TypeScript, Oxlint, formatting check and tests
```

Oxfmt and Oxlint versions are pinned. Lint checks include correctness rules, explicit
braces, duplicate imports and explicit-any rejection. Formatting uses 100-column
lines. `npm run check`, `npm run lint`, `npm run format:check` and `npm test` can also
run separately.

The current suite has **28 tests** covering transport, adapter contracts, named
routing, stale/legacy receivers, source-path containment, shared-context discovery,
fresh-checkout binding and review decision/routing behavior. Additional checks cover
branded IDs, schema variants and injected transport without uncertain-send retries.
Worker-route tests cover profile-free delivery, mandatory pinning, stale receivers,
source containment and absence of registry mutations.
Receiver-bootstrap tests cover isolated fresh Pi/CC endpoints, context publication,
startup failure, session replacement and cleanup. Two isolated real Pi RPC processes
also loaded the package and exposed distinct identity endpoints on Linux without
model calls. CC endpoint publication/delivery is verified with real MCP clients;
interactive channel consent remains a separate harness requirement.
The bundled skill is checked by Pi's pinned parser both directly and through a symlink;
this does not claim a live model loaded it or verify CC's interactive discovery.
Review tests simulate
human decisions; they do not constitute human approval.

Live Linux tests verified Pi and CC delivery while idle and busy, unfinished draft
preservation, a worker waking the actual coordinator, named return delivery, and a
Plannotator feedback result waking its owner. These live observations predate the
service refactor; the refactored behavior is covered by the current automated suite.
Detailed spike transcripts/evidence remain local and are not distributed in this repository.

### Effect service composition

```text
Review
  ├── Registry (one configured local state directory)
  │     └── WakeTransport (receiver identity and pinned HTTP sends)
  └── ReviewPlatform (Plannotator process and optional Herdr notification)
```

These are Effect v4 `Context.Service` definitions composed through Layers at the CLI
boundary. Registry operations capture their configured directory and injected
transport. Review orchestration resolves the owner through that registry, performs
explicit effectful artifact steps, then sends its result through the same registry.
Tests can replace transport or process/UI services without changing orchestration.

Named `Effect.fn` operations expose meaningful execution boundaries. `domain.ts`
defines validated, branded coordinator IDs and schema-derived review modes; registry
status and entry variants use tagged schemas. A brand is acquired through validation,
not by asserting that an arbitrary string is a coordinator ID.

Source layout: `bridge.ts` owns the listener, `pi.ts`/`cc.ts` adapt the harnesses,
`receiver.ts` owns automatic socket allocation and endpoint context, `client.ts`
implements wake transport, `registry.ts` owns bindings, `coordinator.ts`
dispatches CLI commands, and `review.ts` owns review orchestration and its platform adapter.

[pi]: https://github.com/earendil-works/pi
[cc]: https://code.claude.com/docs/en/channels-reference
[cc-skills]: https://code.claude.com/docs/en/skills
[channels]: https://code.claude.com/docs/en/channels#restrict-which-channel-plugins-can-run
