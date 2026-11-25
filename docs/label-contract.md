# Label contract

The Kanban mod draws its board **only** from labels on herdr-core terminals (`hc label`, `hc run --label`), plus each
terminal's status report and screen. Anything that sets these labels can drive the board: the bundled
[`kanban-team` skill](../skills/kanban-team/SKILL.md), your own skill, a shell script, or you by hand.

Labels only feed the overview. The board never changes what an agent does because of a label; it only types into a
terminal when you click **Approve**, **Send back with a comment** or **Answer**.

## Terms

- **Run**: one task handed to one agent (optionally with helpers). One run = one card.
- **Key**: the run's id, the value of `team=`. Lowercase, `[a-z0-9_-]`, e.g. `fix-login`, `abc-123`.
- **Lead**: the agent that owns the run (the coordinator). It carries `team.lead=1`.
- **Helper**: any other terminal labelled with the same `team=<key>` (a tester, a reviewer, a build script…).

## Labels

"Set by": **board** = the mod sets it when you start a task with **+ New task**; **agent** = the agent driving the run
(the `kanban-team` skill does all of these); **optional** = read if present.

| Label | On | Meaning | Set by | Without it |
|---|---|---|---|---|
| `team=<key>` | lead and helpers | the run's key; one card per key | board, agent | the terminal is not on the board |
| `team.lead=1` | lead | marks the lead | board, agent | a run without a lead goes to Done, marked Interrupted, once its helpers end |
| `team.goal=<text>` | lead | the card's title (short, one line) | board, agent | the first line of the task text, else "Untitled task" |
| `team.phase=<phase>` | lead (helpers optional) | the column, see [Phases](#phases) | board (`intake`), agent | `intake` |
| `team.dir=<path>` | lead | the run's work folder; its presence means the agent has taken the task over (the card leaves To do) | agent | the card stays in To do until a helper starts or the phase moves |
| `role=<role>` | helpers | what the helper does, see [Roles](#roles) | agent | the terminal name after its first `-` |
| `team.task=<text>` | helpers | the helper's current task, shown in the card's line and **What is happening now** | agent | the role word only |
| `team.model`, `team.effort` | helpers | shown in **Technical details** only | optional | omitted |
| `team.out=<file>` | lead, helpers | a local handback file; its `Result:` / `Verdict:` line is shown as the result | optional | — |
| `team.result=<text>` | lead, helpers | a short result line | optional | the `team.out` file's result line |
| `team.summary=<text>` | lead | plain-language summary for the person (**Summary** in the detail) | agent | `team.result`, then the `team.out` line, then the lead's last screen line |
| `team.approval=1` | any | the run waits on the person's decision (card goes to **Waiting for you**); the board clears it on **Approve** / **Send back with a comment** | agent | — |
| `team.preview=<url>` | lead | `Preview ↗` link | optional | no link |
| `team.mr=<url>` | lead, helpers | `Code changes ↗` link (pull/merge request, commit, diff); the first one found wins | optional | no link |
| `team.ticket=<key or url>` | lead | the ticket link, shown by its key (`ABC-123 ↗`) or else the URL's host; a bare key is shown as text. Any tracker | optional | the first URL in the task text |
| `team.jira=<key or url>` | lead | **deprecated** alias of `team.ticket`, still read (`team.ticket` wins); don't use it in new code | optional | — |
| `team.shipped=1` | helpers | technical view: the helper delivered its part | optional | implementation roles that handed back |
| `team.demo=1` | any | demo data: the card title gets a `DEMO · ` prefix and the card is dropped once its terminals are gone. A key starting with `kanban-demo-` counts too | demo scripts | — |

Label text (`team.goal`, `team.task`, `team.result`, `team.summary`) is shown **as written**. Keep it short
(goal and task ≤ 60 characters), in the language the person reads, with no secrets: labels are visible to every
program that can talk to herdr-core on this machine.

## Phases

`team.phase` on the lead picks the column:

| Phase | Column | Meaning |
|---|---|---|
| `intake` | To do (until `team.dir` is set), then Analyzing | reading the task |
| `plan` | Analyzing | investigating, planning |
| `build` | Working | changing things |
| `review` | Reviewing | checking the work |
| `integrate` | Reviewing | merging the pieces, final checks |
| `done` | Done | finished; the run's terminals may stay or go |

## Columns

A card's column is computed, in this order:

1. **Waiting for you** wins over the phase while the run is running and something waits on the person: a live
   terminal of the run reports status `blocked` (a question, a permission or trust dialog, an error), any terminal of
   the run has `team.approval=1`, or the lead stopped (idle) and its last screen line ends with `?` (it asked in
   plain text). An agent that asks in plain text should therefore end its turn with the question as the last line.
2. **Done**: the lead's phase is `done`, or the run ended. A run that ended before `done` (the lead's terminal went,
   or there never was a lead) is in **Done**, marked **Interrupted**.
3. **To do**: started from the board and no lead terminal yet, or a lead with phase `intake`, no `team.dir` and no
   helpers.
4. Otherwise by the lead's phase (table above).

## Roles

The `role` label tells the board where a helper belongs in **Technical details** and which plain word to show. Known
words (others are shown as written and counted as `build`):

| Phase | Roles |
|---|---|
| intake | `researcher` |
| plan | `planner`, `plan-reviewer` |
| build | `backend`, `frontend`, `fullstack`, `developer`, `implementer`, `fixer`, `tester`, `design-qa` |
| review | `critic`, `security`, `security-reviewer`, `bug-hunter` |
| integrate | `librarian` |

## Handback files

When `team.out` names a file, the board reads it and shows one line: the first line that starts with `Result:`,
`Verdict:`, `Conclusion:`, `Summary:` or `TL;DR` (case-insensitive, optional `**`; the Slovak `Výsledok:`,
`Verdikt:`, `Záver:`, `Zhrnutie:` are read too), else the first line of prose. Prefer the English key; the rest of
the line can be in any language.

## Keys and renames

- **+ New task** creates the key from a ticket key found in the text (`ABC-123` → `abc-123`), else `task-` and four
  random characters (`task-k3f9`); a key already in use gets `-2`, `-3`. It starts the lead with
  `hc run --bg --no-parent --name <key>-lead --cwd <project folder> --label team=<key> --label team.lead=1
  --label "team.goal=<first line of the task, ≤ 60 chars>" --label team.phase=intake -- <your command>`, and passes
  the key to the command as `{key}`.
- Keeping the given key is simplest.
- The lead may still relabel itself `team=<another key>` (e.g. once it learns the ticket key): the card follows the lead
  terminal to the new key, history included.
- A new run on a key a finished run used moves the old card to `<key>~2`.

## What the board sends

| Button | Sends to | What |
|---|---|---|
| **Approve** | the lead | `Approved, go on.` (Slovak board: `Schválené, pokračuj.`), then clears `team.approval` on the run's terminals |
| **Send back with a comment** | the lead | `Sent back: <comment>` (Slovak board: `Vrátené: <comment>`), then clears `team.approval` |
| **Answer** (option) | the asking terminal | re-reads its screen; if the same option is still there, presses its digit (`hc keys <t> 2`) or arrows + Enter for an unnumbered list |
| **Answer** (text) | the asking terminal | `hc send <t> <text>` (into the dialog's free-text option when it has one) |

Every action is shown as a toast and logged in the card's activity.

## Other inputs

- **Status report** (OSC 7501, what Claude Code and other agents send to Herdr): `working`, `idle`, `blocked` (+ its
  message as the question), `done`, `error`.
- **Screen** (`hc read --lines 80` once per status change and at most once a minute for the open card; `--lines 60`
  again right before **Answer** presses an option): question dialogs and their options, the lead's last message.
- **Spaces**: the project list in **New task** is the working folder of each Herdr space.
