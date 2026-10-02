# Pixel Agents

Pixel Agents turns AI coding sessions into animated characters in a pixel-art office. This glossary is the canonical language for contributors and integrators; end-user docs may simplify it but must never contradict it.

## Hosts & Adapters

**Host**:
The machine Pixel Agents runs on — a laptop, a phone, a VPS, a Raspberry Pi. The office is the same on every host, and can be reached from another device.
_Avoid_: platform, environment, server (that's the runtime process)

**Adapter**:
The integration that connects one editor or application — VS Code, standalone, a macOS app, and the like — to Pixel Agents. An adapter composes the runtime and the office UI, and binds them to that environment's terminals, storage, and conventions. One adapter per editor or application; VS Code and standalone are the two today.
_Avoid_: host (that's the machine it runs on), surface, flavor, platform, edition

**Standalone**:
The adapter that serves the office to a browser from a local server, independent of any editor.
_Avoid_: CLI (that's the entry command, not the adapter), browser mode

## Agents & Teams

**Agent**:
An AI coding session tracked by Pixel Agents, whether spawned from the office or adopted from an external terminal.
This is the legacy Pixel Agents meaning; in SoftwareAgents domain documentation, use **Session** for this concept and reserve **Agent** for an AgentSpec instance (see [SoftwareAgents](#softwareagents)).
_Avoid_: bot, terminal (as a synonym), session (as a synonym in legacy Pixel Agents terminology)

**Headless agent**:
An agent with no terminal — a non-interactive run adopted from outside the office, for example. A full citizen: it has a seat and can be selected, but there is no terminal to focus. Agents it spawns are sub-agents or teammates like anyone else's. Optionally drawn as a Ghost.

**Character**:
The animated pixel-art figure representing an agent in the office. An agent has a status and a session; its character has a position and an animation state.
_Avoid_: avatar, sprite (a sprite is the image asset, not the figure)

**Ghost**:
A character drawn translucent because its agent is headless — the visual shorthand for "nothing to focus here". Opt-in: off unless the user turns on "Display Headless as Ghosts", and never used in adapters without terminals, where every agent would qualify and the cue would say nothing. Teammates and sub-agents are never ghosts; clicking one reaches its lead's or parent's terminal.
_Avoid_: faded, dimmed, transparent, inactive (that's a status)

**Sub-agent**:
An unnamed piece of delegated work spawned by an agent, visualized with its own character near its parent — around it, not in a seat. Not an Agent (no session of its own) and not a Teammate (no name). It exists only for the duration of its task, which may outlive the parent's turn. Having no name is what makes it a sub-agent.
_Avoid_: subtask (UI label prefix only)

**Team**:
A Lead plus the Teammates it spawned. A team exists because a teammate was spawned — whether or not the CLI recorded one. A CLI's team registry is evidence of a team, never its definition.

**Lead**:
The agent that spawned a Team's teammates. An agent becomes a lead the moment it spawns its first teammate.
_Avoid_: parent (that's the sub-agent relationship), orchestrator

**Teammate**:
A named agent spawned by another agent — the name is what makes it a teammate. Its spawner is its Lead, and together they form a Team. Every teammate has its own transcript and sits in a seat; it may or may not have its own session or terminal — how it runs never changes what it is.
_Avoid_: inline teammate, tmux teammate, session teammate (former run-style distinctions; a teammate's run style is a property, not an identity)

## Agent Lifecycle

**Launch**:
Start a new agent from the office.
_Avoid_: spawn (that's the character-level visual event), create

**Adopt**:
Begin tracking a session that was started outside the office. An adopted agent is a full citizen.
_Avoid_: import, attach

**Spawn / Despawn**:
The character-level visual event: a character materializing into or dissolving out of the office. An agent is launched or adopted; its character spawns.

**Dismiss**:
Remove an agent from the office by user choice, without judging its session. A dismissed session is not re-adopted.
_Avoid_: close, delete

**Orphaned**:
An agent whose transcript has been deleted, so the session it represents no longer exists. The office removes orphaned agents automatically.
_Avoid_: stale (implies inactivity or age, which never removes an agent), dead, ended

## Interaction

**Select**:
Mark a character as the current subject in the office (the white outline). Selection is what seat reassignment operates on.
_Avoid_: focus (reserved for terminals), highlight

**Follow**:
The camera tracking the selected character. Ends on manual pan or deselection.
_Avoid_: track

**Focus**:
Bring an agent's terminal to the front. Reserved exclusively for terminals — never the in-office highlight.

## First Run

**Intro**:
The four-step first-run tour the Greeter speaks: welcome, Claude Code, hooks consent, all set. The hooks consent ask is one step of it, not a separate dialog.
_Avoid_: onboarding, tutorial, wizard, consent modal

**Greeter**:
The character that speaks the Intro. Not an agent and not a Pet: it has no session, takes no seat, never wanders, and exists exactly as long as the Intro is open.
_Avoid_: mascot, tutorial character

## Agent Status

**Active**:
An agent that is executing its turn.
_Avoid_: busy, working, running

**Inactive**:
An agent that is not executing. Comes in exactly three forms: done, waiting for input, or permission request.
_Avoid_: waiting (the wire protocol's historical umbrella term), idle

**Done**:
The inactive form where the agent finished its turn and nothing is pending.

**Waiting for input**:
The inactive form where the agent asked the user something and is blocked on a reply.

**Permission request**:
The inactive form where the agent is blocked until the user approves a tool use. Unlike the other two forms, it can occur mid-turn.

**Activity label**:
The human-readable line describing what an agent is doing right now (e.g. "Reading foo.ts"), shown above its character.
_Avoid_: status text, tool status

**Speech bubble**:
The indicator above a character announcing a form of inactivity: "…" for a permission request (stays until resolved), a checkmark for a finished turn (fades on its own).
_Avoid_: bubble alone when ambiguous, notification

**Context gauge**:
The small bar under an agent's activity label showing how full its context window is. Every agent has one once it has taken a turn; sub-agents never do, having no session of their own. It reads the newest turn, so it falls when a session compacts or clears — it is a level, not a total.
_Avoid_: fuel gauge, health bar, token gauge (tokens are the unit, context is the thing)

## Office & Layout

**Office**:
The whole simulated world: the layout plus its inhabitants — characters and pets — and their live state.
_Avoid_: map, scene, room, level

**Layout**:
The office's spatial arrangement: the tile grid, floors, walls, carpets, areas, and furniture. It is the part of the office that the editor edits and that can be exported and shared.
_Avoid_: floor plan, blueprint, map

**Tile**:
One cell of the office grid.

**Floor**:
The walkable surface of a tile, painted with a pattern and color.

**Wall**:
A blocking tile that visually connects to adjacent walls.

**Carpet**:
A decorative layer painted over floor tiles.

**Area**:
A named region of tiles. Areas exist so workspace folders can be mapped to them.
_Avoid_: zone, region

**Area mapping**:
The assignment of a workspace folder to one or more areas. Many folders may share an area. Agents launched from a folder prefer seats inside any of its areas.

**Furniture**:
A placeable item in the layout — desks, chairs, storage, electronics, decor.
_Avoid_: object, prop, item

**Desk**:
Furniture that seats face and that hosts surface items. An agent's character sitting at its desk is the visual expression of being active.

**Seat**:
A sittable spot the office derives from chair furniture, assignable to exactly one agent.
_Avoid_: chair (that's the furniture), workstation

**Chair**:
The furniture category whose items create seats. Every footprint tile of a chair yields one seat.

**Seat assignment**:
Which agent owns which seat. Persisted, and changeable by selecting a character and clicking a free seat.

**Pet**:
An animated creature that lives in the office and belongs to no agent. Purely decorative; wanders like a character.
_Avoid_: mascot, animal

**Wander**:
The stroll a character takes away from its seat while its agent is done. Characters whose agents are waiting for input or awaiting a permission stay seated.
_Avoid_: roam, patrol

## Activity Detection

**Hook**:
A push notification an AI tool sends about its own session activity, delivered to Pixel Agents as it happens.

**Transcript**:
The append-only record of a session. Read in both detection modes for tool content.
_Avoid_: JSONL (Claude's file format, not the concept), log

**Hooks mode**:
The preferred detection mode, in which agent status is driven by hooks.

**Heuristic mode**:
The fallback detection mode, in which agent status is inferred from transcript activity, timers, and silence.
_Avoid_: file fallback, transcript mode, polling mode

## Integration Boundary

**Provider**:
The integration that connects one coding-agent CLI — Claude Code, Codex, Pi, Antigravity, OpenClaw, and the like — to Pixel Agents. A provider normalizes its CLI's raw activity into agent events and knows how to install that CLI's hooks. One provider per CLI; Claude Code is the reference implementation.
_Avoid_: plugin, connector

**Agent event**:
The canonical, CLI-agnostic description of something happening in a session: a tool started, a turn ended, a teammate went idle. Providers produce agent events; everything downstream consumes only these, never CLI-specific names.
_Avoid_: hook event (the raw, CLI-specific payload before a provider normalizes it)

**Runtime**:
The adapter-independent core that tracks agents and drives the office. It is a separate thing from the adapters that compose it, the providers that feed it, and the office UI it serves.
_Avoid_: server, backend

**Transport**:
The channel carrying protocol messages between the office UI and the runtime. The protocol is identical on every adapter; only the wire differs.
_Avoid_: connection, socket

**Protocol**:
The message contract between the office UI and the runtime, shared by every adapter and defined in a single source of truth.
_Avoid_: API

## SoftwareAgents

These terms extend the Pixel Agents vocabulary for the incremental fork described in [ADR-0002](docs/adr/0002-evolucion-incremental-del-fork.md). They describe domain concepts, not a claim that every component is implemented; ADR-0002 remains Proposed pending Fede's approval.

### Naming rule: Agent ≠ Model

In SoftwareAgents domain documentation, **Agent** (Spanish: **Agente**) means a persistent instance of an AgentSpec in a project. Use **Session** (**Sesión**) for the CLI interaction tracked by the legacy runtime and **Character** (**Personaje**) for its visual figure. Existing Pixel Agents sections and code identifiers such as `AgentRuntime` and `AgentEvent` retain their legacy meanings; this glossary does not rename code or protocol fields.

For example, a project's Developer Agent instantiated from `developer@v1` can perform one Execution through Codex CLI and a later Execution through Claude Code CLI. The Agent retains its project identity and role across those executions; their CLI sessions and office characters are representations, not its identity. An adopted external CLI session with a seated character does not automatically become an AgentSpec instance.

**Agent ≠ Model**: the Agent defines a project role and bounded authority, the Executor runs the CLI, and the Model is the underlying LLM selected for an execution. Changing the executor or model does not create a new Agent or grant more permissions. Permissions, quotas, and gates are enforced deterministically outside the LLM.

### Domain glossary

**Platform**:
The SoftwareAgents product that coordinates supervised software work across projects, including execution, orchestration, and user interfaces.
_Do not confuse with_: Host (the machine), Adapter (an application integration), or Pixel Office (one interface).

**Development Project**:
The SoftwareAgents ClickUp project that organizes development of the Platform itself.
_Do not confuse with_: a Managed Project served by the Platform or the fork's source repository.

**Managed Project**:
A user's software project developed or managed through the Platform, with its own context, agents, tasks, and policies.
_Do not confuse with_: the Development Project or a workspace folder used by the legacy office.

**Fundtrinsic**:
An independent project whose files, data, and processes are outside this Development Project's scope; its legacy integration remains compatible without requiring migration.
_Do not confuse with_: the Platform, its Development Project, or an automatically migrated Managed Project.

**Pixel Office**:
The visual interface projecting real work as characters, activity, and office state; it is not the authority for operational state or permissions.
_Do not confuse with_: the whole Platform, the operational store, or Layout (the spatial arrangement).

**Command Center**:
The interface for inspecting project details and controlling work, including tasks, executions, decisions, and gates.
_Do not confuse with_: Pixel Office (the visual overview) or the runtime enforcing a requested action.

**Project**:
The domain entity representing a Managed Project and tying its repository, Project Brain, agents, tasks, and policies to a stable identity.
_Do not confuse with_: the Development Project in ClickUp, a repository alone, or a CLI's session-directory naming convention.

**Project Brain**:
The project's shared, Git-versioned declarative knowledge: requirements, designs, decisions, and other reviewed project context.
_Do not confuse with_: mutable execution state, a session's context window, or operator secrets; `CONTEXT.md` and `CLAUDE.md` keep their existing paths.

**AgentSpec**:
A versioned declarative specification of an agent's role, mission, capabilities, permission profile, knowledge sources, and expected outputs.
_Do not confuse with_: its instantiated Agent, a Model, or a CLI launch command.

**Agent (Agente)**:
A persistent instance of a particular AgentSpec version within a Project, with project identity, role, lifecycle, and bounded authority across executions.
_Do not confuse with_: the legacy Pixel Agents Agent (a Session), a Character, an Executor, or a Model.

**Executor**:
The local Claude Code CLI or Codex CLI integration that performs an Execution using the operator's subscription and authentication, under externally enforced policy.
_Do not confuse with_: an Agent, its underlying Model, or a Provider that normalizes activity for the office.

**Execution**:
One traceable attempt to perform assigned work through an Executor, with its input context, lifecycle, result, and artifacts.
_Do not confuse with_: the persistent Agent, the Task (which may require multiple attempts), or a CLI Session or turn.

**FeatureSpec**:
A versioned definition of a feature's intended behavior and user value, including rules, edge cases, and verifiable acceptance criteria.
_Do not confuse with_: TechnicalDesign (how to build it), an implementation Task, or an unvalidated feature idea.

**TechnicalDesign**:
A technical plan translating a FeatureSpec into implementation choices, component boundaries, and validation approach.
_Do not confuse with_: FeatureSpec (required behavior), an ADR (a recorded architectural decision), or the Task DAG.

**Task**:
A bounded unit of project work with an objective, acceptance criteria, dependencies, assignment, and operational status.
_Do not confuse with_: an Execution attempt, a CLI's `Task` tool, or the office's Subtask label.

**Task DAG**:
A directed acyclic graph of Tasks and their dependency edges, defining which work becomes eligible after prerequisites are satisfied.
_Do not confuse with_: a flat backlog, an agent Team, or a scheduler's choice of when eligible work actually runs.

**Lease**:
A time-bounded claim on work by a particular execution owner, renewed while that owner remains responsible and recoverable after expiry.
_Do not confuse with_: permanent assignment, permission to execute, or a guarantee that the previous process has stopped.

**CapacitySnapshot**:
A timestamped observation of executor/account capacity, with available quota dimensions, reset times, source, and confidence; unknown capacity remains explicitly unknown.
_Do not confuse with_: the Context gauge, a guaranteed reservation, or a single universal quota percentage.

**Human Decision**:
A recorded human response to an escalated question or approval request, tied to its scope and the work or gate it resolves.
_Do not confuse with_: an agent recommendation, a visual click alone, or blanket authorization for later actions.

**Gate**:
A policy-enforced condition that blocks a transition or action until required evidence or approval is present; a human gate requires a Human Decision.
_Do not confuse with_: an office status indicator, a CLI Permission request, or every gate being a human approval.

**DomainEvent**:
A recorded fact about a meaningful domain change, such as a Task being leased or a Human Decision being recorded, correlated with the affected project and work.
_Do not confuse with_: legacy `AgentEvent` activity notifications, raw CLI hooks, or a command requesting a change.

**Audit log**:
A durable chronological record of consequential actions, decisions, policy outcomes, and their actors and references, allowing work to be reconstructed.
_Do not confuse with_: a CLI Transcript, debug output, or DomainEvent alone (one fact rather than the audit history).

**Operator config**:
Trusted operator-controlled settings outside project-authored content, defining allowed executors, commands, and machine-level limits; the existing company command allowlist lives in `~/.pixel-agents/config.json`.
_Do not confuse with_: Project Brain, `board.json` requests, or AgentSpec declarations; project content cannot grant itself execution authority.
