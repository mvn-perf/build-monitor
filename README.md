# build-monitor

> A GitHub Action that publishes an HTML **monitoring page** of your GitHub
> Actions builds: every **[mvn-lens](https://github.com/mvn-perf/mvn-lens)
> Maven build report** one click away from the GitHub step that produced it,
> and the **builds themselves** — runs, jobs, steps, durations — over time.
> Reports travel through git, **never as artifacts**, and each run links its
> own monitoring page from the job summary the moment it finishes.

Zero dependencies (plain Node ≥ 20, runs on the runner's Node 24), a static
site on `gh-pages`, history that outlives GitHub's 90-day log retention.

## What you get

| Page | Shows |
|---|---|
| **mvn-lens reports** (`#/reports`) | Every report, newest run first, grouped by run: *job › step (· label)*, Maven total / wall / CPU time, status, JDK — with a **Report** link (in-page viewer) and a **GitHub step ↗** deep link. A “Trends” strip draws the Maven total-time sparkline per series. Filters: date range, branch, event, status, job, text (remembered per repository in the browser, except the text search). |
| **Report viewer** (`#/report/<run>/<key>`) | The full mvn-lens report in a sandboxed iframe, under a context bar: workflow · #run · branch · job › step · Maven total & status · GitHub step ↗ · raw report. |
| **Builds** (`#/builds`) | Run durations per workflow over time (points coloured by conclusion, click → run), a job selector switching to that job's duration **stacked by step**, and the runs table. |
| **Run** (`#/run/<id>`) | One run: its reports table, then a Gantt timeline of jobs and steps with step ↗ links and mvn-lens chips. A run the processor has not seen yet shows a “waiting for the Build monitor workflow” page that refreshes itself. |

The job summary of every monitored run ends with
**Open this run in the monitoring page ↗** and a per-job table (result,
duration, Maven total, report links) — requirement number one.

## Quick start

Three actions, one repository:

- `mvn-perf/build-monitor/report` — in each Maven job, right after the Maven
  step: publishes `report.html` to this run's **inbox ref**
  (`refs/heads/build-monitor-inbox/<run id>`).
- `mvn-perf/build-monitor/summary` — final job of the run: writes the
  monitoring link + table into `$GITHUB_STEP_SUMMARY`.
- `mvn-perf/build-monitor` — its own workflow, after the run completes:
  grafts the inbox into `gh-pages`, updates `data/history.json` and
  `index.html`, requests a Pages build, deletes the inbox ref.

### 1. Publish reports (in your build workflow)

Enable mvn-lens in the project (`.mvn/extensions.xml`, see the
[mvn-lens README](https://github.com/mvn-perf/mvn-lens#quick-start)), then add
one step right after each Maven step:

```yaml
jobs:
  build:
    name: Java ${{ matrix.java }} (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    permissions:
      contents: write   # push report.html to refs/heads/build-monitor-inbox/<run id>
      actions: read     # identify this job and step through the API
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false    # keep the write token out of .git/config

      - name: Build with Maven
        run: mvn -B -ntp verify

      - name: Publish mvn-lens report
        if: ${{ !cancelled() }}         # a failed build's report is the one you want
        uses: mvn-perf/build-monitor/report@main
        with:
          report: target/mvnlens/report.html            # default; globs and lists accepted
          job-name: Java ${{ matrix.java }} (${{ matrix.os }})   # the job's display name, for matrix jobs
```

### 2. Summarize the run (final job)

```yaml
  monitoring:
    runs-on: ubuntu-latest
    needs: [build]        # every job that publishes a report
    if: ${{ !cancelled() }}
    permissions:
      contents: read
      actions: read
    steps:
      - uses: mvn-perf/build-monitor/summary@main
```

Full example: [`examples/ci-with-build-monitor.yml`](examples/ci-with-build-monitor.yml).

### 3. Process completed runs (its own workflow)

```yaml
name: Build monitor
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
  schedule:
    - cron: '17 3 * * *'      # daily sweep
  workflow_dispatch:
    inputs:
      run-id:
        description: Run id(s) to (re)process
        type: string
        required: false
        default: ''

permissions:
  actions: read
  contents: write
  pages: write                # request the Pages build (see “GitHub Pages setup”)

concurrency:
  group: build-monitor
  cancel-in-progress: false
  queue: max                  # every completed run keeps its place in the queue

jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - uses: mvn-perf/build-monitor@main
        with:
          run-id: ${{ inputs.run-id }}
```

Full example: [`examples/build-monitor.yml`](examples/build-monitor.yml).

### 4. GitHub Pages setup (once)

1. Run the **Build monitor** workflow once by hand (Actions → Build monitor →
   Run workflow) — it creates the `gh-pages` branch, which must exist before
   Pages can point at it.
2. **Settings → Pages → Build and deployment → Source: “Deploy from a
   branch”**, branch `gh-pages`, folder `/(root)`.

The page lives at `https://<owner>.github.io/<repo>/`. The `pages: write`
permission matters: per the
[GitHub docs](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site),
*“commits pushed by a GitHub Actions workflow that uses the `GITHUB_TOKEN` do
not trigger a GitHub Pages build”* — so the action explicitly requests one
(`POST /pages/builds`) after committing. Without the permission it warns and
the site goes stale until something else triggers a build.

## How it works — the inbox protocol

Reports are **never uploaded as artifacts**. Inside GitHub, git is the only
other durable store a job can write, so each run gets a transient **inbox
ref** and the processor is the **only writer of `gh-pages`**:

```
your CI workflow (run 12345)                     Build monitor workflow (after the run)
────────────────────────────                     ──────────────────────────────────────
mvn verify ─► target/mvnlens/report.html         workflow_run(CI completed) / nightly sweep
      │                                                        │
      ▼                                                        ▼
report action (in each Maven job)                1. read gh-pages head + data/history.json
  · which job/step am I?  (Jobs API)             2. list refs/heads/build-monitor-inbox/*
  · Maven summary from the embedded model           (+ sweep: recent runs missing from history)
  · re-encode the data block gzip+base64         3. per run: GET run + jobs → RunRecord;
  · ONE commit onto                                 read each key's meta.json from the inbox
    refs/heads/build-monitor-inbox/12345         4. GRAFT reports/12345/<key> into the new
      reports/12345/<key>/report.html               gh-pages tree BY SHA — the report bytes
      reports/12345/<key>/meta.json                 are never re-uploaded, they just get
    (compare-and-swap, retried: only this           a second name in the same repository
    run's jobs ever contend)                     5. merge history, render index.html,
      │                                             ONE commit to gh-pages (compare-and-swap)
      ▼                                          6. POST /pages/builds  → the site updates
summary action (final job)                       7. delete the grafted inbox refs
  · reads the run's jobs + inbox snapshot
  · monitoring link + per-job table
    into GITHUB_STEP_SUMMARY
```

- **Why an inbox and not direct pushes to `gh-pages`?** Thirteen matrix jobs
  pushing to one branch would fight over the ref, and if `gh-pages` received
  a push per job it could also queue a Pages build per push — GitHub soft-caps
  Pages at **10 builds per hour**. The inbox ref is contended only by the jobs
  of one run, is never a Pages source, and grafting is metadata-only: one
  `gh-pages` commit and one Pages build per completed run.
- **Compare-and-swap, not force.** Every commit (inbox and `gh-pages`) is a
  non-forced ref update on top of the head that was just read; on a conflict
  the action re-reads, re-merges and retries with jittered backoff. Nothing
  is ever force-pushed.
- **History beyond retention.** GitHub keeps job/step timings for 90 days.
  `data/history.json` (schemaVersion 1) on `gh-pages` keeps every run the
  processor saw: runs → jobs → steps plus the mvn-lens summary numbers
  (total/wall/CPU/GC/JIT/download/test times…), so trends keep growing.
- **Sweeps make it self-healing.** Every invocation also checks the last
  `sweep-runs` runs per monitored workflow and any leftover inbox refs, so a
  lost `workflow_run` event or a cancelled processor run is caught up by the
  next trigger or the nightly schedule.
- **Attribution survives matrices and re-runs.** `meta.json` written inside
  the build job pins the report to a job **id**, step **number** and run
  **attempt**; the processor falls back to runner name, job name, job key and
  the key convention `j<jobId>-s<step>`. Reports of an earlier attempt are
  kept but marked superseded (hidden behind a toggle).
- **Inbox refs are deleted conservatively.** A ref goes only once its run has
  completed *and* it still points at the commit that was grafted; a ref that
  moved meanwhile (a late report step) is grafted again — by sha, for free —
  by the next invocation. With a `workflow_run` trigger only the triggering
  workflow is processed by default; the inbox refs of other workflows wait
  for their own event, a `workflow_dispatch` or the nightly sweep.

## Inputs — `mvn-perf/build-monitor/report`

| Input | Default | Description |
|---|---|---|
| `report` | `target/mvnlens/report.html` | Path(s)/glob(s) of the report(s); newline- or comma-separated. |
| `step-name` | auto | The step that ran Maven. By default, the step that was running when the report file was written (normally the previous step). |
| `job-name` | auto | The job's display name, for jobs with a custom `name:` (matrix expressions expand fine). Without it the job is found by runner name, then job key. |
| `label` | — | Distinguishes several Maven builds of the same step (a scenario, a matrix leg). Part of the series identity. |
| `github-token` | `${{ github.token }}` | Needs `contents: write` (inbox commit) and `actions: read` (job/step lookup). |
| `inbox-prefix` | `build-monitor-inbox/` | Branch namespace of the inbox refs; must match the other two actions. |
| `site-url` | derived | Overrides `https://<owner>.github.io/<repo>/` for the links this step prints. |
| `compress` | `true` | Losslessly re-encode the report's embedded JSON as gzip+base64 (22.8 MB → 2.9 MB); skipped when the report cannot inflate it. |
| `if-no-files-found` | `warn` | `warn`, `error` or `ignore` when no report exists. |
| `fail-on-error` | `false` | Fail the step when publishing fails (default: warn, set outputs, exit 0 — publishing monitoring data should not break a build). |
| `commit-message` | `Add mvn-lens report` | Prefix of the inbox commit message (`<prefix>: <job> › <step>`). |

Outputs: `found`, `published`, `key`, `report-path`, `monitor-url`,
`report-url`, `job-id`, `step-name`, `maven-total-ms`, `commit-sha`, `reason`
(why nothing was published).

## Inputs — `mvn-perf/build-monitor/summary`

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `actions: read` (this run's jobs) and `contents: read` (this run's inbox ref). |
| `inbox-prefix` | `build-monitor-inbox/` | Must match the `report` steps. |
| `site-url` | derived | Overrides the monitoring page URL in the summary. |
| `title` | `Build monitoring` | Heading of the summary section. |
| `fail-on-error` | `false` | Fail the step when the jobs or the inbox ref cannot be read (default: warn and still write the monitoring link). |

Outputs: `monitor-url`, `reports-count` (report files found in this run's
inbox). The step never fails the workflow unless `fail-on-error` is set.

## Inputs — `mvn-perf/build-monitor` (the processor)

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Needs `actions: read`, `contents: write`, and `pages: write` for the explicit Pages build request. |
| `repository` | current | `owner/name` to monitor. |
| `branch` | `gh-pages` | Branch that serves the site. |
| `site-dir` | — | Sub-directory inside the branch (other branch content is preserved). |
| `site-url` | derived | Public URL of the site (input → Pages API → `https://<owner>.github.io/<repo>/`). |
| `title` | derived | Page title. |
| `inbox-prefix` | `build-monitor-inbox/` | Must match the `report` steps. |
| `workflows` | triggering | Workflows to monitor (names, file names, paths or ids; newline- or comma-separated). Default: the triggering `workflow_run`'s workflow, else all except this one. |
| `exclude-workflows` | — | Same syntax. |
| `include-self` | `false` | Also monitor the workflow this action runs in. |
| `run-id` | event run | Run id(s) to (re)process; defaults to `github.event.workflow_run.id`. |
| `sweep-runs` | `20` | Most recent runs per monitored workflow checked on **every** invocation and (re)processed when missing from the history or changed since (re-runs, runs first seen in progress). `0` disables. |
| `lookback-days` | `90` | How far back the sweep looks for new runs (the history keeps older ones). |
| `include-fork-runs` | `false` | Also record runs whose head repository is a fork (they have no reports either way — see the trust model). |
| `concurrency` | `4` | Parallel API requests. |
| `request-pages-build` | `true` | `POST /pages/builds` after publishing. |
| `dry-run` | `false` | Build everything, publish nothing: the site is written to `output-dir` instead. |
| `output-dir` | `build-monitor-site` | Where the dry-run site is written. |

Outputs: `site-url`, `runs-processed`, `runs-total`, `reports-collected`,
`reports-bytes`, `published`, `commit-sha`.

## Trust model

**The build jobs hold a `contents: write` token.** That is the deliberate
price of “no artifacts”: within GitHub, the repository's git database is the
only durable store a build job can write a report to, so the `report` step
commits to `refs/heads/build-monitor-inbox/<run id>` with the job's
`GITHUB_TOKEN`. A token with `contents: write` can push to **any unprotected
branch** — treat it accordingly:

- **`persist-credentials: false` on checkout.** The token then never lands in
  `.git/config`; build steps, tests and Maven plugins that run before the
  report step cannot read a write-capable credential out of the working tree.
  (`run:` steps do not receive `GITHUB_TOKEN` in their environment unless the
  workflow passes it explicitly.)
- **Rulesets on the branches that matter.** Protect `main` and your release
  branches with a ruleset (restrict updates, require pull requests): the
  workflow token then cannot push there regardless of its permission. The
  actions only ever write `build-monitor-inbox/*` and the site branch.
- **Fine-grained token / GitHub App as an alternative.** If you prefer to keep
  `GITHUB_TOKEN` read-only in build jobs, pass a fine-grained PAT or a GitHub
  App installation token (Contents read & write, Actions read, this repository
  only) as `github-token`. Pushes then run under a distinct, auditable
  identity — and an App can be put on a ruleset bypass list where needed.
- **Fork pull requests publish nothing.** Their `GITHUB_TOKEN` is read-only
  no matter what the workflow requests: the `report` step detects the 403,
  warns, sets `published: false` with a `reason`, and exits successfully.
  The processor additionally ignores fork runs unless `include-fork-runs`.
- **Report HTML is user-controlled content on your Pages origin.** The viewer
  embeds it only inside `<iframe sandbox="allow-scripts allow-popups
  allow-popups-to-escape-sandbox allow-downloads" referrerpolicy="no-referrer">`;
  only files that actually contain an mvn-lens model are published; every
  path recorded in `history.json` is validated against a strict pattern
  before it becomes a URL, and everything else on the page is rendered with
  `textContent`, never `innerHTML`.
- The token is passed through the API client only (never a command line, no
  `git` checkout of the site) and is masked in the log at startup.

## Size & limits

Measured on real reports:

- One mvn-lens `report.html` is 2.8–23 MB of HTML with the model embedded as
  plain JSON. The `report` action re-encodes that block as gzip+base64 — the
  encoding the report's own renderer already inflates (pako is inlined) — so
  it is **lossless**: 22.8 MB → **2.9 MB**, 2.8 MB → 1.6 MB. Only
  `report.html` is published, never `model.json` or JFR files.
- A 13-job [assertj](https://github.com/mvn-perf/assertj) run adds **~35 MB**
  of compressed reports. GitHub Pages serves sites up to **1 GB**, so that is
  roughly **30 runs with full report HTML** before a cleanup is due (the
  timings in `history.json` are tiny in comparison and keep the trends going
  regardless).
- **Retention is a documented follow-up, not built yet** — but it has a
  corner reserved: the processor is the **only** writer of the site branch,
  so a future `keep-reports` can rewrite `gh-pages` as a single orphan commit
  (dropping old report blobs from the reachable history) without racing
  anyone. Until then, deleting the `gh-pages` branch and re-running the Build
  monitor workflow resets the site, keeping nothing.
- API budget (`GITHUB_TOKEN`: 1 000 requests/hour/repository): a `report`
  step costs ~9–12 requests (jobs, inbox ref, Pages URL, two blobs, tree,
  commit, ref), the processor a handful per run (run + jobs + meta blobs +
  one commit). The job summary of the processor lists the requests actually
  used.
- Inbox refs are deleted after grafting; their objects become unreachable and
  are garbage-collected by GitHub eventually. The branch list stays clean.
- Pages soft limit of 10 builds/hour: the processor performs **one** build
  request per invocation, and the inbox refs are never a Pages source.

## Site layout (branch `gh-pages`)

```
index.html                      the app (static; fetches the dataset)
data/history.json               the dataset — schemaVersion 1, runs newest first (see src/history.js)
reports/<runId>/<key>/report.html   key = j<jobId>-s<step>[-label]  (or <job key>-<random>[-label] when the
reports/<runId>/<key>/meta.json     attribution written inside the build job   job could not be identified)
.nojekyll
```

`history.json` is plain JSON meant for other tooling too: every run with its
jobs and steps (`number`, `name`, `conclusion`, `startedAt`, `completedAt`,
`durationMs`) and `mvnLens` entries whose `summary` carries `totalMs`,
`wallMs`, `cpuMs`, `gcMs`, `c2Ms`, `downloadMs`, `testMs`, `moduleCount`, …

## Development

```bash
npm test                  # node:test suite against an in-memory fake GitHub (Git Data API included)
npm run lint              # parses every shipped script, checks the Node 20 surface + the three manifests
npm run demo              # a synthetic site in .tmp/demo-site (and .tmp/demo-site-fetch, exercising the fetch path)
npm run serve             # serves a built site over HTTP (the app cannot fetch data/history.json from file:)
node scripts/serve.js .tmp/demo-site-fetch 0   # any directory; port 0 = a free port, printed at startup

# a real dry run against any repository you can read
INPUT_GITHUB_TOKEN=$(gh auth token) INPUT_REPOSITORY=mvn-perf/assertj \
INPUT_DRY_RUN=true INPUT_OUTPUT_DIR=.tmp/site node src/index.js
```

The actions run straight from the repository on the runner's Node
(`using: node24`; the code needs nothing newer than Node 20) — no build step,
no `node_modules`, nothing to bundle. Chart.js 4.4.6 (MIT) is vendored in
`site/vendor/` (see `site/vendor/THIRD_PARTY.md`).

## Versions

The examples reference `@main`; a moving `v1` tag (semver releases) will
replace it once the assertj integration has settled. Pin a commit SHA if you
prefer.

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Parts of the source
are derived from [mvn-perf/build-dashboard](https://github.com/mvn-perf/build-dashboard)
(Apache 2.0, same authors).
