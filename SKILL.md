---
name: graph-foreman
description: Executes an approved plan as a task GRAPH — orchestrator + parallel subagents, validation before any task counts as done, live dashboard. Use for any plan big enough that the order of work matters.
---

# /graph-foreman [plan|run]

![Live dashboard of a run: phase swimlanes, parallel executors, a task under review](https://raw.githubusercontent.com/JrSantiaggo/graph-foreman/media/dashboard.png)

Runs an **already approved** plan through the graph engine bundled with this skill: a DAG of
tasks, subagents executing the independent ones in parallel, a validation gate before anything
is `done`, and a read-only dashboard the dev can watch.

## When to use

- An **approved plan of ~5+ tasks** where the ORDER of work matters
- Tasks **independent enough to parallelise** across subagents — that is the graph's payoff
- When "done" must mean something **checked**: every task passes a fresh reviewer, never a
  self-report
- Long runs the dev wants to **watch live** instead of reading a report afterwards

## When NOT to use

- **No approved plan yet** — route to your planning workflow first; this skill executes,
  it never plans (see below)
- **Small or strictly sequential work** — a 3-task chain needs no orchestrator; just do it
- **As a planning tool** — translating an approved task list into the plan format is this
  skill's job; inventing the tasks is not
- **Solo agents without subagent dispatch** — executors and reviewers must be separate
  agents; without that, the reviewer gate has nothing to enforce

**This skill does not plan.** The plan comes from your planning workflow (a spec skill's
`tasks.md`, or the dev directly). If there is no approved plan yet, stop and say so —
orchestrating an unapproved plan just parallelises the wrong work.

**"Approved" means the DEV said yes to that plan.** A plan you (the orchestrator) wrote
yourself in this same conversation is NOT approved by existing: translating an approved task
list into the plan format is mechanical and fine; inventing the tasks from a prompt is
planning, and planning is not this skill's job. If the user arrives with only a prompt, either
route them to their planning workflow or draft the plan and SHOW it — the run starts after
their yes, never before.

Argument: a plan file, a run name to RESUME, or nothing (then use `.specs/graph/CURRENT`).
With no argument AND no current run, do not guess: if this session just produced the approved
plan, use it; otherwise ask the dev where it lives (or name the candidates you found —
`tasks.md`, a specs directory — and get a yes before translating one). The SOURCE plan can
live anywhere the project keeps it; only the run state is fixed at `.specs/graph/`.

## 0. Resolving the engine

The scripts live under `scripts/` in **this skill's own directory** (where this `SKILL.md`
resides) — resolve them relative to the skill directory, never the workspace root, and never
assume a fixed install path. Every command below writes them as:

```bash
ENGINE="<this skill's directory>/scripts/engine.mjs"    # e.g. .claude/skills/graph-foreman/scripts/engine.mjs
SERVE="<this skill's directory>/scripts/serve.mjs"
```

They need Node 18+ and nothing else — no npm install, no dependencies. State lives in
`.specs/graph/` at the **project root**, which the engine discovers by walking up from cwd to
the first `.git` or `package.json` (`GRAPH_ROOT` overrides). **`.specs/` must be gitignored**
— run state is local scratch, never committed; `init` warns when it is not.

## 1. The plan file

Plans live in `.specs/graph/plans/<name>.plan.json`. Translating a task list into one is
mechanical, and only two fields carry judgment:

- **`deps` is the entire scheduling model.** A task is ready when every dep is `done` or
  `skipped`. Anything that must NOT run in parallel is expressed as a dep chain — migrations
  serialize because each depends on the last, never because the engine knows what a migration
  is. Be honest here: a dep you add "to be safe" costs the whole graph its parallelism, and
  one you omit hands two agents the same file.
- **`validation` is what must be TRUE before done**, written so a different agent could check
  it. "tests pass" is not that; "test suite green + the 3 new cases named in the task" is.
  When the contract is executable, prefer the structured form — `[{ "run": "<command>",
  "expect": "<what green means>" }]` — so the reviewer runs exactly what is written instead
  of interpreting prose. Prose stays valid for contracts that are not commands.
- **`touches` lists the paths the task writes** (prefixes). `init` refuses two tasks that can
  run in parallel and declare overlapping paths — the collision is caught while it is still a
  planning mistake, before two agents get the same file. Optional, but omitting it leaves the
  dep chain as the only guard.

A task is **isolated in space, ordered in time**: never a file shared with a task beside it,
while building on what its deps produced is the whole point.

Full task contract (every field, defaults, per-task `requireReview`/`maxAttempts`
overrides) and the CLI: [README.md](README.md) beside this file.

## 2. Start the run AND the dashboard

```bash
node $ENGINE init --plan .specs/graph/plans/<name>.plan.json --run <name>-01
```

Then start the server **in the background** and give the dev the URL before dispatching a
single agent — a dashboard offered after the run is a log, not observability:

```bash
node $SERVE     # http://localhost:4949 — background, read-only, safe to kill anytime
```

It follows `.specs/graph/CURRENT`, so `init` already pointed it at this run. If the port is
taken, the previous run's server is still up and already serving this one — say so instead of
starting a second.

## 3. The loop

```bash
node $ENGINE ready       # what can start NOW
```

### The two roles

**Executors write. A REVIEWER bangs the gavel.** They are different agents, always.

