# Authoritative Agent Board Slice Plan

Status: `done` — the board, the Planning surface, and the runner all ship. Kept
as the guardrail document for further work on any of them.

## Intent

A project-local work board that is the source of truth for autonomous agent work
in T3 Code, plus the runner that drives it.

## Guardrails

- `Ready` is the only autonomous launch state; new cards never default to it.
- Title-only cards do not launch. A `Ready` card without an intent brief does
  not decode.
- Runtime state stays in `.t3/agent-board.json`. Owner intent, scope,
  verification, and proof stay in task records.
- `runner.enabled` is operator-owned: the server is its only writer, and a
  client board save must never carry it.
- `Running`, `Diagnosing`, and `Reviewing` are runner-owned. Nothing outside the
  runner claims a card in those states.
- Default concurrency is one card per project. Parallelism only when the card's
  parallelism plan says it is safe.
- Outcomes are reported through the `agent-board-result` block, never inferred
  from a diff.
- Kanban is the primary control view. The table and dependency tree are other
  views over the same cards, not a second planning system.
- The board never runs in the main project folder; every card gets its own
  worktree under `.t3/workspaces/`.

## Success criteria

- A fresh agent can be oriented by the project-local docs with no chat history.
- Board files share one validated schema across server, web, and desktop.
- Cards link to task records and slice plans, and the dependency view is
  generated from board fields.
- A `Ready` card reaches `Review` without user intervention when nothing needs a
  decision.
