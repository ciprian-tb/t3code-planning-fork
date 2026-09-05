# Agent Board Task Records

Durable task records for board cards. One record per runnable card, linked from
the card's `taskRecordPath`. Start from `TEMPLATE.md`.

The record is the persistent workpad and proof ledger. Keep plan, acceptance
criteria, validation, blockers, and final proof in the one file; do not scatter
progress across chat turns. The board card is the operational control handle for
it, and runtime state (workspace path, run ids, attempt counts) belongs to
`.t3/agent-board.json`, never here.

Every non-trivial record has: owner intent, target status, scope guard,
acceptance criteria, verification, parallelism plan, and proof-of-done filled in
before the card leaves `Review`.
