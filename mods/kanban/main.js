// Kanban: a board of tasks handed to teams of coding agents, for people who don't read terminals. A card is one
// task = one team run (`team=<key>` on its terminals); it moves through six columns: To do → Analyzing → Working →
// Reviewing → Waiting for you → Done. "New task" starts a coordinator agent with the configured command; a card waiting
// on the person opens a detail with the team's summary, the agent's question and Approve / Send back / Answer.
// "Technical details" (off by default) shows the members, roles, models, effort, activity log and handback files.
// Data comes only from herdr-core labels (docs/label-contract.md):
//   lead:    team=<key> team.lead=1 team.goal=<text> team.phase=<intake|plan|build|review|integrate|done> team.dir=<path>
//            optional: team.summary team.result team.out team.preview team.ticket team.mr team.approval=1 team.demo=1
//   helpers: team=<key> role=<role> team.task team.model team.effort team.out team.result team.mr team.approval team.shipped
// Column of a task: anyone waiting on the person (a blocked member or lead, team.approval=1, or the lead's last
// message is a question) → Waiting for you (wins over the phase); the lead's phase done, or the run ended → Done
// (ended before done: "Interrupted"); a run without helpers whose lead hasn't taken it over yet (no team.dir) → To do;
// else by the lead's phase: intake/plan → Analyzing, build → Working, review/integrate → Reviewing.
// Settings: mods/<MOD>/settings.json ({ "locale": "en" | "sk", "command": "…" }), edited in the board's Settings panel.
// props: { open: "<team key>" } opens that task; { member: "<address>" } opens its task in the technical view with
// that member's detail; { forget: ["<team key>"] } drops those runs.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import {
  terminals, agents, spaces, panes, run, exec, hc, home, appHome, readTextFile, writeTextFile, theme, settings, shared, setShared,
  notify, props, checking, window as win,
} from "herdr";
import EN from "./i18n/en.js";
import SK from "./i18n/sk.js";

// Languages: one dictionary file each in i18n/. Unknown codes fall back to English.
const LOCALES = { en: EN, sk: SK };
let T = EN;
const setLocale = (code) => { T = LOCALES[String(code ?? "").toLowerCase().slice(0, 2)] ?? EN; };

// Settings, in a file beside the mod (not shipped, so copying a new version of the mod over keeps it).
// The mod's folder name. Herdr doesn't tell a mod its own folder (import.meta is empty), so installing it under
// another name means changing this one line: it names the settings file and every stored key.
const MOD = "kanban";
const SETTINGS = `mods/${MOD}/settings.json`;
const DEFAULT_COMMAND = 'claude "/kanban-team {task}"';
const settingsPath = () => `${appHome().replace(/[\\/]+$/, "")}/${SETTINGS}`;
function parseSettings(text) {
  let v = {};
  try { v = text ? JSON.parse(text) : {}; } catch { v = {}; }
  const command = Array.isArray(v.command) ? v.command.map(String) : typeof v.command === "string" && v.command.trim() ? v.command.trim() : DEFAULT_COMMAND;
  return { locale: typeof v.locale === "string" ? v.locale : "en", command };
}
// A command template → argv: split like a shell (spaces; "double" and 'single' quotes; \ escapes outside single
// quotes), then fill {task} {key} {project} {folder} inside each word. Nothing goes through a shell, so the task text
// is one argument whatever it contains.
function splitCommand(cmd) {
  if (Array.isArray(cmd)) return cmd.slice();
  const out = [];
  let cur = null, q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (c === "\\" && i + 1 < cmd.length) { cur = (cur ?? "") + cmd[++i]; continue; }
    if (q === '"') { if (c === '"') q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; if (cur === null) cur = ""; continue; }
    if (/\s/.test(c)) { if (cur !== null) { out.push(cur); cur = null; } continue; }
    cur = (cur ?? "") + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}
const fillCommand = (cmd, vars) => splitCommand(cmd).map((w) => w.replace(/\{(task|key|project|folder)\}/g, (_m, k) => vars[k] ?? ""));

// Links (preview, code changes, ticket) open only as http(s) URLs, in the browser (cx.open_url). A handback file is
// never opened or run: if it exists as a readable file it is shown in the file manager (macOS Finder `open -R`,
// Windows `explorer.exe /select,`, Linux its folder with xdg-open). No shell is involved.
const isWeb = (u) => /^https?:\/\/\S+$/i.test(String(u ?? ""));
function openWeb(url, cx) { if (isWeb(url)) cx.open_url(url); }
async function revealFile(path) {
  const p = String(path ?? "");
  if (!p || (await readTextFile(p).catch(() => null)) === null) return; // missing, unreadable or not a file
  const os = win()?.platform;
  const dir = p.replace(/[\\/][^\\/]*$/, "") || "/";
  await (os === "macos" ? exec("open", ["-R", p]) : os === "windows" ? exec("explorer.exe", [`/select,${p}`]) : exec("xdg-open", [dir])).catch(() => null);
}

// ---- the kanban's columns ----
const COLS = ["queued", "analyze", "work", "check", "waiting", "done"].map((id) => ({ id }));
const COL_AT = Object.fromEntries(COLS.map((c, i) => [c.id, i]));
const PHASE_COL = { intake: "analyze", plan: "analyze", build: "work", review: "check", integrate: "check" };
const KCOL_MIN = 168; // columns share the width; below this the board scrolls sideways (all six fit from ~1170 px)
const KCOL_GAP = 12;
const DONE_RECENT = 7 * 24 * 3600000; // Done shows the last 7 days; "Show older" the rest
const START_GRACE = 120000; // a task started from the panel whose coordinator never showed up is over after this

// ---- the technical view's steps ----
const PHASES = ["intake", "plan", "build", "review", "integrate"];
const STEPS = ["intake", "plan", "build", "review", "approve", "integrate", "shipped"].map((id) => ({ id }));
const STEP_AT = { intake: 0, plan: 1, build: 2, review: 3, integrate: 5, done: STEPS.length }; // lead phase → step
const MIN_COL = 160;
const COL_GAP = 12;
const SIDE_W = 380;
const ROLE_PHASE = {
  researcher: "intake", "plan-reviewer": "plan", planner: "plan", backend: "build", frontend: "build",
  tester: "build", "design-qa": "build", implementer: "build", critic: "review", security: "review",
  "security-reviewer": "review", "bug-hunter": "review", librarian: "integrate", fixer: "build", fullstack: "build", developer: "build",
};
const IMPL_ROLES = new Set(["backend", "frontend", "implementer", "fixer", "fullstack", "developer"]);
const URGENCY = { blocked: 0, working: 1, idle: 2, done: 3 };
const KEY = `${MOD}.state`;
const MAX_EVENTS = 60;
const MAX_TEAMS = 40; // running ones plus the most recent finished ones
const FORGET_MS = 30 * 24 * 3600000; // a finished run is forgotten a month after its last activity

const now = () => Date.now();
const pad = (n) => String(n).padStart(2, "0");
const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// a span of time in minutes: "<1 min", "11 min", "2 h 5 min", "3 d"
function span(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(m / 1440)} d`;
}
const ago = (ms) => (ms ? span(now() - ms) : "");
const rel = (ms) => (now() - ms < 60000 ? T.justNow : T.ago(span(now() - ms)));
// "today 16:17", "yesterday 16:17", "Nov 21 16:17" (in the board's language)
function when(ms) {
  const d = new Date(ms), t = new Date(), day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(t) - day(d)) / 86400000);
  return `${diff === 0 ? T.today : diff === 1 ? T.yesterday : T.date(d)} ${clock(ms)}`;
}
const clean = (s) => String(s ?? "").replace(/^[\s✳✻✽✶·⠀-⣿*]+/u, "").trim();
const roleOf = (name, labels) => (labels?.role ?? String(name ?? "").replace(/^[a-z0-9]+-/, "")).toLowerCase();
const phaseOf = (m) => (PHASES.includes(m.phase) ? m.phase : ROLE_PHASE[m.role] ?? "build");
const base = (p) => String(p ?? "").replace(/\/+$/, "").split("/").pop();
const stateOf = (s) => { const v = typeof s === "string" ? s : s?.state ?? null; return v === "error" ? "blocked" : v; };
// what a blocked program asks (its OSC 7501 msg), without its leading "answer:" / "permission:" word and the
// "(A · B · C)" list of options Claude Code appends
const askOf = (s) => {
  const v = typeof s === "object" && s ? s.msg : null;
  return v ? String(v).replace(/^(answer|permission|question|auth)\s*:\s*/i, "").replace(/\s*\([^()]*·[^()]*\)\s*$/, "").trim() || null : null;
};
// Claude Code's own asks in the person's words
const askWords = (ask) => (ask && /^trust this folder$/i.test(ask) ? T.trustAsk : ask);
const urlIn = (s) => String(s ?? "").match(/https?:\/\/\S+/)?.[0] ?? null;
const machineOf = (address) => (String(address ?? "").includes("/") ? String(address).split("/")[0] : null);
// plain words for the default view: no file paths, terminal addresses or markdown
const plain = (s, max = 90) => {
  const v = String(s ?? "").replace(/`/g, "").replace(/(?:~|\.{0,2})?\/?[\w.@-]+(?:\/[\w.@-]+)+\/?/g, "…").replace(/\bt\d+[a-z0-9]*\b/g, "")
    .replace(/(?:…\s*){2,}/g, "… ").replace(/\s{2,}/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
};
// a card's title: the goal (DEMO-marked for demo runs)
// a demo run: labelled team.demo=1, or keyed kanban-demo-… (the recipe's demo convention)
const isDemo = (team) => Boolean(team.demo) || /^kanban-demo-/.test(team.key ?? "");
const titleOf = (team, max) => `${isDemo(team) ? T.demo : ""}${firstLine(team.lead?.goal || team.goal || team.task, max) || T.noGoal}`;
const firstLine = (s, max = 60) => { const l = String(s ?? "").split("\n").map((x) => x.trim()).find(Boolean) ?? ""; return l.length > max ? `${l.slice(0, max - 1)}…` : l; };

// The last line of a terminal's screen worth showing: Claude Code's frame (rules, prompt, status line,
// spinner, tips, key hints) and shell chatter are skipped.
const NOISE = [/ctx:\s*\d/, /⏵⏵/, /shift\+tab/, /esc to /i, /ctrl\+[a-z]/i, /\? for shortcuts/, /turn off /i, /claude --resume/,
  /Resume this session/, /^zsh: /, /^\d+: /, /^… \+\d+ lines/, /Referenced file /, /SessionStart/, /Compacted /, /Heads up/,
  /^\[hc\]/, /\(\d+m?\s?\d*s · /, /tokens\)$/, /auto mode/, /accept edits/, /bypass permissions/, /Update installed/,
  /hook was skipped/, /^[✻✳✶✽✢·*]\s*\S+ for \d/u, /Enter to (select|confirm)/, /to navigate/];
