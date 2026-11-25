# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 — unreleased

First public version (beta).

- `mods/kanban`: a Herdr App mod with six columns (To do, Analyzing, Working, Reviewing, Waiting for you, Done),
  cards for runs labelled `team=<key>`, a detail panel with summary, links, the agent's question and progress, and
  the actions **+ New task**, **Approve**, **Send back with a comment** and **Answer**.
- **Technical details** view: members, roles, models, activity log, handback files, **Go →**.
- English and Slovak UI (one dictionary per language in `i18n/`).
- Settings in `mods/kanban/settings.json`, editable in the board's **Settings** panel: the language and the command
  that **+ New task** runs (`{task}`, `{key}`, `{project}`, `{folder}`), started as `env <words…>` so no shell is
  involved.
- Safety: text sent to terminals goes after `--`; links open only when they are http(s); a handback file is revealed
  in the file manager, never run.
- Repo follows Herdr's shared-mod layout: `mods/kanban/`, root `keys.json`, `RECIPE.md` and `preview.png`.
- Demo kit: `demo/start-demo.sh` / `demo/stop-demo.sh` put one DEMO card (`team.demo=1`) in every column.
- `skills/kanban-team`: a short, agent-agnostic skill that drives one task and sets the labels.
- `docs/label-contract.md`: the labels the board reads. New `team.ticket` label for a ticket link in any tracker
  (`team.jira` is still read as a deprecated alias).