- **Up to 3 executors** run at once, out of a total cap of 4 busy agents — the safe
  defaults, overridable per plan with `"maxExecutors"` and `"maxParallel"`. Scale them to
  the project and the machine, but keep the INVARIANT: executors strictly below the total
  (e.g. 6 + 8), because that headroom is what keeps review unblockable. Executors are
  capped BELOW the total so review always has room — if executors could fill every slot, a
  finished task would sit unverified waiting for one, which is the worst state the graph can
  hold: work done, and nobody able to say whether it counts.
- **Review is never blocked, and reviews run in PARALLEL.** `review` is a role handoff: the
  task already holds its slot as `running`, so moving it to `reviewing` needs no new one.
  Three tasks finishing together get three fresh reviewers at once — nothing queues for a
  verdict. What the `reviewing` tasks DO occupy is the total cap: 1 running + 3 in review =
  4 busy, and the next executor waits for a `done`.
- **The reviewer is a ROLE, not one long-lived agent.** Dispatch a FRESH reviewer per task.
  One agent reviewing thirty tasks accumulates exactly the context the graph exists to avoid,
  and by task twenty it is no longer reading with fresh eyes. Its whole value is that it never
  watched the code being written.
- `review` refuses a reviewer that is the task's own author. That check is the contract.

### The loop

```bash
node $ENGINE ready                              # prints free EXECUTOR slots
node $ENGINE start T4 --agent ag-scenes         # dispatch up to 3, in the SAME message
node $ENGINE review T4 --agent rev-scenes       # executor finished → hand to a fresh reviewer
node $ENGINE validate T4 --ok --evidence "..."  # the REVIEWER's verdict
node $ENGINE done T4
```

**Dispatch as many ready tasks as the executor cap allows in the SAME message** — parallelism
is the point of the graph, and tasks that share no dep share no file.

**One agent, one task**, executors and reviewers alike. Every `--agent` must be a distinct
name and the engine refuses one already busy. Reusing a label across two concurrent tasks
records a parallelism that did not happen — and if it really was one agent doing both, the two
tasks shared a context, which is exactly what the graph exists to prevent.

### What the reviewer gets, and what it decides

Give it the task's **validation contract**, the **diff**, and nothing about how the work went —
no narrative from the executor, which is the thing most likely to talk it into a pass. It runs
the project's gate ITSELF (see "Project overrides" below), checks the contract clause by
clause, and answers `--ok` or `--failed` with evidence naming what it ran and what it found.

- **Rejected** → `fail T4 --reason "review: <what is missing>"` then `retry T4`. The reason
  travels to the next executor; a rejection with no actionable reason wastes an attempt.
- `done` **refuses a validation recorded by the executor** — a self-report is not a verdict.
  Turn it off only with `"requireReview": false` in the plan, and only for a run where the
  gate genuinely does not apply.

- **`--evidence` is a claim the REVIEWER is making.** Record what was actually run and what it
  answered. `done` refuses without a passing review validation for the CURRENT attempt, which is
  the one rule that stops "it looks right" from becoming state.
- **Never accept a verdict on the executor's word.** An agent that says "tests pass" and an
  agent that ran them are indistinguishable in a report and completely different in a graph.
  That is the entire reason the reviewer exists — and the reason it must not be the author.
- A failure is `fail T4 --reason "<what broke>"` then `retry T4`. Past **3 attempts** the
  engine warns and the escalation is the dev's — do not keep spending attempts.
- A task that turns out to need the dev: `block T1 --reason "..."`. Blocked is a real state;
  leaving it `running` while you wait is how a graph lies.
- `note <task> --text "..."` for anything a later reader would need and the states cannot say.

## 4. What NOT to ask

**No confirmation per task.** The plan is approved; executing it is the job. Consult the dev
only for a genuinely ARCHITECTURAL decision or an ambiguity that could change what the project
is — and when you do, `block` the task so the graph shows why it stopped.

## 5. Project overrides — FILL THIS IN for your repo

This section is the ONLY part of the skill that is yours: the engine and the discipline above
never change between projects, but every repo has its own gate, its own git policy and its own
planning source. Replace this block (or record the same answers in your project's
`CLAUDE.md`); an orchestrator running with these questions unanswered is guessing.

- **The gate per task**: the exact commands a reviewer runs to validate a task (e.g.
  `npm test -- --changed && npm run lint`). Prefer a scoped/changed-only run per task and the
  full suite once at the end — a full run per task is minutes spent proving nothing.
- **Commit policy**: does an executor commit its own task, or does the run end with the work
  in the tree and the dev committing? Say which. If agents commit, say what the message
  convention is.
- **Plan source**: which skill or document produces the approved plan this skill executes.
- **Shared tree**: can OTHER agents be writing to this tree during a run? If so, a red test in
  a file no task touched is not this run's regression — check before chasing it. Name any
  known-red baseline the project carries.
- **Where durable knowledge goes**: `.specs/` is scratch. A decision, invariant or convention
  discovered mid-run must LEAVE it before the run closes — name the destination your repo uses
  (ADRs, a domain doc, the root agent rules file). A finished run whose knowledge stayed in
  `.specs/` shipped nothing but code.

## 6. Close-out

Report against the graph, not against memory: `node $ENGINE status` is the source. Say what is
`done`, what is `blocked` and on whom, and what a `skipped` task means. Never report a run as
finished while a task is blocked — say "34/36, two waiting on you, here is what for".