function lastLine(text) {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (raw.length < 4 || /^[─━═│┃╭╮╰╯┌┐└┘\-_=\s|❯>$%#]*$/u.test(raw) || NOISE.some((r) => r.test(raw))) continue;
    if (/^[❯>]\s/.test(raw) || /^[✳✻✽✶✢✦·*]\s*\S+…/u.test(raw)) continue;
    const s = raw.replace(/^[⏺●⎿✻✳•◦▸▹·\s]+/u, "").trim();
    if (s.length >= 3) return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  }
  return null;
}
// One line from a handback file: its verdict / result / summary line, else its first line of prose.
function gist(md) {
  const lines = String(md ?? "").split("\n").map((l) => l.trim());
  const strip = (l) => l.replace(/^[#>*\-+\s]+/, "").replace(/\*\*|__|`/g, "").trim();
  const key = /^(\*\*)?\s*(verdikt|verdict|výsledok|result|záver|conclusion|summary|zhrnutie|tl;dr)\b/i;
  const i = lines.findIndex((l) => key.test(strip(l)));
  if (i >= 0) {
    const own = strip(lines[i]).replace(key, "").replace(/^[\s:–—-]+/, "");
    const next = own || strip(lines.slice(i + 1).find((l) => strip(l)) ?? "");
    if (next) return next.length > 200 ? `${next.slice(0, 200)}…` : next;
  }
  const first = lines.find((l) => l && !l.startsWith("#") && !/^(-{3,}|\|)/.test(l) && strip(l).length > 3);
  if (!first) return null;
  const s = strip(first);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// A choice dialog on a blocked agent's screen (Claude Code's question, permission or trust dialog): its options
// in order, whether they are numbered (a digit key picks one) or not (arrow keys from the cursor, then Enter),
// the free-text option ("Type something."), and the line above the options as the question.
function parseDialog(raw) {
  const lines = String(raw ?? "").split("\n");
  let end = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) if (/Esc to cancel|Enter to (select|confirm)|to navigate/.test(lines[i])) { end = i; break; }
  // no key hint (some permission prompts): only a numbered list at the bottom with the ❯ cursor on it counts
  const hinted = end >= 0;
  if (!hinted) { end = lines.length; while (end > 0 && !lines[end - 1].trim()) end--; }
  const from = Math.max(0, end - 50), win = lines.slice(from, end);
  const rule = (l) => /^[\s─━═│┃╭╮╰╯┌┐└┘-]*$/u.test(l);
  const numbered = [];
  win.forEach((l, i) => { const x = l.match(/^\s*(❯\s*)?(\d{1,2})[.)]\s+(.*\S)\s*$/u); if (x) numbered.push({ n: Number(x[2]), label: x[3], cursor: Boolean(x[1]), at: i }); });
  let opts = [];
  const one = numbered.map((o) => o.n).lastIndexOf(1);
  if (one >= 0) for (let i = one, n = 1; i < numbered.length && numbered[i].n === n; i++, n++) opts.push(numbered[i]);
  const isNumbered = opts.length >= 2 && (hinted || (opts.some((o) => o.cursor) && opts[opts.length - 1].at >= win.length - 4));
  if (!isNumbered && !hinted) return null;
  if (!isNumbered) {
    const c = win.findIndex((l) => /^\s*❯\s+\S/u.test(l));
    if (c < 0) return null;
    const item = (l) => !rule(l) && /^\s{1,4}(❯\s+)?\S/u.test(l) && !/Esc to cancel|Enter to/.test(l);
    let a = c, b = c;
    while (a - 1 >= 0 && item(win[a - 1]) && /^\s{2,4}\S/.test(win[a - 1])) a--;
    while (b + 1 < win.length && item(win[b + 1])) b++;
    opts = win.slice(a, b + 1).map((l, k) => ({ n: k + 1, label: l.replace(/^\s*❯?\s*/u, "").trim(), cursor: /^\s*❯/u.test(l), at: a + k }));
    if (opts.length < 2) return null;
  }
  // a numbered option's description: the deeper-indented line under it
  for (const o of opts) { const d = win[o.at + 1]; if (isNumbered && d && /^\s{4,}\S/.test(d) && !/^\s*(❯\s*)?\d{1,2}[.)]\s/u.test(d)) o.desc = d.trim(); }
  let q = null;
  for (let i = opts[0].at - 1; i >= 0; i--) { const l = win[i].trim(); if (!l || rule(win[i])) continue; q = l.replace(/^[☐☒✔◻■□]\s*/u, ""); break; }
  const typeOpt = opts.find((o) => /^type something/i.test(o.label)) ?? null;
  const choices = opts.filter((o) => o !== typeOpt && !/^chat about this/i.test(o.label));
  return { numbered: isNumbered, options: opts, choices, typeOpt, question: q, cursor: Math.max(0, opts.findIndex((o) => o.cursor)) };
}
// the keys that pick an option: its digit, or arrows from the cursor then Enter
function keysFor(d, opt) {
  if (d.numbered && opt.n <= 9) return [String(opt.n)];
  const i = d.options.indexOf(opt), c = d.cursor;
  return [...Array(Math.abs(i - c)).fill(i > c ? "down" : "up"), "enter"];
}

function go(address, hasPane) {
  if (hasPane) {
    const a = agents().find((x) => x.address === address);
    const s = a && spaces().find((x) => x.id === a.space);
    if (s && !s.active) run("space.select", { id: s.id });
    run("agent.focus", { terminal: address });
  } else run("terminal.peek", { terminal: address });
}

const liveMembers = (team) => Object.values(team.members).filter((m) => m.status !== "ended");
// running: while the lead's terminal lives on an unfinished run (even waiting on the person), or a member is
// alive, or a task started from the panel is still waiting for its coordinator. Otherwise it's over: done (the
// lead reached phase done), stopped (the lead's terminal ended before that) or ended (no lead to tell).
function runState(team) {
  const l = team.lead;
  if (liveMembers(team).length || (l?.live && l.phase !== "done")) return "running";
  if (!l && team.pending && !team.failed && now() - team.started < START_GRACE) return "running";
  return !l ? "ended" : l.phase === "done" ? "done" : "stopped";
}
const leadMember = (team) => team.lead && ({ ...team.lead, name: team.lead.address, role: "lead", task: team.lead.goal, lead: true });
const awaits = (m) => Boolean(m) && m.status !== "ended" && (!m.lead || m.live) && (m.status === "blocked" || Boolean(m.approval));
const handedBack = (team, m) => !m.lead && (m.phase === "done" || team.lead?.phase === "done"
  || (m.status === "ended" && Boolean(m.out || m.result)));
const isShipped = (team, m) => !m.lead && (Boolean(m.shipped) || (IMPL_ROLES.has(m.role) && handedBack(team, m)));
const colOf = (team, m) => (awaits(m) ? "approve" : isShipped(team, m) ? "shipped" : phaseOf(m));
const superseded = (team, m) => m.status === "ended" && Object.values(team.members).some((x) => x !== m && x.status !== "ended" && x.name === m.name);
const boardMembers = (team) => { const l = leadMember(team); return [...Object.values(team.members).filter((m) => !superseded(team, m)), ...(awaits(l) ? [l] : [])]; };
const diffstat = (s) => { const x = String(s ?? "").match(/\+(\d+)\s*\/?\s*[−–-](\d+)/); return x ? [x[1], x[2]] : null; };
const lastAt = (team) => Math.max(team.started ?? 0, team.events[0]?.at ?? 0, ...Object.values(team.members).map((m) => m.since ?? 0));
const eventsOf = (team, m) => team.events.filter((e) => (e.who ? e.who === m.address : m.lead && e.kind === "phase"));
const whoIn = (team, address) => team.members[address] ?? (team.lead?.address === address ? leadMember(team) : null);

// What a task waits on the person for: blocked members (the lead included), approvals (team.approval=1), and the
// lead's last message when it ends with a question (it stopped and asks in plain text).
function waitsOn(team) {
  const out = [];
  const l = team.lead?.live ? leadMember(team) : null;
  if (l?.status === "blocked") out.push({ m: l, kind: "blocked" });
  else if (l?.approval) out.push({ m: l, kind: "approval" });
  else if (l && team.asking?.address === l.address && l.status !== "working") out.push({ m: l, kind: "asking", text: team.asking.text });
  for (const m of liveMembers(team)) if (m.status === "blocked") out.push({ m, kind: "blocked" }); else if (m.approval) out.push({ m, kind: "approval" });
  return out;
}
// a task the coordinator hasn't taken over yet: started from the panel (no terminal yet), or a lead with no task
// folder (team.dir) and no helpers, still at intake
const isQueued = (team) => (team.pending && !team.lead) || (Boolean(team.lead) && !team.lead.dir && !Object.keys(team.members).length && (team.lead.phase ?? "intake") === "intake");
const phaseColOf = (team) => (team.lead?.phase === "done" || runState(team) !== "running" ? "done" : isQueued(team) ? "queued" : PHASE_COL[team.lead?.phase] ?? "work");
const columnOf = (team) => (runState(team) === "running" && waitsOn(team).length ? "waiting" : phaseColOf(team));
const isInterrupted = (team) => runState(team) !== "running" && team.lead?.phase !== "done";

function mutate(fn) {
  const st = JSON.parse(JSON.stringify(shared(KEY) ?? { teams: {} }));
  st.teams ??= {};
  if (fn(st) !== false) setShared(KEY, st);
}
// an activity entry: { at, kind, who, d } where d is its data; the text is made when shown (evText), in the
// language of the moment
function pushEvent(team, kind, d, who) {
  team.events.unshift({ at: now(), kind, d, who });
  team.events.length = Math.min(team.events.length, MAX_EVENTS);
}
// the person's own actions go to the task's activity (kind "action")
const logAction = (key, d) => mutate((st) => { const team = st.teams[key]; if (!team) return false; pushEvent(team, "action", d, null); });
function evText(e) {
  const d = e.d ?? {};
  switch (e.kind) {
    case "phase": return d.phase === "done" ? T.ev.finished : T.ev.phase(T.phases[d.phase] ?? d.phase);
    case "leadBlocked": return T.ev.leadNeedsYou(d.doing);
    case "leadApproval": return T.ev.leadApproval;
    case "approval": return T.ev.approval(d.name);
    case "start": return T.ev.joined(d.name, d.what);
    case "shipped": return T.ev.shipped(d.name, d.result);
    case "col": return T.moved(T.col[d.col] ?? d.col);
    case "action": { const f = T.act[d.a]; return typeof f === "function" ? f(d.arg) : f ?? ""; }
    case "output": return d.text ?? "";
    default: return T.ev.status(d.name, T.word[e.kind] ?? e.kind, d.doing);
  }
}
const NEEDS_KINDS = new Set(["blocked", "leadBlocked", "leadApproval", "approval"]);

function forget(keys) {
  mutate((st) => {
    st.forgotten ??= {};
    for (const k of keys) {
      const team = st.teams[k];
      if (!team) continue;
      st.forgotten[k] = { phase: team.lead?.phase ?? null, addrs: [...Object.keys(team.members), ...(team.lead ? [team.lead.address] : [])] };
      delete st.teams[k];
    }
  });
}

function recordOutput(teamKey, address, text) {
  mutate((st) => {
    const team = st.teams?.[teamKey];
    if (!team || team.events.find((e) => e.who === address && e.kind === "output")?.d?.text === text) return false;
    pushEvent(team, "output", { text }, address);
  });
}
// the lead stopped and its last line is a question: the task waits on the person until the lead works again or
// its last line is no longer a question (text null)
function recordAsking(teamKey, address, text) {
  mutate((st) => {
    const team = st.teams?.[teamKey];
    if (!team) return false;
    if (!text) { if (!team.asking) return false; team.asking = null; return; }
    if (team.asking?.address === address && team.asking?.text === text) return false;
    team.asking = { address, text, at: now() };
  });
}

// Merge the live terminals into the remembered state.
function sync() {
  const st = JSON.parse(JSON.stringify(shared(KEY) ?? { teams: {} }));
  st.teams ??= {};
  st.forgotten ??= {};
  const live = terminals(), ags = new Map(agents().map((a) => [a.address, a]));
  let changed = false;
  const ev = (team, kind, d, who) => { pushEvent(team, kind, d, who); changed = true; };
  const seen = new Set(), carried = new Set();
  for (const t of live) {
    const key = t.labels?.team;
    if (!key) continue;
    carried.add(key);
    const isLead = t.labels["team.lead"] === "1";
    const tomb = st.forgotten[key];
    if (tomb) {
      if (tomb.addrs.includes(t.address) && (!isLead || (t.labels["team.phase"] ?? "intake") === tomb.phase)) continue;
      delete st.forgotten[key]; changed = true;
    }
    if (isLead) {
      // the coordinator renamed its run (`hc label … team=<task-key>`): its card follows it to the new key
      for (const [k, other] of Object.entries(st.teams)) {
        if (k === key || !(other.lead?.address === t.address || (!other.lead && (other.leadAddr === t.address || (other.leadName && other.leadName === t.name))))) continue;
        const into = st.teams[key];
        if (!into) st.teams[key] = { ...other, key };
        else {
          into.started = Math.min(into.started ?? now(), other.started ?? now());
          into.events = [...into.events, ...other.events].sort((x, y) => y.at - x.at).slice(0, MAX_EVENTS);
          into.members = { ...other.members, ...into.members };
          for (const f of ["task", "projectName", "folder", "machine", "origin", "colSince", "colAt", "col"]) into[f] ??= other[f];
        }
        delete st.teams[k]; changed = true;
      }
      // a new coordinator on a key a finished run used: the old run keeps its card under another key
      const old = st.teams[key];
      if (old && old.lead && old.lead.address !== t.address && !old.lead.live && runState(old) !== "running") {
        let n = 2; while (st.teams[`${key}~${n}`]) n++;
        st.teams[`${key}~${n}`] = { ...old, key: `${key}~${n}`, archivedFrom: key };
        delete st.teams[key]; changed = true;
      }
    }
    const team = st.teams[key] ??= { key, started: now(), members: {}, events: [], lead: null };
    // a demo run (any of its terminals labelled team.demo=1): marked DEMO, and dropped once it ends
    if (t.labels["team.demo"] === "1" && !team.demo) { team.demo = true; changed = true; }
    const a = ags.get(t.address);
    if (isLead) {
      const prev = team.lead;
      const status = a?.status ?? stateOf(t.status) ?? "idle";
      const L = t.labels;
      const lead = {
        address: t.address, goal: L["team.goal"] ?? "", phase: L["team.phase"] ?? "intake", dir: L["team.dir"] ?? null,
        live: true, status, doing: clean(a?.title ?? t.title), pane: Boolean(a?.pane), approval: L["team.approval"] === "1", ask: askOf(t.report ?? t.status),
        summary: L["team.summary"] ?? null, result: L["team.result"] ?? null, out: L["team.out"] ?? null,
        preview: L["team.preview"] ?? null, ticket: L["team.ticket"] ?? null, jira: L["team.jira"] ?? null, mr: L["team.mr"] ?? null,
        since: prev && prev.status === status ? prev.since ?? now() : now(),
      };
      if (prev?.phase && prev.phase !== lead.phase) ev(team, "phase", { phase: lead.phase }, t.address);
      if (status === "blocked" && prev?.status !== "blocked") ev(team, "leadBlocked", { doing: lead.doing }, t.address);
      if (lead.approval && !prev?.approval) ev(team, "leadApproval", {}, t.address);
      if (JSON.stringify(prev) !== JSON.stringify(lead)) { team.lead = lead; changed = true; }
      if (team.pending) { team.pending = false; changed = true; }
      if (!team.folder && t.cwd) { team.folder = t.cwd; team.machine = machineOf(t.address); changed = true; }
      // the lead works again (or now asks through a dialog): its plain-text question is answered
      if (team.asking && (status === "working" || status === "blocked" || team.asking.address !== t.address)) { team.asking = null; changed = true; }
      continue;
    }
    seen.add(`${key}/${t.address}`);
    const status = a?.status ?? (t.state === "live" ? (stateOf(t.status) ?? "working") : "ended");
    const m = team.members[t.address];
    const next = {
      address: t.address, name: t.name ?? t.address, role: roleOf(t.name, t.labels), task: t.labels["team.task"] ?? "",
      model: t.labels["team.model"] ?? null, effort: t.labels["team.effort"] ?? null, out: t.labels["team.out"] ?? null,
      result: t.labels["team.result"] ?? m?.result ?? null, mr: t.labels["team.mr"] ?? m?.mr ?? null,
      phase: t.labels["team.phase"] ?? null, doing: clean(a?.title ?? t.title), pane: Boolean(a?.pane), status,
      approval: t.labels["team.approval"] === "1", ask: askOf(t.report ?? t.status),
      shipped: "team.shipped" in t.labels ? t.labels["team.shipped"] === "1" : m?.shipped ?? false, shippedAt: m?.shippedAt ?? null,
      since: m && m.status === status ? m.since : now(), first: m?.first ?? now(),
    };
    if (!m) ev(team, "start", { name: next.name, what: next.task || next.role }, t.address);
    else if (m.status !== status) ev(team, status, { name: next.name, doing: status === "blocked" ? next.doing : null }, t.address);
    if (next.approval && !m?.approval && status !== "ended") ev(team, "approval", { name: next.name }, t.address);
    if (!m || JSON.stringify(m) !== JSON.stringify(next)) { team.members[t.address] = next; changed = true; }
  }
  for (const k of Object.keys(st.forgotten)) if (!carried.has(k)) { delete st.forgotten[k]; changed = true; }
  for (const team of Object.values(st.teams)) {
    for (const m of Object.values(team.members)) {
      if (m.status !== "ended" && !seen.has(`${team.key}/${m.address}`)) { m.status = "ended"; m.since = now(); ev(team, "ended", { name: m.name }, m.address); }
    }
    if (team.lead?.live && !live.some((t) => t.address === team.lead.address && t.labels?.team === team.key && t.labels?.["team.lead"] === "1")) { team.lead.live = false; changed = true; }
    if (team.asking && !team.lead?.live) { team.asking = null; changed = true; }
    const running = runState(team) === "running";
    for (const m of Object.values(team.members)) {
      if (isShipped(team, m)) {
        if (m.shippedAt) continue;
        m.shippedAt = m.status === "ended" ? m.since : now(); changed = true;
        if (running) ev(team, "shipped", { name: m.name, result: m.result }, m.address);
      } else if (m.shippedAt) { m.shippedAt = null; changed = true; }
    }
    // the kanban column: remember since when, and log each move to the task's activity
    const col = columnOf(team);
    if (team.col !== col) {
      const first = !team.col;
      const at = first && !running ? lastAt(team) : now();
      if (!first) ev(team, "col", { col }, null);
      team.col = col; team.colSince = at; team.colAt = { ...(team.colAt ?? {}), [col]: at }; changed = true;
    }
  }
  // A run is dropped only once none of its terminals is live (else the next sync would bring it back: a write on every
  // sync). Demo runs go as soon as that happens; others a month after their last activity, or past the cap.
  const gone = (k) => !carried.has(k) && runState(st.teams[k]) !== "running";
  for (const [k, team] of Object.entries(st.teams)) if (gone(k) && (isDemo(team) || now() - lastAt(team) > FORGET_MS)) { delete st.teams[k]; changed = true; }
  const keys = Object.keys(st.teams).sort((x, y) => (runState(st.teams[y]) === "running") - (runState(st.teams[x]) === "running") || lastAt(st.teams[y]) - lastAt(st.teams[x]));
  for (const k of keys.slice(MAX_TEAMS)) if (gone(k)) { delete st.teams[k]; changed = true; }
  if (changed) setShared(KEY, st);
  return st;
}

// Role → two-letter code (technician view only), shown in a tag tinted by the role's group.
const ROLE_CODE = {
  lead: "LD", researcher: "RS", "plan-reviewer": "PR", planner: "PL", backend: "BE", frontend: "FE", tester: "QA",
  "design-qa": "DQ", critic: "CR", security: "SE", "security-reviewer": "SE", "bug-hunter": "BH", librarian: "LB", implementer: "IM",
};
const code = (role) => ROLE_CODE[role] ?? role.slice(0, 2).toUpperCase();
const roleName = (role) => T.who[role] ?? role.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase());
const whoWord = (role) => T.who[role] ?? T.helper;
const roleGroup = (role) => {
  const p = role === "lead" ? "lead" : ROLE_PHASE[role] ?? "build";
  return p === "intake" || p === "plan" ? "plan" : p === "review" ? "review" : p === "build" ? "build" : "lead";
};
// The board's only colours not from theme(): four muted role-group hues, a lighter step for dark themes and a
// deeper one for light themes so the tag's text keeps its contrast on both.
const ROLE_HUE = {
  plan: { dark: "#a99cf0", light: "#6650c4" }, build: { dark: "#6fb3e8", light: "#28699f" },
  review: { dark: "#e0a15e", light: "#9a5b18" }, lead: { dark: "#a3adbd", light: "#535d70" },
};
const alpha = (c, a) => (/^#[0-9a-f]{6}/i.test(c ?? "") ? `${c.slice(0, 7)}${Math.round(a * 255).toString(16).padStart(2, "0")}` : c);
const isDark = (t) => {
  const d = settings()?.dark;
  if (typeof d === "boolean") return d;
  const x = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(t.background ?? "");
  return !x || (parseInt(x[1], 16) * 299 + parseInt(x[2], 16) * 587 + parseInt(x[3], 16) * 114) / 1000 < 128;
};
function phaseText(team, state) {
  const p = team.lead?.phase;
  if (p === "done") return T.phaseDone;
  const label = T.phases[p] ?? "—";
  return state === "running" ? label : T.unfinished(label);
}
// The look: one family (the app's UI font), three sizes, a 4/8/12/16/24 spacing scale.
const SM = 12, MD = 13, LG = 15;
const PAD = 24;
const CLEAR = "#00000000";
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRESH_MS = 90000;
const TECH_KEY = `${MOD}.tech`;
const FILTER_KEY = `${MOD}.project`;
const LOCALE_KEY = `${MOD}.locale`; // the last language, so the first frame is already in it
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* per-viewer convenience only */ } },
};

