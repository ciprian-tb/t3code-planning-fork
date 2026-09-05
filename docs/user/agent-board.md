# The agent board

Planning is a per-project board for work you want agents to do. You write cards, decide which ones
are ready, and turn on a runner that picks them up, works each one in its own git worktree, has a
second agent review the result, and hands it back to you.

Planning is available on web and desktop. The mobile app connects and chats as usual, but has no
Planning view.

## Open Planning

Two ways in:

- In the sidebar, open the project picker at the top and select the board icon on a project's row.
- Open the command palette (`Cmd/Ctrl + K`) and choose **Open planning**.

Planning opens full-screen for that one project. **Back to chat** in its header returns you where
you came from.

## The three views

The same cards, three ways. Switch with the buttons at the top left.

- **Kanban** is the control view. Drag a card between columns to change its state.
- **Planning table** lists every card, including the ones Kanban has no column for, and lets you
  edit priority, area, and slice inline.
- **Dependency tree** shows the execution order the board's dependencies imply. It is generated
  from the cards; you do not draw it.

Select the pencil on a card to open its detail dialog: intent, acceptance criteria, constraints,
non-goals, open decisions, dependencies, and the parallelism plan.

## Card states

A card carries one state, and the state is what decides whether an agent may touch it.

- **Backlog** — captured, not eligible for pickup.
- **Draft** — rough work that still needs clarifying.
- **Ready** — eligible for an agent. This is the only state the runner starts work from, and moving
  a card here is the deliberate "start this" signal. A card needs an intent brief before it can be
  saved as Ready; a title on its own is not enough.
- **Running** — an implementation turn is in flight.
- **Diagnosing** — waiting out a retry, or repairing what the review asked for.
- **Reviewing** — a fresh reviewer is checking the work.
- **Review** — finished and waiting for you. This is where cards normally land.
- **Done** — accepted.
- **Blocked** — something outside the card is in the way, and the agent said so.
- **Needs Decision** — waiting on an answer from you. The card carries the question.
- **Canceled** — stopped on purpose.

Kanban has columns for Draft, Ready, Running, Diagnosing, Reviewing, Review, Done, and Needs
Decision. Cards in Backlog, Blocked, or Canceled are still there — find them in the Planning table.

## The runner

The **Runner** switch in the Planning header turns the board runner on for the project you are
looking at. It is off by default, it is per project rather than global, and it stays as you left it
across restarts. Next to it is a one-line readout: where the workflow settings came from, how many
cards are active right now, and how long ago the runner last looked at the board.

While it is on, the runner:

- picks up Ready cards whose dependencies are all Done, in priority order, normally one at a time;
- creates a separate git worktree for each card, so agents never work in your project folder;
- opens an implementation thread you can watch in Chat like any other;
- retries routine failures itself, backing off a little further each time;
- opens a second, fresh thread to review the finished work, with none of the implementation
  conversation behind it;
- sends the card back for repairs if the review asks for changes;
- moves the card to Review when the review passes, and stops there — it does not merge anything;
- stops at Needs Decision with a specific question when it hits something you should decide.

Answer a Needs Decision card from its dialog. Your answer is kept as a constraint on the card's
brief, so the next agent turn carries it, and the card goes back to Ready.

The project needs a default model selected before the runner can run anything. Without one, cards
park at Needs Decision and ask you to set it.

## Running a card yourself

Ready cards also have a **Run** button. It does the same setup by hand: it reserves the card's
worktree, opens a thread there, and loads the card's prompt into the composer. Nothing is sent until
you send it.

The difference is who owns the card afterwards. A card you ran by hand is yours: the runner will not
adopt it, continue it, or stop it, and you move it to Review or Done yourself. A card the runner
claimed is the runner's until it hands it back.

The two never share a card. While the runner is on, running a card by hand is refused — turn the
runner off first.

## Break

**Break** in the Planning header is the stop button. One press stops the runner for the project you
are looking at, closes Planning, and returns you to chat. Planning stays shut in this browser until
you release it, including across reloads. While it is pulled, the command palette entry reads
**Re-enable planning** and is how you release it.

Releasing Break reopens Planning. It deliberately does not start the runner again — that is a
separate decision you make with the **Runner** switch.

Break is per browser, and the runner is per project. If you have runners on in more than one
project, Break stops the one whose Planning you are on; stop the others from their own headers.

## The files behind it

Everything Planning shows lives in your project, in plain files you can read, edit, and commit.

- **`.t3/agent-board.json`** holds the board: every card, its state, and the runner's live progress
  on it. Planning creates the file the first time you open it. The header shows its path.
- **`WORKFLOW.md`** in the project root is optional, and configures the runner: how often to look at
  the board, how many cards at once, how many turns and repair attempts to allow, whether to run a
  review, and whether an approved card lands in Review or Done. Without it, sensible defaults apply.

`WORKFLOW.md` is re-read continuously, so a change takes effect without a restart. If you break it,
the runner keeps using the last version that worked, tells you so in the header readout, and carries
on with the card it is on.
