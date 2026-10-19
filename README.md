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

Install the [operating skill](skills/herdsman/SKILL.md) as well as configuring the
receiver. The adapter delivers events; the skill explains binding, save-before-wake,
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

## Start a receiver

From this checkout:

```sh
npm ci
npm run check
npm test
export HERDSMAN_DIR="$PWD"
mkdir -p .local
chmod 700 .local
```

The socket's parent must already exist, be owned by the current user, and have no
group/other access. The listener never unlinks an occupied or stale socket on
startup. After a crash, verify the old receiver is dead before removing its socket.

### Pi

```sh
HERDSMAN_SOCKET="$HERDSMAN_DIR/.local/pi.sock" \
  pi --extension "$HERDSMAN_DIR/src/pi.ts"
```

The extension opens its listener on session start and closes it on shutdown. It
uses `pi.sendMessage()` with `customType: "herdsman-wake"`, `triggerTurn: true` and
`deliverAs: "followUp"`. It does not call an editor or synthesize keystrokes.

An optional programmatic `sessionFile` guard restricts an explicitly installed
loader to one conversation. Installing the adapter into an already-running Pi
requires a normal resource reload; Herdsman does not type `/reload` for you.

### Claude Code

Run from this checkout because the example MCP config uses relative paths:

```sh
HERDSMAN_SOCKET="$HERDSMAN_DIR/.local/cc.sock" claude \
  --strict-mcp-config --mcp-config "$HERDSMAN_DIR/.mcp.example.json" \
  --dangerously-load-development-channels server:herdsman \
  --tools Read,Bash
```

Custom Channels are a research-preview feature requiring explicit consent and
supported Anthropic authentication/account policy. The development flag opts the
channel into that feature; it is not a tool-permission bypass. Confirm the channel
registered and processes a test event; a listening socket alone is insufficient.

The adapter declares only `claude/channel`. It provides no reply tool or permission
relay. Configure the session's instructions and tool permissions for its actual
assignment; the example tool list is not a sandbox.

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
  /absolute/path/to/plans "$HERDSMAN_DIR/.local/pi.sock"
npm run coordinator -- list example/plans
npm run coordinator -- show example/plans orion-production
npm run coordinator -- wake example/plans orion-production \
  database-worker handoffs/database--prepare.md revision-1
```

`example/plans` is a logical namespace; the CLI does not fetch that repository.
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

The current suite has **23 tests** covering transport, adapter contracts, named
routing, stale/legacy receivers, source-path containment, shared-context discovery,
fresh-checkout binding and review decision/routing behavior. Additional checks cover
branded IDs, schema variants and injected transport without uncertain-send retries.
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
`client.ts` implements wake transport, `registry.ts` owns bindings, `coordinator.ts`
dispatches CLI commands, and `review.ts` owns review orchestration and its platform adapter.

[pi]: https://github.com/earendil-works/pi
[cc]: https://code.claude.com/docs/en/channels-reference
[cc-skills]: https://code.claude.com/docs/en/skills