// The projects a task can go to: Herdr's spaces, one per folder (the first terminal's live folder, else the
// space's own folder), on their machine.
function projects() {
  const ps = panes(), seen = new Set(), out = [];
  for (const s of spaces()) {
    const tabs = new Set(s.tabs.map((x) => x.id));
    const folder = ps.find((p) => tabs.has(p.tab) && p.terminal && p.cwd)?.cwd ?? (s.folder || null);
    const id = `${s.machine ?? ""}|${folder ?? s.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, space: s.id, name: s.name, branch: s.branch, folder, machine: s.machine, active: s.active });
  }
  return out;
}
// a task's project name: the one it was started with, else the space whose folder holds the lead's folder
function projectOf(team, list) {
  if (team.projectName) return team.projectName;
  const f = team.folder;
  if (!f) return "—";
  const hit = list.filter((p) => p.folder && (p.machine ?? null) === (team.machine ?? null) && (f === p.folder || f.startsWith(`${p.folder}/`)))
    .sort((x, y) => y.folder.length - x.folder.length)[0];
  return hit?.name ?? base(f);
}

export default class TeamFlow extends View {
  init(p, cx) {
    const pr = p ?? props() ?? {};
    // settings: the last language at once (no flash of English), then the file
    setLocale(store.get(LOCALE_KEY) ?? "en");
    this.cfg = parseSettings(null);
    this.cfgRaw = null; // the file's text as read (writeTextFile's expected snapshot); null = no file yet
    this.setForm = null; // the Settings panel: { locale, error, busy }
    this.cmdBox = InputState.new({ placeholder: DEFAULT_COMMAND });
    cx.spawn(async (cx) => { await this.loadSettings(); cx.notify(); });
    this.task = pr.open ?? null; // the task whose detail is open
    this.tech = store.get(TECH_KEY) === "1"; // "Technical details"
    this.sideTab = "task"; // with tech on: "task" (the plain detail) or "tech" (activity log / member detail)
    this.filter = store.get(FILTER_KEY); // project filter (its name), null = all
    this.showOlder = false; // Done: older than 7 days too
    this.form = null; // the new-task form: { project, error, busy }
    this.returning = null; // the task key whose "Send back with a comment" field is open
    this.busy = {}; // action id → true while an hc call runs
    this.wantMember = pr.member ?? null;
    this.sel = null; // technician view: the member whose detail is open
    this.tail = {}; // address → { text, raw, key, loading } its screen, read once per status / question
    this.gists = {}; // file → its one line
    this.feedWho = null;
    this.seenEv = new Set();
    this.taskBox = TextareaState.new({ placeholder: T.formTaskPh, rows: 5 });
    this.commentBox = TextareaState.new({ placeholder: T.commentPh, rows: 3 });
    this.answerBox = InputState.new({ placeholder: T.answerPh });
    this.answerFor = null; // the blocked member the answer field writes to
    this.answerTo = null; // the member whose answer field the person opened
    this.answerBox.on("submit", (_e, cx) => { if (this.answerFor) this.answerText(this.answerFor.team, this.answerFor.m, this.answerFor.d, cx); });
    if (Array.isArray(pr.forget) && pr.forget.length) forget(pr.forget);
    // relative times ("12 min v tomto stave") and the open task's questions, once a minute
    cx.timer.every(60000, (cx) => { this.refreshOpen(); cx.notify(); });
  }

  async loadSettings() {
    this.cfgRaw = await readTextFile(settingsPath()).catch(() => null);
    this.cfg = parseSettings(this.cfgRaw);
    setLocale(this.cfg.locale);
    store.set(LOCALE_KEY, this.cfg.locale);
  }

  openSettings(cx) {
    this.setForm = { locale: this.cfg.locale, error: null, busy: false };
    this.cmdBox.set_value(Array.isArray(this.cfg.command) ? JSON.stringify(this.cfg.command) : this.cfg.command);
    this.form = null; this.task = null; this.sel = null; this.returning = null;
    cx.notify();
  }

  // writes settings.json (only if it still holds what was read; a stale copy is read again once), then applies it.
  // Saving a file in the mod's folder also reloads the mod, which reads it again.
  saveSettings(cx) {
    const f = this.setForm;
    if (!f || f.busy || checking()) return;
    const raw = this.cmdBox.value().trim();
    let command = raw || DEFAULT_COMMAND;
    if (raw.startsWith("[")) { try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) command = a.map(String); } catch { /* a plain string */ } }
    const next = { ...(this.cfgRaw ? (() => { try { return JSON.parse(this.cfgRaw); } catch { return {}; } })() : {}), locale: f.locale, command };
    const text = `${JSON.stringify(next, null, 2)}\n`;
    f.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let err = null;
      for (let i = 0; i < 2; i++) {
        try { await writeTextFile(settingsPath(), text, this.cfgRaw); err = null; break; } catch (e) {
          err = String(e?.message ?? e);
          this.cfgRaw = await readTextFile(settingsPath()).catch(() => null);
        }
      }
      f.busy = false;
      if (err) { f.error = err; notify({ title: T.setSaveFailed, body: err, level: "error", timeout: 8000 }); cx.notify(); return; }
      this.cfgRaw = text; this.cfg = parseSettings(text); setLocale(this.cfg.locale); store.set(LOCALE_KEY, this.cfg.locale);
      this.setForm = null;
      notify({ title: T.setSaved, body: T.setFile(SETTINGS), level: "success", timeout: 3000 });
      cx.notify();
    });
  }

  settingsPanel(t) {
    const f = this.setForm;
    return v_flex().id("tk-settings").size_full().p(16).gap(16).overflow_y_scrollbar()
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(LG).font_semibold().text_color(t.foreground).child(T.setTitle))
        .child(this.closeX("tk-set-close", t, () => { this.setForm = null; this.cmdBox.blur(); })))
      .child(v_flex().gap(8)
        .child(this.label(T.setLanguage, t))
        .child(h_flex().child(this.segmented("tk-set-lang", Object.entries(LOCALES).map(([code, d]) => ({
          key: code, active: f.locale === code, kids: [div().child(d.name)], fn: () => { f.locale = code; },
        })), t))))
      .child(v_flex().gap(8)
        .child(this.label(T.setCommand, t))
        .child(div().w_full().h(32).px(8).rounded(6).border_1().border_color(t.input ?? t.border).bg(t.background).flex().items_center()
          .child(Input.new(this.cmdBox).w_full().text_size(MD).text_color(t.foreground)))
        .child(div().whitespace_normal().text_size(SM).text_color(t.muted).child(T.setCommandHelp))
        .child(h_flex().child(this.textButton("tk-set-default", `${T.setReset}: ${DEFAULT_COMMAND}`, t, (cx) => { this.cmdBox.set_value(DEFAULT_COMMAND); cx.notify(); }))))
      .when(Boolean(f.error), (el) => el.child(div().whitespace_normal().text_size(SM).text_color(t.blocked).child(f.error)))
      .child(div().whitespace_normal().text_size(SM).text_color(t.muted).child(T.setFile(SETTINGS)))
      .child(h_flex().gap(8)
        .child(this.button("tk-set-save", T.setSave, t, true, (cx) => this.saveSettings(cx), { h: 32, px: 12, size: MD, disabled: f.busy }))
        .child(this.button("tk-set-cancel", T.cancel, t, false, (cx) => { this.setForm = null; this.cmdBox.blur(); cx.notify(); }, { h: 32, px: 12, size: MD })));
  }

  async close() {
    for (const s of [this.taskBox, this.commentBox, this.answerBox, this.cmdBox]) { try { s.release(); } catch { /* already gone */ } }
  }

  // re-read the screens of whoever the open task waits on (a dialog may have changed under the same status)
  refreshOpen() {
    const team = (shared(KEY)?.teams ?? {})[this.task];
    if (team) for (const w of waitsOn(team)) delete this.tail[w.m.address];
    if (this.sel) delete this.tail[this.sel.address];
  }

  // ---------- shared pieces ----------
  tone(status, t) {
    return status === "blocked" ? t.blocked : status === "working" ? t.accent : status === "done" || status === "shipped" ? t.done : t.muted;
  }
  colTone(col, t) { return col === "waiting" ? t.blocked : col === "done" ? t.done : col === "queued" ? t.muted : t.accent; }
  hue(role, t) { return ROLE_HUE[roleGroup(role)][isDark(t) ? "dark" : "light"]; }

  // A member's screen, read once per status and question: its last meaningful line, and the raw text (for a
  // choice dialog). With a team key, a line read once the member stopped working is logged as its output; the
  // lead's line that ends with "?" marks the task as waiting on the person.
  tailOf(m, cx, teamKey) {
    const k = `${m.status}|${m.ask ?? ""}`;
    const tl = this.tail[m.address];
    if (!tl || tl.key !== k) {
      this.tail[m.address] = { text: tl?.text ?? null, raw: tl?.raw ?? null, key: k, loading: true };
      cx?.spawn(async (cx) => {
        const r = await hc(["read", m.address, "--lines", "80"]).catch(() => null);
        const raw = r && r.code === 0 ? r.stdout : "";
        const text = lastLine(raw) ?? "";
        this.tail[m.address] = { text, raw, key: k };
        if (teamKey && text && m.status !== "working") {
          recordOutput(teamKey, m.address, text);
          if (m.lead && (m.status === "idle" || m.status === "done")) recordAsking(teamKey, m.address, /\?\s*$/.test(text) ? text : null);
        }
        cx.notify();
      });
    }
    return this.tail[m.address];
  }

  label(text, t) { return div().text_size(SM).font_medium().text_color(t.muted).child(text); }
  heading(text, t) { return div().flex_none().text_size(MD).font_semibold().text_color(t.foreground).child(text); }

  dot(status, t, motion = true) {
    const el = div().flex_none().size(8).rounded(4);
    if (status === "ended") return el.border_1().border_color(t.muted);
    const d = el.bg(this.tone(status, t));
    return motion && status === "blocked" ? d.loop("opacity", { from: 0.4, to: 1, period: 1800 }) : d;
  }

  pill(status, t, motion = true) {
    const c = this.tone(status, t), quiet = status === "idle" || status === "ended";
    return h_flex().flex_none().h(20).px(8).gap(6).items_center().rounded(10)
      .bg(status === "ended" ? CLEAR : alpha(c, 0.14)).when(status === "ended", (el) => el.border_1().border_color(t.border))
      .child(this.dot(status, t, motion))
      .child(div().text_size(SM).font_medium().text_color(quiet ? t.muted : c).child(T.word[status] ?? status));
  }

  // a column's word as a tinted pill (the plain detail's header); waiting pulses calmly
  colPill(col, t, interrupted) {
    const c = interrupted ? t.muted : this.colTone(col, t);
    return h_flex().flex_none().h(22).px(8).gap(6).items_center().rounded(11).bg(alpha(c, 0.14))
      .child(div().flex_none().size(8).rounded(4).bg(c).when(col === "waiting", (el) => el.loop("opacity", { from: 0.4, to: 1, period: 1800 })))
      .child(div().text_size(SM).font_medium().text_color(c).child(interrupted ? `${T.col.done} · ${T.interrupted}` : T.col[col]));
  }

  roleTag(role, t) {
    const h = this.hue(role, t);
    return div().flex_none().min_w(24).h(18).px(4).rounded(4).bg(alpha(h, 0.15)).flex().items_center().justify_center()
      .text_size(SM).font_medium().text_color(h).child(code(role));
  }
  // A 3 px status stripe inset along the left edge, inside the padding and clear of the rounded corners: GPUI clips
  // overflow to a rectangle, not to the radius, so an edge-to-edge stripe would run over a card's rounded corners.
  stripe(c) { return div().absolute().left(4).top(10).bottom(10).w(3).rounded(2).bg(c); }
  loader(t) { return div().flex_none().w(12).text_size(SM).text_color(this.tone("working", t)).frames(BRAILLE, 100); }

  button(id, text, t, primary, fn, opts = {}) {
    const off = Boolean(opts.disabled);
    return div().id(id).flex_none().h(opts.h ?? 24).px(opts.px ?? 8).rounded(6).flex().items_center().justify_center()
      .text_size(opts.size ?? SM).font_medium()
      .when(opts.full, (el) => el.w_full())
      .when(off, (el) => el.opacity(0.5))
      .when(!off, (el) => el.cursor_pointer())
      .when(primary, (el) => el.bg(t.solid ?? t.foreground).text_color(t.solid_foreground ?? t.background).when(!off, (x) => x.hover((s) => s.opacity(0.9))))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).when(!off, (x) => x.hover((s) => s.bg(t.hover ?? t.raised))))
      .on_click((_e, cx) => { cx.stop_propagation(); if (!off) fn(cx); }).child(text);
  }

  textButton(id, text, t, fn) {
    return div().id(id).flex_none().text_size(SM).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(text);
  }

  // a web link (http(s) only; anything else is shown as plain text), or with file: a handback file to reveal
  link(id, text, t, url, file = false) {
    if (!file && !isWeb(url)) return div().flex_none().text_size(SM).text_color(t.muted).child(text);
    return div().id(id).flex_none().text_size(SM).text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); if (file) cx.spawn(async () => { await revealFile(url); }); else openWeb(url, cx); }).child(text);
  }

  // one line of metadata, "a · b · c": only non-empty parts; each separator travels with the part after it, so a
  // wrapped line never ends in a dangling "·"
  // With dots: false (cards, whose narrow columns wrap the line) the parts are set apart by space only, so a wrapped
  // line never starts or ends with a lone "·".
  meta(parts, t, dots = true) {
    const text = (p) => String(typeof p === "string" ? p : p?.text ?? "").trim();
    const kids = parts.filter((p) => p && text(p)).map((p, i) => h_flex().flex_none().gap(4).items_center()
      .when(dots && i > 0, (el) => el.child(div().text_color(t.dim ?? t.muted).child("·")))
      .child(typeof p === "string" ? div().child(text(p)) : div().text_color(p.color).child(text(p))));
    return h_flex().flex_wrap().gap_x(dots ? 4 : 12).gap_y(2).items_center().text_size(SM).text_color(t.muted).children(kids);
  }

  segmented(id, items, t) {
    return h_flex().min_w(0).flex_wrap().gap(2).p(2).rounded(6).border_1().border_color(t.border)
      .children(items.map((it) => h_flex().id(`${id}-${it.key}`).flex_none().gap(8).items_center().px(8).h(24).rounded(4)
        .text_size(SM).cursor_pointer().bg(it.active ? t.selected ?? t.raised : CLEAR).text_color(it.active ? t.foreground : t.muted)
        .when(it.active, (el) => el.font_medium()).hover((s) => s.bg(it.active ? t.selected ?? t.raised : t.hover ?? t.raised))
        .on_click((_e, cx) => { it.fn(); cx.notify(); }).children(it.kids)));
  }

  result(m, cx) {
    if (m.result) return m.result;
    if (!m.out) return null;
    if (!(m.out in this.gists)) {
      this.gists[m.out] = null;
      cx?.spawn(async (cx) => { this.gists[m.out] = gist(await readTextFile(m.out).catch(() => null)) ?? ""; cx.notify(); });
    }
    return this.gists[m.out] || null;
  }

  pickMember(team, m, cx) {
    const same = this.sel?.address === m.address;
    this.sel = same ? null : { team: team.key, address: m.address };
    this.task = team.key;
    this.sideTab = "tech";
    cx.notify();
  }

  avail(pad, outer = 0) { return this.width ? this.width - (this.hasSide ? SIDE_W : 0) - 2 * pad - outer : Infinity; }

  // ---------- the kanban ----------

  // what is going on right now, in plain words (one line on the card)
  nowText(team, col, cx) {
    if (team.failed) return T.startFailed;
    if (team.pending && !team.lead) return T.starting;
    if (col === "done") return isInterrupted(team) ? T.interruptedNow : (this.summaryOf(team, cx).text ? plain(this.summaryOf(team, cx).text) : T.doneNow);
    if (col === "waiting") {
      const w = waitsOn(team)[0];
      if (w.kind === "approval") return T.needsApproval;
      const q = w.kind === "asking" ? w.text : askWords(w.m.ask) || this.tail[w.m.address]?.text;
      return q ? T.botAsks(plain(q)) : T.needsAnswer;
    }
    if (col === "queued") return T.queuedNow;
    const working = liveMembers(team).filter((m) => m.status === "working");
    if (working.length === 1) return T.works(whoWord(working[0].role), plain(working[0].task, 70));
    if (working.length > 1) return T.worksN(working.length, [...new Set(working.map((m) => whoWord(m.role)))].join(", "));
    return team.lead?.status === "working" ? T.leadWorks : T.teamIdle;
  }
  isWorking(team) { return liveMembers(team).some((m) => m.status === "working") || (team.lead?.live && team.lead.status === "working"); }

  // the team's summary for the person: team.summary, team.result, the lead's handback line; and its links
  summaryOf(team, cx) {
    const l = team.lead ?? {};
    const text = l.summary || l.result || (l.out ? this.result({ out: l.out }, cx) : null) || null;
    const mrs = [l.mr, ...Object.values(team.members).map((m) => m.mr)].filter(Boolean);
    // the ticket: team.ticket (or team.jira), else the first link in the task text; shown by its key (ABC-123) or host
    const raw = l.ticket || l.jira || urlIn(team.task) || null;
    const ticket = raw ? {
      url: /^https?:\/\//i.test(raw) ? raw : null,
      key: raw.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/)?.[0] ?? (/^https?:\/\//i.test(raw) ? raw.replace(/^https?:\/\/([^/]+).*$/i, "$1") : raw),
    } : null;
    return { text, preview: l.preview || null, mr: mrs[0] ?? null, ticket };
  }

  // six progress dots: steps passed in done, the current one in its column's colour, the rest hollow
  dots(team, col, t) {
    const pc = COL_AT[phaseColOf(team)], ci = COL_AT[col], cut = isInterrupted(team);
    return h_flex().flex_none().gap(4).items_center().children(COLS.map((c, i) => {
      const passed = col === "waiting" ? i < 4 && i <= pc : i < ci;
      const cur = i === ci;
      const color = cur ? (cut ? t.muted : this.colTone(col, t)) : passed ? (cut ? t.muted : t.done) : null;
      return div().flex_none().size(6).rounded(3).when(Boolean(color), (el) => el.bg(color)).when(!color, (el) => el.border_1().border_color(t.border));
    }));
  }

  taskCard(team, col, list, t, cx) {
    const picked = this.task === team.key, waiting = col === "waiting", working = !waiting && col !== "done" && this.isWorking(team);
    const cut = col === "done" && isInterrupted(team);
    const since = team.colSince ?? team.started;
    const time = col === "done" ? (cut ? T.endedAt(when(since)) : T.finishedAt(when(since))) : T.inState(span(now() - since));
    const title = titleOf(team, 90);
    const toggle = (cx) => { this.task = picked ? null : team.key; this.sel = null; this.sideTab = "task"; this.form = null; this.returning = null; cx.notify(); };
    return v_flex().id(`tk-${team.key}`).relative().overflow_hidden().w_full().p(12).gap(8).rounded(8).border_1()
      .border_color(picked ? t.accent : waiting ? t.blocked : t.border).bg(picked ? t.selected ?? t.background : t.background)
      .cursor_pointer().hover((s) => s.bg(picked ? t.selected ?? t.hover : t.hover ?? t.raised)).on_click((_e, cx) => toggle(cx))
      .when(working, (el) => el.child(this.stripe(t.accent)))
      .when(waiting, (el) => el.child(this.stripe(t.blocked)))
      .child(div().whitespace_normal().text_size(MD).font_semibold().text_color(t.foreground).child(title))
      .child(this.meta([projectOf(team, list), cut && { text: T.interrupted, color: t.blocked }, time], t, false))
      .child(h_flex().gap(4).items_start().min_w(0)
        .when(working, (r) => r.child(div().pt(1).child(this.loader(t))))
        .when(waiting, (r) => r.child(div().pt(4).child(div().size(8).rounded(4).bg(t.blocked).loop("opacity", { from: 0.4, to: 1, period: 1800 }))))
        .child(div().flex_1().min_w(0).whitespace_normal().text_size(SM).text_color(waiting ? t.foreground : t.muted).child(this.nowText(team, col, cx))))
      .child(this.dots(team, col, t))
      .when(waiting, (el) => el.child(this.button(`tk-cta-${team.key}`, T.lookDecide, t, true, (cx) => { this.task = team.key; this.sel = null; this.sideTab = "task"; this.form = null; cx.notify(); }, { full: true, h: 32, size: MD })));
  }

  kanban(teams, list, t, cx) {
    const by = Object.fromEntries(COLS.map((c) => [c.id, []]));
    for (const team of teams) by[team.col ?? columnOf(team)]?.push(team);
    const since = (x) => x.colSince ?? x.started ?? 0;
    for (const id of Object.keys(by)) by[id].sort((x, y) => (id === "waiting" ? since(x) - since(y) : since(y) - since(x)));
    const recent = by.done.filter((x) => now() - since(x) <= DONE_RECENT), older = by.done.length - recent.length;
    // The columns share the measured width equally while each gets at least KCOL_MIN; below that they keep KCOL_MIN
    // and the row scrolls sideways. (Inside a scroll area GPUI sizes flex columns to their content, so the width is
    // decided here from the board's measured size, not left to flex.)
    const fit = (this.avail(PAD) - KCOL_GAP * (COLS.length - 1)) / COLS.length;
    const scroll = fit < KCOL_MIN;
    return h_flex().id("tk-board").w_full().px(PAD).pb(16).gap(KCOL_GAP).items_start().when(scroll, (el) => el.overflow_x_scrollbar())
      .children(COLS.map((c) => {
        const waiting = c.id === "waiting";
        const cards = c.id === "done" && !this.showOlder ? recent : by[c.id];
        const tone = waiting && by.waiting.length ? t.blocked : t.foreground;
        const box = (scroll ? v_flex().w(KCOL_MIN).flex_none() : v_flex().flex_1().min_w(0)).gap(8).p(8).rounded(10)
          .bg(waiting ? alpha(t.blocked, 0.08) : t.surface ?? t.raised).border_1().border_color(waiting ? alpha(t.blocked, 0.4) : t.border);
        return box
          .child(h_flex().h(28).px(4).gap(8).items_center().min_w(0)
            .when(waiting && by.waiting.length > 0, (el) => el.child(div().flex_none().size(8).rounded(4).bg(t.blocked).loop("opacity", { from: 0.4, to: 1, period: 1800 })))
            .child(div().min_w(0).truncate().text_size(MD).font_semibold().text_color(tone).child(T.col[c.id]))
            .child(div().flex_none().text_size(SM).font_medium().text_color(waiting && by.waiting.length ? t.blocked : t.muted).child(String(by[c.id].length))))
          .children(cards.map((team) => this.taskCard(team, c.id, list, t, cx)))
          .when(!cards.length, (el) => el.child(div().px(4).py(8).whitespace_normal().text_size(SM).text_color(t.muted)
            .child(c.id === "queued" ? T.emptyQueued : waiting ? T.emptyWaiting : T.emptyCol)))
          .when(c.id === "done" && older > 0, (el) => el.child(h_flex().px(4).pt(4)
            .child(this.textButton("tk-older", this.showOlder ? T.hideOlder : T.showOlder(older), t, (cx) => { this.showOlder = !this.showOlder; cx.notify(); }))));
      }));
  }

  toolbar(names, t) {
    const items = [{ key: "all", active: !this.filter, kids: [div().child(T.allProjects)], fn: () => { this.filter = null; store.set(FILTER_KEY, null); } },
      ...names.map((n) => ({ key: n, active: this.filter === n, kids: [div().child(n)], fn: () => { this.filter = n; store.set(FILTER_KEY, n); } }))];
    const check = div().flex_none().size(14).rounded(3).border_1().border_color(this.tech ? t.accent : t.input ?? t.border).bg(this.tech ? t.accent : CLEAR)
      .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground ?? t.background).child(this.tech ? "✓" : "");
    return v_flex().w_full().px(PAD).pt(20).pb(16).gap(12)
      .child(h_flex().w_full().gap(12).items_center()
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(LG).font_semibold().text_color(t.foreground).child(T.title))
          .child(div().truncate().text_size(SM).text_color(t.muted).child(T.subtitle)))
        .child(h_flex().id("tk-tech").flex_none().gap(8).items_center().px(8).h(28).rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover ?? t.raised))
          .on_click((_e, cx) => { this.tech = !this.tech; store.set(TECH_KEY, this.tech ? "1" : "0"); if (!this.tech) { this.sel = null; this.sideTab = "task"; } cx.notify(); })
          .child(check).child(div().text_size(SM).text_color(t.foreground).child(T.tech)))
        .child(this.button("tk-settings-open", T.settings, t, false, (cx) => (this.setForm ? (this.setForm = null, cx.notify()) : this.openSettings(cx)), { h: 32, px: 12, size: MD }))
        .child(this.button("tk-new", `+ ${T.newTask}`, t, true, (cx) => this.openForm(cx), { h: 32, px: 12, size: MD })))
      .when(names.length > 1, (el) => el.child(h_flex().w_full().child(this.segmented("tk-filter", items, t))));
  }

  // ---------- the new-task form ----------
  openForm(cx) {
    const list = projects();
    this.form = { project: list.find((p) => p.active)?.id ?? list[0]?.id ?? null, error: null, busy: false };
    this.task = null; this.sel = null; this.returning = null; this.setForm = null;
    cx.notify();
    cx.timer.after(60, () => this.taskBox.focus()); // once the field is drawn
  }

  formPanel(t) {
    const list = projects();
    const dup = new Set(list.map((p) => p.name).filter((n, i, all) => all.indexOf(n) !== i));
    return v_flex().id("tk-form").size_full().p(16).gap(16).overflow_y_scrollbar()
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(LG).font_semibold().text_color(t.foreground).child(T.formTitle))
        .child(this.closeX("tk-form-close", t, () => { this.form = null; this.taskBox.blur(); })))
      .child(v_flex().gap(8)
        .child(this.label(T.formTask, t))
        .child(div().w_full().p(8).rounded(6).border_1().border_color(t.input ?? t.border).bg(t.background)
          .child(Textarea.new(this.taskBox).w_full().h(112).text_size(MD).text_color(t.foreground))))
      .child(v_flex().gap(8)
        .child(this.label(T.formProject, t))
        .child(list.length
          ? h_flex().flex_wrap().gap(8).children(list.map((p) => {
            const on = this.form.project === p.id;
            return h_flex().id(`tk-proj-${p.id}`).flex_none().h(28).px(10).gap(6).items_center().rounded(14).cursor_pointer()
              .border_1().border_color(on ? t.accent : t.border).bg(on ? alpha(t.accent, 0.14) : CLEAR)
              .hover((s) => s.bg(on ? alpha(t.accent, 0.2) : t.hover ?? t.raised))
              .on_click((_e, cx) => { this.form.project = p.id; this.form.error = null; cx.notify(); })
              .child(div().text_size(SM).font_medium().text_color(on ? t.accent : t.foreground).child(p.name))
              .when(dup.has(p.name) && Boolean(p.branch), (el) => el.child(div().text_size(SM).text_color(t.muted).child(p.branch)));
          }))
          : div().whitespace_normal().text_size(SM).text_color(t.muted).child(T.noProjects)))
      .when(Boolean(this.form.error), (el) => el.child(div().whitespace_normal().text_size(SM).text_color(t.blocked).child(this.form.error)))
      .child(div().whitespace_normal().text_size(SM).text_color(t.muted).child(T.formHint))
      .child(h_flex().gap(8)
        .child(this.button("tk-form-go", T.formSubmit, t, true, (cx) => this.startTask(cx), { h: 32, px: 12, size: MD, disabled: this.form.busy || !list.length }))
        .child(this.button("tk-form-cancel", T.cancel, t, false, (cx) => { this.form = null; this.taskBox.blur(); cx.notify(); }, { h: 32, px: 12, size: MD })));
  }

  // Hands the task to a new coordinator: `hc run --bg … -- <the settings' command, filled in>` in the project's
  // folder, labelled as a team lead at intake. The card shows in To do at once (pending) and follows the terminal.
  startTask(cx) {
    const text = this.taskBox.value().trim();
    const p = projects().find((x) => x.id === this.form?.project);
    if (!splitCommand(this.cfg.command).length) { this.form.error = T.setCommand; cx.notify(); return; }
    if (!text) { this.form.error = T.formEmpty; cx.notify(); return; }
    if (!p) { this.form.error = T.formPick; cx.notify(); return; }
    const st = shared(KEY) ?? { teams: {} };
    const jira = text.match(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/)?.[1];
    let slug = jira ? jira.toLowerCase() : `task-${Math.random().toString(36).slice(2, 6)}`;
    for (let n = 2, b = slug; st.teams?.[slug] || terminals().some((x) => x.labels?.team === slug); n++) slug = `${b}-${n}`;
    const names = new Set(terminals().map((x) => x.name).filter(Boolean));
    let name = `${slug}-lead`.slice(0, 32);
    for (let n = 2; names.has(name); n++) name = `${slug.slice(0, 24)}-lead${n}`;
    const goal = firstLine(text, 60);
    // `env` runs the words as given: hc would run a single word through a shell (`sh -c`), env never does
    const argv = ["env", ...fillCommand(this.cfg.command, { task: text, key: slug, project: p.name, folder: p.folder ?? "" })];
    mutate((s) => {
      s.teams[slug] = { key: slug, started: now(), members: {}, events: [], lead: null, pending: true, leadName: name, goal, task: text, projectName: p.name, folder: p.folder, machine: p.machine ?? null, origin: "panel" };
      pushEvent(s.teams[slug], "action", { a: "created", arg: p.name }, null);
      pushEvent(s.teams[slug], "action", { a: "command", arg: JSON.stringify(argv) }, null);
    });
    this.form = null; this.taskBox.set_value(""); this.taskBox.blur(); this.task = slug;
    cx.notify();
    if (checking()) return;
    const args = ["run", "--json", "--bg", "--no-parent", "--name", name,
      ...(p.folder ? ["--cwd", p.folder] : p.machine ? [] : ["--cwd", home()]),
      ...(p.machine ? ["--on", p.machine] : []),
      "--label", `team=${slug}`, "--label", "team.lead=1", "--label", `team.goal=${goal}`, "--label", "team.phase=intake",
      "--", ...argv];
    cx.spawn(async (cx) => {
      const r = await hc(args).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      let address = null;
      try { address = JSON.parse(r.stdout || "{}").address ?? null; } catch { /* not JSON */ }
      if (r.code !== 0 || !address) {
        const err = (r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.code}`;
        mutate((s) => { const x = s.teams[slug]; if (!x) return false; x.failed = true; x.pending = false; pushEvent(x, "action", { a: "failed", arg: err }, null); });
        notify({ title: T.tStartFailed, body: err, level: "error", timeout: 8000 });
      } else {
        mutate((s) => { const x = s.teams[slug]; if (!x) return false; x.leadAddr = address; });
        notify({ title: T.tStarted, body: T.tStartedBody(p.name), level: "success", timeout: 4000 });
      }
      cx.notify();
    });
  }

  // ---------- the person's actions ----------

  // one hc call for an action: busy while it runs, a toast and the task's activity when it lands
  act(id, teamKey, args, ok, cx, after) {
    if (this.busy[id] || checking()) return;
    this.busy[id] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(args).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      delete this.busy[id];
      if (r.code === 0) {
        if (ok.log) logAction(teamKey, ok.log);
        notify({ title: ok.title, body: ok.body, level: "success", timeout: 4000 });
        await after?.();
      } else {
        notify({ title: T.tFailed, body: (r.stderr || r.stdout || "").trim().split("\n").pop() || `exit ${r.code}`, level: "error", timeout: 8000 });
      }
      cx.notify();
    });
  }

  // Approve / Send back: a message to the coordinator; then the approval labels on the run are cleared
  sendLead(team, msg, ok, id, cx, onOk) {
    const l = team.lead;
    if (!l?.live) return;
    const flagged = [leadMember(team), ...liveMembers(team)].filter((m) => m?.approval).map((m) => m.address);
    this.act(id, team.key, ["send", l.address, "--", msg], ok, cx, async () => {
      onOk?.();
      for (const a of flagged) await hc(["label", a, "team.approval="]).catch(() => null);
      mutate((s) => { const x = s.teams[team.key]; if (!x?.asking) return false; x.asking = null; });
    });
  }
  approve(team, cx) { this.sendLead(team, T.approveMsg, { title: T.tApproved, body: T.tApprovedBody(T.approveMsg), log: { a: "approved" } }, `approve-${team.key}`, cx); }
  sendBack(team, cx) {
    const c = this.commentBox.value().trim();
    if (!c) { this.commentBox.focus(); return; }
    // the comment stays in its field until the coordinator got it
    this.sendLead(team, T.returnedMsg(c), { title: T.tReturned, body: T.tReturnedBody(T.returnedMsg(c)), log: { a: "returned", arg: c } }, `return-${team.key}`, cx,
      () => { this.commentBox.set_value(""); this.commentBox.blur(); this.returning = null; });
  }

  // Answer with an option: the screen is read again and the same option must still be there; then its digit
  // (a numbered list) or the arrows from the cursor and Enter
  answerOption(team, m, label, cx) {
    const id = `answer-${m.address}`;
    if (this.busy[id] || checking()) return;
    this.busy[id] = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["read", m.address, "--lines", "60"]).catch(() => null);
      const d = parseDialog(r?.stdout);
      const opt = d?.options.find((o) => o.label === label);
      delete this.busy[id];
      if (!opt) {
        delete this.tail[m.address];
        notify({ title: T.tChanged, body: T.tChangedBody, level: "warning", timeout: 5000 });
        cx.notify();
        return;
      }
      this.act(id, team.key, ["keys", m.address, ...keysFor(d, opt)], { title: T.tAnswered, body: T.tAnsweredBody(label), log: { a: "answered", arg: label } }, cx,
        async () => { delete this.tail[m.address]; });
    });
  }

  // Answer with text: into the dialog's free-text option when it has one, else typed and sent (forced for a
  // blocked program: the person is answering it)
  answerText(team, m, d, cx) {
    const text = this.answerBox.value().trim();
    if (!text) { this.answerBox.focus(); return; }
    const id = `answer-${m.address}`;
    // `--`: an answer may start with "-" ("-1", "- both"); hc would read it as an option
    const sendArgs = ["send", ...(m.status === "blocked" ? ["--force"] : []), m.address, "--", text];
    const done = { title: T.tAnswered, body: T.tAnsweredBody(text), log: { a: "answered", arg: text } };
    // the answer stays in its field until the send succeeded
    const sent = async () => { delete this.tail[m.address]; if (this.answerBox.value().trim() === text) this.answerBox.set_value(""); this.answerBox.blur(); };
    if (d?.typeOpt) {
      if (this.busy[id] || checking()) return;
      this.busy[id] = true;
      cx.spawn(async (cx) => {
        const r = await hc(["keys", m.address, ...keysFor(d, d.typeOpt)]).catch(() => ({ code: -1 }));
        delete this.busy[id];
        if (r.code !== 0) { notify({ title: T.tFailed, body: r.stderr ?? "", level: "error", timeout: 8000 }); cx.notify(); return; }
        this.act(id, team.key, sendArgs, done, cx, sent);
      });
      return;
    }
    this.act(id, team.key, sendArgs, done, cx, sent);
  }

  // ---------- the plain detail ----------
  closeX(id, t, fn) {
    return div().id(id).flex_none().size(24).rounded(6).flex().items_center().justify_center().cursor_pointer()
      .text_size(MD).text_color(t.muted).hover((s) => s.bg(t.hover ?? t.raised).text_color(t.foreground))
      .on_click((_e, cx) => { fn(); cx.notify(); }).child("✕");
  }
  section(title, body, t) { return v_flex().w_full().gap(8).child(this.label(title, t)).child(body); }

  summaryBox(team, t, cx) {
    const s = this.summaryOf(team, cx);
    const l = team.lead;
    const fallback = !s.text && l?.live ? this.tailOf(leadMember(team), cx, team.key)?.text : null;
    const links = [
      isWeb(s.preview) && this.link(`tk-prev-${team.key}`, T.preview, t, s.preview),
      isWeb(s.mr) && this.link(`tk-mr-${team.key}`, T.mr, t, s.mr),
      s.ticket && (s.ticket.url ? this.link(`tk-ticket-${team.key}`, T.ticket(s.ticket.key), t, s.ticket.url) : div().text_size(SM).text_color(t.muted).child(s.ticket.key)),
    ].filter(Boolean);
    return this.section(T.summary, v_flex().w_full().gap(8)
      .child(div().whitespace_normal().text_size(MD).text_color(s.text ? t.foreground : t.muted).child(s.text ? plain(s.text, 400) : T.noSummary))
      .when(Boolean(fallback), (el) => el.child(v_flex().gap(4)
        .child(div().text_size(SM).text_color(t.muted).child(T.lastMessage))
        .child(div().w_full().pl(8).border_l(2).border_color(t.border).whitespace_normal().text_size(SM).text_color(t.foreground).child(plain(fallback, 300)))))
      .when(links.length > 0, (el) => el.child(h_flex().flex_wrap().gap(12).items_center().children(links))), t);
  }

  // one thing the task waits on: who asks, the question, its options or an answer field
  questionBox(team, w, t, cx) {
    const m = w.m, tl = this.tailOf(m, cx, team.key), id = `answer-${m.address}`, busy = Boolean(this.busy[id]);
    const d = w.kind === "blocked" ? parseDialog(tl?.raw) : null;
    const q = w.kind === "asking" ? w.text : w.kind === "approval" ? T.approvalAsk : askWords(m.ask) || d?.question || tl?.text;
    const box = v_flex().w_full().gap(8).p(12).rounded(8).border_1().border_color(alpha(t.blocked, 0.5)).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().size(8).rounded(4).bg(t.blocked).loop("opacity", { from: 0.4, to: 1, period: 1800 }))
        .child(div().text_size(SM).font_medium().text_color(t.blocked).child(T.asks(whoWord(m.role)))))
      .child(div().whitespace_normal().text_size(MD).text_color(q ? t.foreground : t.muted).child(q ? plain(q, 400) : T.reading));
    if (w.kind === "approval") return box;
    const choices = d?.choices ?? [];
    const wantsField = !d || choices.length === 0 || Boolean(d.typeOpt);
    // one answer field on screen: the box it was last opened for, else the first that needs one
    if (wantsField && (!this.answerFor || this.answerTo === m.address)) this.answerFor = { team, m, d };
    const field = wantsField && this.answerFor?.m.address === m.address;
    return box
      .when(choices.length > 0, (el) => el.child(this.label(T.options, t)).child(v_flex().w_full().gap(4).children(choices.map((o) =>
        h_flex().id(`tk-opt-${m.address}-${o.n}`).w_full().px(10).py(8).gap(8).items_start().rounded(6).border_1().border_color(t.border)
          .when(busy, (x) => x.opacity(0.5)).when(!busy, (x) => x.cursor_pointer().hover((s) => s.bg(t.hover ?? t.raised).border_color(t.accent)))
          .on_click((_e, cx) => { cx.stop_propagation(); if (!busy) this.answerOption(team, m, o.label, cx); })
          .child(div().flex_none().w(18).text_size(SM).font_medium().text_color(t.muted).child(`${o.n}.`))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().whitespace_normal().text_size(MD).text_color(t.foreground).child(o.label))
            .when(Boolean(o.desc), (x) => x.child(div().whitespace_normal().text_size(SM).text_color(t.muted).child(o.desc))))))))
      .when(Boolean(field), (el) => el
        .when(choices.length > 0, (x) => x.child(this.label(T.otherAnswer, t)))
        .child(h_flex().w_full().gap(8).items_center()
          .child(div().flex_1().min_w(0).h(32).px(8).rounded(6).border_1().border_color(t.input ?? t.border).bg(t.background).flex().items_center()
            .child(Input.new(this.answerBox).w_full().text_size(MD).text_color(t.foreground)))
          .child(this.button(`tk-answer-${m.address}`, T.answer, t, true, (cx) => this.answerText(team, m, d, cx), { h: 32, px: 12, size: MD, disabled: busy }))))
      .when(wantsField && !field, (el) => el.child(h_flex().child(this.textButton(`tk-write-${m.address}`, T.writeAnswer, t, (cx) => { this.answerTo = m.address; cx.notify(); }))));
  }

  decisionBox(team, waits, t) {
    const leadBlocked = team.lead?.live && team.lead.status === "blocked";
    const ret = this.returning === team.key;
    const ab = Boolean(this.busy[`approve-${team.key}`] || this.busy[`return-${team.key}`]);
    return v_flex().w_full().gap(8)
      .when(Boolean(leadBlocked), (el) => el.child(div().whitespace_normal().text_size(SM).text_color(t.muted).child(T.answerFirst)))
      .when(ret, (el) => el.child(div().w_full().p(8).rounded(6).border_1().border_color(t.input ?? t.border).bg(t.background)
        .child(Textarea.new(this.commentBox).w_full().h(72).text_size(MD).text_color(t.foreground))))
      .child(h_flex().w_full().gap(8)
        .when(!ret, (el) => el
          .child(this.button(`tk-approve-${team.key}`, T.approve, t, true, (cx) => this.approve(team, cx), { h: 32, px: 14, size: MD, disabled: leadBlocked || ab || !team.lead?.live }))
          .child(this.button(`tk-return-${team.key}`, T.sendBack, t, false, (cx) => { this.returning = team.key; this.commentBox.focus(); cx.notify(); }, { h: 32, px: 12, size: MD, disabled: leadBlocked || ab || !team.lead?.live })))
        .when(ret, (el) => el
          .child(this.button(`tk-return-go-${team.key}`, T.send, t, true, (cx) => this.sendBack(team, cx), { h: 32, px: 14, size: MD, disabled: ab }))
          .child(this.button(`tk-return-no-${team.key}`, T.cancel, t, false, (cx) => { this.returning = null; this.commentBox.blur(); cx.notify(); }, { h: 32, px: 12, size: MD }))));
  }

  stepsBox(team, col, t) {
    const pc = COL_AT[phaseColOf(team)], ci = COL_AT[col], cut = isInterrupted(team);
    return this.section(T.steps, v_flex().w_full().gap(6).children(COLS.map((c, i) => {
      const cur = i === ci, passed = col === "waiting" ? i < 4 && i <= pc : i < ci;
      const color = cur ? (cut ? t.muted : this.colTone(col, t)) : passed ? t.done : null;
      const at = team.colAt?.[c.id];
      return h_flex().gap(8).items_center()
        .child(div().flex_none().size(8).rounded(4).when(Boolean(color), (el) => el.bg(color)).when(!color, (el) => el.border_1().border_color(t.border)))
        .child(div().flex_1().min_w(0).text_size(MD).text_color(cur ? t.foreground : passed ? t.foreground : t.muted).when(cur, (el) => el.font_semibold())
          .child(cur && cut ? `${T.col[c.id]} · ${T.interrupted}` : T.col[c.id]))
        .when(Boolean(at) && (cur || passed), (el) => el.child(div().flex_none().text_size(SM).text_color(t.muted).child(when(at))));
    })), t);
  }

  plainActivity(team, t) {
    const evs = team.events.filter((e) => e.kind === "col" || e.kind === "action").slice(0, 20);
    return this.section(T.activity, evs.length
      ? v_flex().w_full().children(evs.map((e, i, all) => h_flex().w_full().gap(8).items_start().py(6)
        .when(i < all.length - 1, (el) => el.border_b(1).border_color(t.border))
        .child(div().flex_none().pt(4).child(div().size(6).rounded(3).bg(e.kind === "action" ? t.accent : t.muted)))
        .child(div().flex_1().min_w(0).whitespace_normal().text_size(SM).text_color(e.kind === "action" ? t.foreground : t.muted).child(plain(evText(e), 200)))
        .child(div().flex_none().text_size(SM).text_color(t.muted).child(when(e.at)))))
      : div().text_size(SM).text_color(t.muted).child(T.nothingYet), t);
  }

  taskPanel(team, list, t, cx) {
    const col = team.col ?? columnOf(team), cut = col === "done" && isInterrupted(team);
    const waits = col === "waiting" ? waitsOn(team) : [];
    const working = col !== "waiting" && col !== "done" && this.isWorking(team);
    const since = team.colSince ?? team.started;
    this.answerFor = null;
    return v_flex().id(`tk-panel-${team.key}`).size_full().p(16).gap(16).overflow_y_scrollbar()
      .child(h_flex().gap(8).items_center()
        .child(this.colPill(col, t, cut))
        .child(div().flex_1().min_w(0).truncate().text_size(SM).text_color(t.muted)
          .child(col === "done" ? (cut ? T.endedAt(when(since)) : T.finishedAt(when(since))) : T.inState(span(now() - since))))
        .child(this.closeX("tk-panel-close", t, () => { this.task = null; this.sel = null; this.returning = null; })))
      .child(v_flex().gap(4)
        .child(div().whitespace_normal().text_size(LG).font_semibold().text_color(t.foreground).child(titleOf(team, 200)))
        .child(this.meta([projectOf(team, list), T.startedAt(when(team.started))], t)))
      .when(col === "waiting", (el) => el
        .child(v_flex().w_full().gap(4).p(12).rounded(8).bg(alpha(t.blocked, 0.1))
          .child(div().text_size(MD).font_semibold().text_color(t.blocked).child(T.waitingTitle))
          .child(div().whitespace_normal().text_size(SM).text_color(t.foreground).child(T.waitingHelp)))
        .child(this.summaryBox(team, t, cx))
        .child(this.section(T.question, v_flex().w_full().gap(8).children(waits.map((w) => this.questionBox(team, w, t, cx))), t))
        .child(this.decisionBox(team, waits, t)))
      .when(col !== "waiting", (el) => el
        .child(this.section(T.nowTitle, h_flex().gap(4).items_start().min_w(0)
          .when(working, (r) => r.child(div().pt(1).child(this.loader(t))))
          .child(div().flex_1().min_w(0).whitespace_normal().text_size(MD).text_color(t.foreground).child(this.nowText(team, col, cx))), t))
        .when(cut, (x) => x.child(div().whitespace_normal().text_size(SM).text_color(t.muted).child(T.interruptedHelp)))
        .child(this.summaryBox(team, t, cx)))
      .child(this.stepsBox(team, col, t))
      .child(this.plainActivity(team, t));
  }

  // ---------- the technical view ----------
  card(team, m, t, cx, col, narrow) {
    const live = m.status !== "ended", picked = this.sel?.address === m.address;
    const ask = col === "approve", shipped = col === "shipped", gave = !ask && !shipped && handedBack(team, m);
    const shown = ask ? "blocked" : shipped || gave ? "done" : m.status, working = shown === "working";
    const handed = m.status === "done" || m.status === "ended" || shipped || gave, res = handed && !m.lead ? this.result(m, cx) : null;
    const question = ask ? (m.ask || this.tailOf(m, cx, team.key)?.text || m.doing || (m.approval ? T.waitingApproval : T.waitingAnswer)) : null;
    const mr = shipped ? m.mr ?? urlIn(res) : null, ds = shipped ? diffstat(res) : null;
    const sub = [m.name, !narrow && m.model ? (m.effort ? `${m.model} · ${m.effort}` : m.model) : null].filter(Boolean).join(" · ");
    const at = shipped ? T.deliveredAt(when(m.shippedAt ?? m.since)) : gave ? T.deliveredAt(clock(m.since)) : live ? rel(m.since) : T.memberEndedAt(clock(m.since));
    return v_flex().id(`tf-${m.address}`).relative().overflow_hidden().w_full().p(12).gap(8).rounded(6).border_1()
      .border_color(picked ? t.accent : ask ? t.blocked : t.border).bg(picked ? t.selected ?? t.background : t.background)
      .when(!live && !picked && !shipped && !gave, (el) => el.opacity(0.6))
      .cursor_pointer().hover((s) => s.bg(picked ? t.selected ?? t.hover : t.hover ?? t.raised)).on_click((_e, cx) => this.pickMember(team, m, cx))
      .when(working, (el) => el.child(this.stripe(t.accent)))
      .child(h_flex().gap(8).items_center()
        .child(this.roleTag(m.role, t))
        .child(div().flex_1().min_w(0).truncate().text_size(MD).font_medium().text_color(t.foreground).child(roleName(m.role)))
        .child(narrow ? this.dot(shown, t, false) : this.pill(shown, t, false)))
      .child(div().whitespace_normal().text_size(MD).text_color(t.foreground).child(m.task || T.noTask))
      .when(ask, (el) => el.child(div().whitespace_normal().text_size(SM).text_color(t.foreground).child(question))
        .child(h_flex().child(this.button(`tf-answer-${m.address}`, T.reply, t, true, () => go(m.address, m.pane)))))
      .when((Boolean(m.doing) || working) && !handed && !ask, (el) => el.child(h_flex().gap(4).items_center().min_w(0)
        .when(working, (r) => r.child(this.loader(t)))
        .child(div().flex_1().min_w(0).truncate().text_size(SM).text_color(t.muted).child(m.doing || ""))))
      .when(handed && !ask, (el) => el.child(div().whitespace_normal().text_size(SM).text_color(res ? t.foreground : t.muted)
        .child(res ? T.resultLine(res) : shipped ? T.noResult : `${m.status === "done" || gave ? T.word.done : T.word.ended} ${rel(m.since)}`)))
      .when(Boolean(mr || ds || m.out), (el) => el.child(h_flex().flex_wrap().gap(12).items_center()
        .when(Boolean(ds), (r) => r.child(h_flex().flex_none().gap(4).text_size(SM).font_medium()
          .child(div().text_color(t.done).child(`+${ds[0]}`)).child(div().text_color(t.blocked).child(`−${ds[1]}`))))
        .when(Boolean(mr), (r) => r.child(this.link(`tf-mr-${m.address}`, "MR ↗", t, mr)))
        .when(Boolean(m.out), (r) => r.child(div().min_w(0).child(this.link(`tf-out-${m.address}`, `${base(m.out)} ↗`, t, m.out, true))))))
      .child(h_flex().gap(8).items_center().text_size(SM).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(sub))
        .child(div().flex_none().child(at)));
  }

  stepper(team, running, t) {
    const ci = STEP_AT[team.lead?.phase ?? "intake"] ?? 0;
    const cards = boardMembers(team);
    return h_flex().w_full().gap(4).children(STEPS.map((p, i) => {
      const n = cards.filter((m) => colOf(team, m) === p.id).length, waiting = p.id === "approve" && n > 0;
      const cur = i === ci, done = i < ci;
      const seg = div().h(2).w_full().rounded(1).bg(done ? t.done : cur ? (running ? t.accent : t.muted) : t.border);
      return v_flex().flex_1().min_w(0).gap(8).pt(4).pb(12)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().min_w(0).truncate().text_size(MD).when(cur, (el) => el.font_semibold())
            .text_color(cur ? (running ? t.accent : t.foreground) : done ? t.foreground : t.muted).child(T.phases[p.id]))
          .child(div().flex_none().text_size(SM).text_color(waiting ? t.blocked : t.muted).child(String(n))))
        .child(seg);
    }));
  }

  progress(team, running, t) {
    const ci = Math.min(STEP_AT[team.lead?.phase ?? "intake"] ?? 0, STEPS.length);
    return h_flex().w_full().h(2).rounded(1).overflow_hidden().bg(t.border)
      .when(ci > 0, (el) => el.child(div().h_full().flex_grow(ci).bg(t.done)))
      .when(ci < STEPS.length, (el) => el.child(div().h_full().flex_grow(1).bg(running ? t.accent : t.muted))
        .when(ci + 1 < STEPS.length, (r) => r.child(div().h_full().flex_grow(STEPS.length - ci - 1))));
  }

  eventDot(kind, t) {
    if (kind === "ended") return this.dot("ended", t, false);
    return div().flex_none().size(8).rounded(4).bg(kind === "phase" ? t.foreground : kind === "action" || kind === "col" ? t.accent : NEEDS_KINDS.has(kind) ? t.blocked : this.tone(kind, t));
  }

  timeline(events, running, t, id, team, showWho, cx) {
    const used = {};
    let fresh = false;
    const rows = events.slice(0, 50).map((e, i, all) => {
      const m = team && e.who ? whoIn(team, e.who) : null;
      const delivered = m && !m.lead && (e.kind === "done" || e.kind === "ended" || e.kind === "shipped");
      const res = delivered && e.kind !== "shipped" ? this.result(m, cx) : null;
      const k = `${e.at}-${e.kind}-${e.who ?? ""}`, n = used[k] = (used[k] ?? 0) + 1, key = n > 1 ? `${k}-${n}` : k;
      const enter = running && now() - e.at < FRESH_MS && !this.seenEv.has(key);
      if (enter) { this.seenEv.add(key); fresh = true; }
      return h_flex().id(`${id}-${key}`).relative().top(enter ? 6 : 0).opacity(enter ? 0 : 1)
        .transition("opacity", { duration: 400, easing: "ease-out" }).transition("top", { duration: 400, easing: "ease-out" })
        .w_full().gap(8).items_start().py(8)
        .when(i < all.length - 1, (el) => el.border_b(1).border_color(t.border))
        .child(div().flex_none().pt(4).child(this.eventDot(e.kind, t)))
        .child(v_flex().flex_1().min_w(0).gap(4)
          .when(showWho && Boolean(m), (el) => el.child(h_flex().id(`${id}-who-${key}`).gap(8).items_center().cursor_pointer()
            .on_click((_e, cx) => { cx.stop_propagation(); this.feedWho = e.who; cx.notify(); })
            .child(this.roleTag(m.role, t))
            .child(div().flex_none().text_size(SM).font_medium().text_color(t.foreground).child(roleName(m.role)))
            .child(div().min_w(0).truncate().text_size(SM).text_color(t.muted).child(m.name))))
          .child(e.kind === "output"
            ? div().w_full().pl(8).border_l(2).border_color(t.border).whitespace_normal().text_size(SM).text_color(t.foreground).child(evText(e))
            : div().whitespace_normal().text_size(MD).text_color(e.kind === "phase" || NEEDS_KINDS.has(e.kind) || e.kind === "action" ? t.foreground : t.muted)
              .when(e.kind === "phase", (el) => el.font_medium()).child(evText(e)))
          .when(Boolean(res), (el) => el.child(div().whitespace_normal().text_size(SM).text_color(t.foreground).child(T.resultLine(res))))
          .when(Boolean(delivered && m.out), (el) => el.child(h_flex().child(this.link(`${id}-out-${key}`, `${base(m.out)} ↗`, t, m.out, true)))))
        .child(div().flex_none().pt(1).text_size(SM).text_color(t.muted).child(running ? clock(e.at) : when(e.at)));
    });
    if (fresh) cx?.timer.after(32, (cx) => cx.notify());
    return rows;
  }

  feedChips(team, members, t) {
    const twice = new Set(members.map((m) => m.role).filter((r, i, all) => all.indexOf(r) !== i));
    return this.segmented(`tf-chip-${team.key}`, [
      { key: "all", active: !this.feedWho, kids: [div().child(T.everyone)], fn: () => { this.feedWho = null; } },
      ...members.map((m) => ({
        key: m.address, active: this.feedWho === m.address,
        kids: [
          div().child(roleName(m.role)),
          ...(twice.has(m.role) ? [div().text_color(t.muted).child(m.address)] : []),
          div().text_color(t.muted).child(String(eventsOf(team, m).length)),
        ],
        fn: () => { this.feedWho = this.feedWho === m.address ? null : m.address; },
      })),
    ], t);
  }

  feedSummary(team, m, running, t, cx) {
    const res = m.lead ? null : this.result(m, cx), mr = m.mr ?? urlIn(res);
    const live = m.status !== "ended" && (!m.lead || m.live);
    return v_flex().w_full().gap(8).p(12).rounded(6).border_1().border_color(m.status === "blocked" && live ? t.blocked : t.border)
      .child(h_flex().gap(8).items_center()
        .child(this.roleTag(m.role, t))
        .child(div().flex_1().min_w(0).truncate().text_size(MD).font_medium().text_color(t.foreground).child(roleName(m.role)))
        .child(this.pill(m.status, t, live))
        .child(this.button(`tf-feed-detail-${m.address}`, T.details, t, false, (cx) => this.pickMember(team, m, cx))))
      .child(div().whitespace_normal().text_size(SM).text_color(t.muted).child(m.task || T.noTask))
      .when(Boolean(res), (el) => el.child(div().whitespace_normal().text_size(SM).text_color(t.foreground).child(T.resultLine(res))))
      .when(Boolean(m.out || mr), (el) => el.child(h_flex().gap(12)
        .when(Boolean(m.out), (r) => r.child(this.link(`tf-feed-out-${m.address}`, `${base(m.out)} ↗`, t, m.out, true)))
        .when(Boolean(mr), (r) => r.child(this.link(`tf-feed-mr-${m.address}`, "MR ↗", t, mr)))));
  }

  feed(team, running, t, cx) {
    const members = [...(team.lead ? [leadMember(team)] : []), ...Object.values(team.members)];
    if (this.feedWho && !members.some((m) => m.address === this.feedWho)) this.feedWho = null;
    const who = this.feedWho ? members.find((m) => m.address === this.feedWho) : null;
    const events = who ? eventsOf(team, who) : team.events;
    return v_flex().w_full().gap(12)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(this.heading(T.activity, t))
        .child(div().min_w(0).truncate().text_size(SM).text_color(t.muted).child(T.activityOf(team.key, running))))
      .when(members.length > 1, (el) => el.child(h_flex().w_full().child(this.feedChips(team, members, t))))
      .when(Boolean(who), (el) => el.child(this.feedSummary(team, who, running, t, cx)))
      .child(events.length ? v_flex().w_full().children(this.timeline(events, running, t, `tf-ev-${team.key}`, team, !who, cx))
        : div().text_size(SM).text_color(t.muted).child(T.nothingYet));
  }

  memberPanel(team, m, running, t, cx) {
    const live = m.status !== "ended" && (!m.lead || m.live);
    const out = this.tailOf(m, cx, live ? team.key : null), res = m.lead ? null : this.result(m, cx), mr = m.mr ?? urlIn(res);
    const events = eventsOf(team, m);
    const section = (title, body) => v_flex().gap(4).child(this.label(title, t)).child(body);
    const text = (s, color = t.foreground) => div().whitespace_normal().text_size(MD).text_color(color).child(s);
    return v_flex().w_full().gap(16)
      .child(h_flex().gap(8).items_center()
        .child(this.roleTag(m.role, t))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(LG).font_semibold().text_color(t.foreground).child(roleName(m.role)))
          .child(div().truncate().text_size(SM).text_color(t.muted).child(`${m.name} · ${team.key}`)))
        .child(this.closeX("tf-panel-close", t, () => { this.sel = null; })))
      .child(h_flex().gap(12).items_center().flex_wrap()
        .child(this.pill(m.status, t, live))
        .child(div().text_size(SM).text_color(t.muted).child(m.since ? T.since(clock(m.since), live ? ago(m.since) : when(m.since)) : "")))
      .child(section(m.lead ? T.goal : T.task, text(m.task || T.noTask)))
      .when(Boolean(m.model), (el) => el.child(section(T.model, text(m.effort ? `${m.model} · ${m.effort}` : m.model))))
      .when(Boolean(m.doing), (el) => el.child(section(T.doing, text(m.doing))))
      .child(section(T.lastOutput, div().w_full().pl(8).border_l(2).border_color(t.border).whitespace_normal().text_size(SM)
        .text_color(out?.text ? t.foreground : t.muted).child(out?.text || (out?.loading ? T.loading : T.noOutput))))
      .when(Boolean(res), (el) => el.child(section(T.resultTitle, text(res))))
      .when(Boolean(m.out || mr), (el) => el.child(section(T.links, h_flex().gap(12)
        .when(Boolean(m.out), (r) => r.child(this.link("tf-panel-out", `${base(m.out)} ↗`, t, m.out, true)))
        .when(Boolean(mr), (r) => r.child(this.link("tf-panel-mr", "MR ↗", t, mr))))))
      .when(live, (el) => el.child(h_flex().gap(8)
        .child(awaits(m) ? this.button("tf-panel-answer", T.reply, t, true, () => go(m.address, m.pane))
          : this.button("tf-panel-go", T.go, t, false, () => go(m.address, m.pane)))))
      .child(section(T.timeline, events.length ? v_flex().w_full().children(this.timeline(events, running, t, `tf-mev-${m.address}`, team, false, cx))
        : div().text_size(SM).text_color(t.muted).child(T.nothingYet)));
  }

  columns(team, t, cx, pad = PAD, outer = 0) {
    const cards = boardMembers(team);
    const cols = STEPS.map((p) => ({ ...p, list: cards.filter((m) => colOf(team, m) === p.id)
      .sort((x, y) => (p.id === "shipped" ? (y.shippedAt ?? 0) - (x.shippedAt ?? 0) : p.id === "approve" ? (y.status === "blocked") - (x.status === "blocked") : 0) || (x.status === "ended") - (y.status === "ended") || y.since - x.since) }));
    const avail = this.avail(pad, outer);
    const fits = (n) => (avail - COL_GAP * (n - 1)) / n >= MIN_COL;
    const shown = fits(cols.length) ? cols : cols.filter((c) => c.list.length);
    const hidden = cols.filter((c) => !shown.includes(c));
    const scroll = !fits(Math.max(1, shown.length)), w = scroll ? MIN_COL : (avail - COL_GAP * (shown.length - 1)) / shown.length;
    const narrow = w < 210;
    const board = h_flex().id(`tf-board-${team.key}`).w_full().px(pad).pt(hidden.length ? 8 : 16).pb(16).gap(COL_GAP).items_start()
      .when(scroll, (el) => el.overflow_x_scrollbar())
      .children(shown.map((p) => {
        const ask = p.id === "approve", n = p.list.length;
        const col = (scroll ? v_flex().w(MIN_COL).flex_none() : v_flex().flex_1().min_w(0)).gap(8);
        return col
          .child(h_flex().h(24).gap(8).items_center().min_w(0)
            .child(div().flex_none().text_size(MD).font_medium().text_color(t.foreground).child(T.phases[p.id]))
            .child(div().flex_none().text_size(SM).text_color(ask && n ? t.blocked : t.muted).child(String(n)))
            .when(ask, (el) => el.child(div().min_w(0).truncate().text_size(SM).text_color(t.muted).child(T.owner(T.you)))))
          .children(n ? p.list.map((m) => this.card(team, m, t, cx, p.id, narrow))
            : [div().h(40).rounded(6).border_1().border_color(t.border).flex().items_center().justify_center()
              .text_size(SM).text_color(t.muted).child(ask ? T.nobodyWaiting : T.noMembers)]);
      }));
    if (!hidden.length) return board;
    return v_flex().w_full()
      .child(div().px(pad).pt(12).truncate().text_size(SM).text_color(t.muted).child(T.hiddenCols(hidden.map((c) => T.phases[c.id]).join(", "))))
      .child(board);
  }

  nowRow(team, m, t, first) {
    const needs = m.status === "blocked", picked = this.sel?.address === m.address, working = m.status === "working";
    return h_flex().id(`tf-now-${m.address}`).relative().overflow_hidden().w_full().pl(16).pr(12).py(8).gap(12).items_center()
      .when(!first, (el) => el.border_t(1).border_color(t.border))
      .bg(picked ? t.selected ?? t.hover : t.background).cursor_pointer().hover((s) => s.bg(picked ? t.selected ?? t.hover : t.hover ?? t.raised))
      .on_click((_e, cx) => this.pickMember(team, m, cx))
      .when(working || needs, (el) => el.child(this.stripe(this.tone(m.status, t))))
      .child(this.roleTag(m.role, t))
      .child(v_flex().w(136).flex_none().min_w(0)
        .child(div().truncate().text_size(MD).font_medium().text_color(t.foreground).child(roleName(m.role)))
        .child(div().truncate().text_size(SM).text_color(t.muted).child(m.name)))
      .child(v_flex().flex_1().min_w(0)
        .child(h_flex().gap(4).items_center().min_w(0)
          .when(working, (r) => r.child(this.loader(t)))
          .child(div().flex_1().min_w(0).truncate().text_size(MD).text_color(m.doing ? t.foreground : t.muted).child(m.doing || (m.lead ? T.coordinating : T.noDoing))))
        .when(Boolean(m.task), (el) => el.child(div().truncate().text_size(SM).text_color(t.muted).child(m.task))))
      .child(v_flex().w(112).flex_none().items_end().gap(4)
        .child(this.pill(m.status, t, needs))
        .child(div().text_size(SM).text_color(t.muted).child(ago(m.since))))
      .child(this.button(`tf-go-${m.address}`, needs ? T.reply : T.go, t, needs, () => go(m.address, m.pane)));
  }

  // the technician view of one task: header, right now, stepper and member board (a finished run: outcome,
  // stepper and board)
  techView(team, t, cx) {
    const running = runState(team) === "running";
    const liveM = liveMembers(team);
    const rows = [...(team.lead?.live ? [leadMember(team)] : []), ...liveM]
      .sort((x, y) => (URGENCY[x.status] ?? 4) - (URGENCY[y.status] ?? 4) || (x.since ?? 0) - (y.since ?? 0));
    const working = liveM.filter((m) => m.status === "working").length, blocked = rows.filter((m) => m.status === "blocked").length;
    const ci = STEP_AT[team.lead?.phase ?? "intake"] ?? 0;
    const state = runState(team);
    return v_flex().w_full().border_t(1).border_color(t.border)
      .child(v_flex().px(PAD).pt(24).pb(16).gap(4)
        .child(this.label(T.techOf(team.key), t))
        .child(div().whitespace_normal().text_size(LG).font_semibold().text_color(t.foreground).child(team.lead?.goal || team.goal || team.key))
        .child(this.meta(running ? [
          team.key,
          ci < STEPS.length ? T.stepOf(T.phases[STEPS[ci].id], ci + 1, STEPS.length) : T.phaseDone,
          T.runningFor(ago(team.started), clock(team.started)),
          T.nActiveMembers(liveM.length),
          T.nWorking(working),
          blocked > 0 && { text: T.nNeedYou(blocked), color: t.blocked },
        ] : [
          team.key, { text: T.result[state], color: state === "done" ? t.done : t.muted }, T.took(span(lastAt(team) - team.started)), phaseText(team, state),
        ], t))
        .child(div().pt(12).child(this.progress(team, running, t))))
      .when(running, (el) => el.child(v_flex().px(PAD).pb(24).gap(8)
        .child(h_flex().gap(8).items_center()
          .child(this.heading(T.rightNow, t))
          .child(div().min_w(0).truncate().text_size(SM).text_color(t.muted).child(T.clickMember)))
        .child(rows.length ? v_flex().w_full().rounded(6).overflow_hidden().border_1().border_color(t.border)
          .children(rows.map((m, i) => this.nowRow(team, m, t, i === 0)))
          : div().text_size(SM).text_color(t.muted).child(T.nobodyWorking))))
      .child(div().px(PAD).border_b(1).border_color(t.border).child(this.stepper(team, running, t)))
      .child(this.columns(team, t, cx));
  }

  // the right column: the new-task form, else the open task (plain detail; with tech on, a tab for the team's
  // activity or a member's detail)
  sideColumn(all, list, t, cx) {
    if (this.setForm) return this.settingsPanel(t);
    if (this.form) return this.formPanel(t);
    const team = all.find((x) => x.key === this.task);
    if (!team) { this.task = null; this.sel = null; return null; }
    let m = null;
    if (this.sel) { m = whoIn(team, this.sel.address); if (!m) this.sel = null; }
    const running = runState(team) === "running";
    const techTab = this.tech && this.sideTab === "tech";
    const body = techTab
      ? v_flex().id(`tf-side-${team.key}`).size_full().p(16).gap(16).overflow_y_scrollbar()
        .child(m ? this.memberPanel(team, m, running, t, cx) : this.feed(team, running, t, cx))
      : this.taskPanel(team, list, t, cx);
    return v_flex().size_full()
      .when(this.tech, (el) => el.child(h_flex().flex_none().px(16).pt(12).child(this.segmented("tk-side", [
        { key: "task", active: !techTab, kids: [div().child(T.tabTask)], fn: () => { this.sideTab = "task"; } },
        { key: "tech", active: techTab, kids: [div().child(T.tabTech)], fn: () => { this.sideTab = "tech"; } },
      ], t))))
      .child(v_flex().flex_1().min_h(0).w_full().child(body));
  }

  render(cx) {
    const t = theme(), st = sync();
    const all = Object.values(st.teams);
    const list = projects();
    if (this.wantMember) {
      const team = all.find((x) => x.members[this.wantMember] || x.lead?.address === this.wantMember);
      if (team) { this.task = team.key; this.tech = true; this.sideTab = "tech"; this.sel = { team: team.key, address: this.wantMember }; }
      this.wantMember = null;
    }
    // read each live member's screen once per status change: outputs go to the activity, the lead's question too
    for (const x of all) if (runState(x) === "running") for (const m of [...(x.lead?.live ? [leadMember(x)] : []), ...liveMembers(x)]) this.tailOf(m, cx, x.key);
    const names = [...new Set(all.map((x) => projectOf(x, list)))].sort((a, b) => a.localeCompare(b));
    if (this.filter && !names.includes(this.filter)) this.filter = null;
    const shownTeams = this.filter ? all.filter((x) => projectOf(x, list) === this.filter) : all;
    const side = this.sideColumn(all, list, t, cx);
    this.hasSide = Boolean(side);
    const open = this.tech && this.task ? all.find((x) => x.key === this.task) : null;
    return h_flex().id("kanban").size_full().bg(t.background).text_color(t.foreground)
      // on_size_change reports window px; layout sizes are written at zoom 1
      .on_size_change((size, cx) => { const w = size.width / (Number(settings()?.zoom) || 1); if (Math.abs((this.width ?? 0) - w) > 1) { this.width = w; cx.notify(); } })
      .child(v_flex().id("tk-scroll").flex_1().min_w(0).h_full().overflow_y_scrollbar().pb(24)
        .child(this.toolbar(names, t))
        .child(this.kanban(shownTeams, list, t, cx))
        .when(Boolean(open), (el) => el.child(this.techView(open, t, cx))))
      .when(Boolean(side), (el) => el.child(v_flex().w(SIDE_W).flex_none().h_full().border_l(1).border_color(t.border).bg(t.background).child(side)));
  }
}
