# T3 Code Planning Fork Context

Domain language for the planning fork. Use these words with these meanings; the
_Avoid_ lines are the phrasings that have caused confusion.

## Glossary

### Authoritative work board

A user-managed board whose cards are the source of truth for autonomous agent
work in one project.
_Avoid_: passive dashboard, status-only board

### Project board file

`.t3/agent-board.json` inside a project. It holds that project's board and all
durable runner state. One board file controls one project folder.
_Avoid_: global board file, shared board file

### Work card

A board item describing one runnable unit of agent work.
_Avoid_: visual-only task, note

### Intent brief

A card's structured intent: desired outcome, acceptance criteria, constraints,
non-goals, open decisions. A card cannot be `Ready` without one — the schema
rejects it.
_Avoid_: implementation spec, title-only card

### Task record

The durable markdown document under `docs/agents/tasks/` that holds one card's
owner intent, completion bar, scope guard, verification, and proof. The local
stand-in for Symphony's single workpad comment per issue.
_Avoid_: board card, issue title, chat summary

### Slice plan

A durable document under `docs/agents/slices/` explaining direction and
guardrails for a branch of related work. Guides many cards; replaces none of
their intent briefs.
_Avoid_: work card, chat plan, implementation log

### Project planning stack

The project-local set of workflow, context, master plan, slice plans, and task
records that orients a fresh agent without prior chat history.
_Avoid_: chat history, one giant prompt

### Project workflow

`WORKFLOW.md`. Its front matter is the runner's runtime config; its body is the
policy agents follow. The only file the runner requires, and even that has
defaults.
_Avoid_: card brief, project vision

### Board runner

The in-server service that polls each enabled project's board, claims `Ready`
cards, launches and repairs them, and writes results back. It is part of T3
Code — there is no separate daemon to start.
_Avoid_: external daemon, separate scheduler

### Runner enablement

`runner.enabled` on a project's board file. Off by default, per project,
persisted across restarts, and only ever written by the server. The `Runner`
switch in the Planning header is the control.
_Avoid_: global setting, client-owned flag

### Card worktree

The isolated git worktree at `.t3/workspaces/<key>` on branch
`agent-board/<key>` that one card's agents work in. Reused across that card's
retries, never cleaned up automatically.
_Avoid_: main project folder, shared workspace

### Result block

The single fenced `agent-board-result` JSON block that ends every worker and
review turn. The runner reads this and nothing else to decide the card's next
state.
_Avoid_: prose summary, diff inspection

### Fresh review agent

A new thread with no implementation context that reviews the finished work on
the card's worktree.
_Avoid_: original implementation agent, continuation agent

### Autonomous delivery loop

The runner's cycle: claim, implement, diagnose and repair, review, advance —
without routine user intervention.
_Avoid_: manual review loop, supervised coding session

### Planning surface

The route at `/planning/$environmentId/$projectId` that renders the board as
Kanban, a Planning table, or a dependency tree. Web and desktop only.
_Avoid_: right-side panel, chat tab, separate app

### Break

The persisted browser-local kill switch in the Planning header. Pulling it stops
the current project's runner and keeps the Planning surface from mounting until
released.
_Avoid_: logout, feature flag, server setting

### Parallelism plan

Per-card metadata (`safe`, `reason`, `conflictsWith`, `allowedWriteScopes`) that
decides whether the runner may run this card alongside another.
_Avoid_: global parallelism guess, always-parallel execution

### Ready

The board state for cards eligible for autonomous pickup. The only launch state.
_Avoid_: Todo

### Running

The board state for a card whose implementation turn is in flight. Runner-owned.
_Avoid_: in progress

### Review

The board state for work an agent finished and a human has not accepted. The
default landing state after an approved review.
_Avoid_: complete, pending

### Needs Decision

The board state for a card blocked on user intent, an exhausted repair budget,
or a choice an agent should not make alone. Always carries the question.
_Avoid_: failed, error

## Relationships

- A **project board file** belongs to exactly one project folder and contains
  the **work cards** for it.
- A **work card** must have an **intent brief** before it can enter **Ready**.
- A new **work card** starts outside **Ready**, so creating a card never
  launches an agent.
- The **board runner** claims **Ready** cards only, and only for projects whose
  **runner enablement** flag is on.
- A claimed **work card** gets its own **card worktree** instead of running in
  the project folder.
- Every worker and review turn ends with one **result block**; the runner reads
  it to move the card.
- Work an implementation agent finishes goes to a **fresh review agent** before
  it can reach `Done`.
- **Needs Decision** is for intent and decision boundaries; routine failures stay
  in the **autonomous delivery loop**.
- A **task record** holds a card's durable intent and proof; the **work card**
  is the operational control handle for it. Runtime state lives in the **project
  board file**, never in the task record.
- A **slice plan** guides many cards without replacing any card's **intent
  brief**.
- The **project workflow** defines reusable agent rules; each **intent brief**
  defines one unit of work.
- The **planning surface** shows Kanban, table, and dependency views over the
  same cards. None of them is a separate planning system.
- **Break** and **runner enablement** are separate controls: pulling **Break**
  stops the runner, releasing it does not restart the runner.

## Example dialogue

> **Dev:** "If I add a work card and move it to Ready, is that just for
> tracking?"
> **Domain expert:** "No. The board is the source of truth; Ready makes the card
> eligible for an agent run — as soon as the runner is on for that project."

> **Dev:** "Can a title-only card enter Ready?"
> **Domain expert:** "No. Without an intent brief the board file will not even
> decode."

> **Dev:** "Does the runner read the agent's diff to decide if it finished?"
> **Domain expert:** "No. It reads the result block. Anything else would be a
> guess."

> **Dev:** "Should a test failure stop the board and ask me what to do?"
> **Domain expert:** "No. Routine failures stay inside the loop with bounded
> repair cycles. Only intent, scope, risk, credentials, cost, or destructive
> actions reach Needs Decision."

> **Dev:** "Can the agent that implemented a card approve its own work?"
> **Domain expert:** "No. Review runs in a fresh thread with no implementation
> context."

> **Dev:** "Do I need to start a separate Symphony daemon?"
> **Domain expert:** "No. The runner is in the T3 server. You turn it on per
> project."

> **Dev:** "Can I hand-run a card while the runner is on?"
> **Domain expert:** "No. The runner owns the board when it is enabled. Turn it
> off first."

> **Dev:** "Does releasing Break start the agents again?"
> **Domain expert:** "No. It only reopens Planning. Restarting agents is a
> separate, deliberate switch."

> **Dev:** "Can one board launch work across every project?"
> **Domain expert:** "No. Each board file governs its own project folder."

> **Dev:** "Should heartbeat and workspace paths go in the task markdown?"
> **Domain expert:** "No. Runtime state lives in the board file; the task record
> holds durable planning and proof."

## Flagged ambiguities

- "Todo" can mean tracked future work or runnable work. Resolved: **Ready** is
  the only agent-pickup state, and `Backlog` is the parking spot.
- "Workspace" means a T3 project root in upstream vocabulary and a per-card
  worktree in Symphony's. In this fork, say **card worktree** when you mean the
  latter.
