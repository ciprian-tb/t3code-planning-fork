import type { AgentBoardCard } from "@t3tools/contracts";
import { AgentBoardReviewResult, AgentBoardWorkerResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "./schemaJson.ts";

/** Fence language that delimits a machine-readable turn result. */
export const RESULT_FENCE = "agent-board-result";

/** Why a card is being handed back to the implementation agent. */
export type ContinuationReason =
  | { readonly kind: "continue" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "review-findings"; readonly findings: ReadonlyArray<string> };

const list = (label: string, values: ReadonlyArray<string> | undefined): string =>
  values === undefined || values.length === 0
    ? `${label}: none`
    : `${label}:\n${values.map((value) => `- ${value}`).join("\n")}`;

// Cards created from the UI have no task record, so every instruction that
// points at one is conditional: without this an agent hunts a file that does
// not exist until it runs out of turns.
const workerProtocol = (card: AgentBoardCard): string =>
  [
    "When you finish this turn, end your message with exactly one fenced block:",
    "```" + RESULT_FENCE,
    '{"outcome":"done"|"continue"|"needs-decision"|"blocked","summary":"...","question":"...","changedFiles":["..."]}',
    "```",
    card.taskRecordPath === undefined
      ? 'Use "done" only after every acceptance criterion is met and focused verification passed; report that verification in "summary".'
      : 'Use "done" only after every acceptance criterion is met, focused verification passed, and the task record proof section is updated.',
    'Use "continue" if you ran out of budget but the work is on track.',
    'Use "needs-decision" only for intent, scope, risk, credentials, cost, or destructive actions; put the exact question in "question".',
    'Use "blocked" for an external blocker you cannot resolve.',
  ].join("\n");

const REVIEW_PROTOCOL = [
  "End your message with exactly one fenced block:",
  "```" + RESULT_FENCE,
  '{"outcome":"approved"|"changes-requested"|"needs-decision","summary":"...","findings":["..."],"question":"..."}',
  "```",
  'Use "changes-requested" with concrete, actionable findings; the implementation agent will receive them verbatim.',
].join("\n");

export const implementationThreadTitle = (card: AgentBoardCard): string =>
  `Implement ${card.title}`;

export const reviewThreadTitle = (card: AgentBoardCard): string => `Review ${card.title}`;

export function buildImplementationPrompt(card: AgentBoardCard): string {
  const brief = card.intentBrief;
  const references = [
    "AGENTS.md",
    "WORKFLOW.md",
    "PROJECT.md",
    "CONTEXT.md",
    card.slicePlanPath,
    card.taskRecordPath,
  ].filter((reference): reference is string => reference !== undefined && reference.length > 0);

  return [
    "PLEASE IMPLEMENT THIS AGENT BOARD CARD.",
    "",
    "You are a fresh implementation agent working in an isolated card worktree. The project-local board and task docs are the source of truth.",
    `Card: ${card.id}`,
    `Title: ${card.title}`,
    `Workspace: ${card.runtime.workspacePath ?? "(current directory)"}`,
    "",
    "Read these references first, in order:",
    ...references.map((reference) => `- ${reference}`),
    "",
    `Intent: ${brief?.intent ?? card.title}`,
    `Desired outcome: ${brief?.desiredOutcome ?? "Not specified"}`,
    list("Acceptance criteria", brief?.acceptanceCriteria),
    list("Constraints", brief?.constraints),
    list("Non-goals", brief?.nonGoals),
    list("Open decisions", brief?.openDecisions),
    list("Dependencies (already Done)", card.dependencies),
    list("Allowed write scopes", card.parallelism.allowedWriteScopes),
    "",
    "Execution rules:",
    "- Stay inside the allowed write scopes; if empty, stay inside this project.",
    ...(card.taskRecordPath === undefined
      ? [
          "- Run this project's focused verification for the files you touched (its test command for those files, plus a typecheck) before reporting done.",
          "- Report the verification you ran, the changed files, and any gaps in your result summary.",
        ]
      : [
          "- Run the focused verification named in the task record before reporting done.",
          "- Update the task record's proof section (changed files, verification, gaps).",
        ]),
    "- Do not ask questions you can answer from the docs.",
    "",
    workerProtocol(card),
  ].join("\n");
}

const continuationWhy = (reason: ContinuationReason): string => {
  switch (reason.kind) {
    case "continue":
      return "Your previous turn ended without a final result. Continue where you left off.";
    case "failed":
      return `Your previous turn failed: ${reason.error}\nDiagnose and repair, then continue.`;
    case "review-findings":
      return `A fresh reviewer requested changes:\n${reason.findings
        .map((finding) => `- ${finding}`)
        .join("\n")}\nAddress every finding.`;
  }
};

export function buildContinuationPrompt(card: AgentBoardCard, reason: ContinuationReason): string {
  return [
    `CONTINUE AGENT BOARD CARD ${card.id} (${card.title}).`,
    continuationWhy(reason),
    card.taskRecordPath === undefined
      ? "Do not restart from scratch; keep working in this workspace."
      : "Do not restart from scratch; keep working in this workspace and update the task record proof.",
    "",
    workerProtocol(card),
  ].join("\n");
}

export function buildReviewPrompt(card: AgentBoardCard, workerSummary: string): string {
  const brief = card.intentBrief;
  return [
    `REVIEW AGENT BOARD CARD ${card.id} (${card.title}).`,
    "",
    "You are a fresh review agent with no implementation context. Do not trust the implementer's summary; verify.",
    `Implementer summary: ${workerSummary}`,
    ...(card.taskRecordPath === undefined ? [] : [`Task record: ${card.taskRecordPath}`]),
    `Intent: ${brief?.intent ?? card.title}`,
    list("Acceptance criteria", brief?.acceptanceCriteria),
    list("Non-goals", brief?.nonGoals),
    "",
    "Steps:",
    "- Read every file changed on this branch (`git diff --stat` against the branch point, then the full diff).",
    card.taskRecordPath === undefined
      ? "- Re-run this project's focused verification for the changed files yourself; do not take the implementer's word for it."
      : "- Re-run the focused verification named in the task record.",
    "- Check acceptance criteria, scope drift, missing tests, and doc updates.",
    "- Fix trivial issues in place (typos, formatting, obvious one-liners) and say so.",
    "",
    REVIEW_PROTOCOL,
  ].join("\n");
}

// Agents pad, retry, and think out loud, so the LAST block is the live one.
const LAST_BLOCK = new RegExp("```" + RESULT_FENCE + "\\s*\\n([\\s\\S]*?)\\n?```", "g");

const lastResultBlock = (text: string): Option.Option<string> => {
  let last: Option.Option<string> = Option.none();
  for (const match of text.matchAll(LAST_BLOCK)) {
    if (match[1] !== undefined) last = Option.some(match[1]);
  }
  return last;
};

// `fromLenientJson` tolerates the trailing commas and comments models emit.
const decodeJson = Schema.decodeUnknownOption(fromLenientJson(Schema.Unknown));
const decodeWorker = Schema.decodeUnknownOption(AgentBoardWorkerResult);
const decodeReview = Schema.decodeUnknownOption(AgentBoardReviewResult);

/**
 * Models spell "no value" as `""` for the optional string fields, but every one
 * of them is a `TrimmedNonEmptyString`, so an empty string makes the WHOLE
 * block undecodable. The runner then reports "no result block", the agent
 * cannot see what is wrong, and the card re-prompts until `max_turns`.
 * `optionalKey` already means absent, so dropping the blank key is the same
 * statement in a shape the schema accepts.
 */
const withoutBlankFields = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => typeof entry !== "string" || entry.trim() !== ""),
  );
};

const parseBlock =
  <A>(decode: (input: unknown) => Option.Option<A>) =>
  (text: string): Option.Option<A> =>
    Option.flatMap(Option.flatMap(lastResultBlock(text), decodeJson), (json) =>
      decode(withoutBlankFields(json)),
    );

export const parseWorkerResult: (text: string) => Option.Option<AgentBoardWorkerResult> =
  parseBlock(decodeWorker);

export const parseReviewResult: (text: string) => Option.Option<AgentBoardReviewResult> =
  parseBlock(decodeReview);
