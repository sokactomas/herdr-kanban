---
name: kanban-team
description: Drive one task so it shows on the Herdr Kanban board — set the team.* labels for each phase, ask the person for approval through the board, write a plain-language summary and finish. Use when started as "/kanban-team <task>" or when asked to work on a task "on the kanban" inside Herdr. Accepts free text, an issue key or a link.
---

# kanban-team

You work on one task and keep the Herdr **Kanban** board up to date with labels on your own terminal. The board is
for a person who does not read terminals: they see a card move through To do → Analyzing → Working → Reviewing →
Waiting for you → Done, read your summary, answer your questions and press **Approve** or **Send back with a
comment**. The full contract is in `docs/label-contract.md` of the herdr-kanban repo; this file is all you need.

Labels only feed the board. They never replace doing the work, asking for permissions, or the person's own rules.

## 0. Are you inside Herdr?

Run `echo "$HC_TERMINAL_ID"`. If it is empty, you are not in a herdr-core terminal: do the task normally and skip
every `hc` command below. Otherwise `$HC_TERMINAL_ID` (e.g. `t12`) is **you**; never label or type into a terminal
you did not start, except your own.

Read your current labels: `hc get "$HC_TERMINAL_ID" --json` → `.labels`. When the board started you (its **+ New task**
button), `team=<key>`, `team.lead=1`, `team.goal` and `team.phase=intake` are already set; keep that key.

## 1. Take the task over

Pick a work folder for notes and handback files (outside the project, e.g. `${TMPDIR:-/tmp}/kanban-<key>`), then:

```sh
hc label "$HC_TERMINAL_ID" team=<key> team.lead=1 "team.goal=<one-line goal>" team.phase=intake "team.dir=<work folder>"
```

- `<key>`: keep the one you have. Without one, use the issue key in the task (`ABC-123` → `abc-123`) or a short
  slug (`[a-z0-9-]`, ≤ 32 chars). Renaming later is fine; the card follows you.
- `team.goal`: what will be true when you are done, ≤ 60 characters, in the person's language.
- Setting `team.dir` moves the card from To do to Analyzing.
- Quote any `key=value` with spaces. Labels are visible to local programs: no secrets, tokens or personal data.

## 2. Move through the phases

Set the phase when you **start** that kind of work, not after:

```sh
hc label "$HC_TERMINAL_ID" team.phase=plan       # Analyzing: reading code, reproducing, planning
hc label "$HC_TERMINAL_ID" team.phase=build      # Working: changing files, running things
hc label "$HC_TERMINAL_ID" team.phase=review     # Reviewing: tests, self-review, independent review
hc label "$HC_TERMINAL_ID" team.phase=integrate  # Reviewing: combining parts, final checks (optional)
```

Going back is fine (review found a bug → `build`). Skip phases that do not apply. Small tasks may go
`plan → build → review → done` in minutes; still set each one so the person sees progress.

## 3. Ask the person

The card goes to **Waiting for you** whenever you need the person. Two ways:

- **A question**: ask it in plain text and end your turn with the question as the **last line**, ending with `?`;
  then stop and wait. (The board only notices a plain-text question when your last screen line ends with `?`.) Or
  use your agent's question dialog; the board shows its options and presses the one the person picks.
- **An approval** (a plan, a risky step, the finished result): write the summary first, then flag it and stop:

  ```sh
  hc label "$HC_TERMINAL_ID" "team.summary=<what you did / propose, plain words>" team.approval=1
  ```

  The person's answer arrives as a normal message typed by the board:

  | Button | You receive (English board) | (Slovak board) |
  |---|---|---|
  | **Approve** | `Approved, go on.` | `Schválené, pokračuj.` |
  | **Send back with a comment** | `Sent back: <comment>` | `Vrátené: <comment>` |

  On a send-back, do what the comment asks (usually back to `build`), then ask for approval again. The board clears
  `team.approval` itself; if you resume for another reason, clear it: `hc label "$HC_TERMINAL_ID" team.approval=`.

Ask for approval before anything hard to undo or visible to others (pushing, merging, deploying, sending messages,
deleting data) unless the person's own instructions already allow it. Never treat silence or a timeout as approval.

## 4. Write for the person

`team.summary` is the most read text on the board. Rules:

- Plain language, 1–3 short sentences: what changed, what is left, what you need from them.
- No file paths, terminal addresses, model names or jargon the person did not use.
- Update it whenever it would otherwise be wrong (after each approval round and at the end).

Optional links (shown as buttons): `team.mr=<pull/merge request or diff URL>`, `team.preview=<URL to try it>`,
`team.ticket=<ticket key or URL>` (any tracker).

## 5. Helpers (optional)

If your agent and the task benefit from parallel work, start helpers as herdr-core children so they appear on the
card and in the technical view:

```sh
hc run --bg --name <key>-<role> --cwd "$PWD" \
  --label team=<key> --label role=<role> --label "team.task=<one-line task>" \
  <agent command> "<brief>"
```

- Role words the board knows: `researcher`, `planner`, `plan-reviewer`, `backend`, `frontend`, `developer`,
  `tester`, `design-qa`, `critic`, `security`, `bug-hunter`, `librarian`. Others work too.
- The brief: the task, the files it may change (no two writers on the same file), what "done" means, "do not start
  further agents", "write your result to `<work folder>/<role>.md` starting with a `Result: …` (or `Verdict: …` for
  reviewers) line, then report with `hc send $HC_TERMINAL_ID "<one line> — <path>"`". Expand `$HC_TERMINAL_ID`
  to your real address in the brief.
- Wait with `hc wait --children any` (never `sleep`/poll). A report arrives as your next input, tagged as coming from
  the helper; read the file it points to before acting.
- When its file exists: `hc label <name> team.out=<absolute path>`. New round: `hc label <name> "team.task=<new task>"`.
- End each helper once its result is read and nothing more is planned for it: `hc kill <name>; hc rm <name>`.
- A helper that is blocked on a permission is the person's decision; tell them, do not press keys for it.

## 6. Finish

```sh
hc label "$HC_TERMINAL_ID" "team.summary=<final plain-language summary>" "team.result=<≤60 chars outcome>" team.phase=done
```

Then give your final answer as usual. Set `done` only when the task is really finished (or the person stopped it);
if you stop early because you are blocked, ask (section 3) instead. If your terminal ends before `done`, the board
shows the card as **Interrupted**.

## Checklist

- [ ] `team.dir` set at the start (card leaves To do)
- [ ] `team.phase` set at the start of each kind of work
- [ ] approval asked with `team.summary` + `team.approval=1` before anything risky
- [ ] every helper has `team=`, `role=`, `team.task=` and is ended when done
- [ ] final `team.summary`, `team.result`, `team.phase=done`
