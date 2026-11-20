# Test Runner for Orca

An [Orca](https://orca.dev) plugin that runs your workspace's tests from the right sidebar. When an
agent finishes a turn, it re-runs the tests related to what the agent changed, and a failure can go
back to that agent in one click, or on its own.

[Orca directory](https://orca.dev/plugins/h00ns/test-runner-for-orca) · [Documentation](https://h00ns.github.io/test-runner-for-orca/) · [한국어 문서](https://h00ns.github.io/test-runner-for-orca/ko/)

<img src="images/panel.png" width="340" alt="The Test Runner panel: three projects, two failures (one new), a flaky test, and the buttons that send failures to the agent">

## What it does

- Runs Vitest, Jest, Playwright, Cypress, Gradle, Maven and pytest, and finds them on its own,
  monorepo packages included.
- After an agent finishes a turn that changed files, runs only the tests related to those files
  (Vitest, Jest). Turns that changed nothing run nothing.
- Re-runs a failure once before reporting it. A test that passes the second time is marked flaky.
- Marks failures that were not failing in the run before as **new**.
- Sends a failure to the workspace's idle agent as one line, with a command to reproduce it. It
  never types into an agent that is working or waiting for permission.
- Optionally sends new failures back to the agent by itself, for a set number of rounds.
- Shows the result in Orca's status bar. Pressing it runs the tests.

## Install

In Orca, open **Settings → Plugins**, search for **Test Runner** and install it. Or from a terminal:

```sh
orca plugin install h00ns/test-runner-for-orca
```

Orca shows the access the plugin asks for before it runs (see [Access](#access)).

### Set it up with your agent

Test Runner finds most projects on its own. If yours needs a config file, or you want one your
team can commit, paste this into an agent in the workspace. It writes
[`.orca-test-runner.json`](#configuration) and checks that each suite runs.

```text
Set up Test Runner for Orca in this repository by writing .orca-test-runner.json at the repository root.

1. Find every test suite: Vitest, Jest, Playwright, Cypress, Gradle, Maven or pytest. Look at every package.json (workspace packages too) and its test scripts, the runners' config files, build.gradle(.kts), pom.xml and pyproject.toml.
2. Add one entry to "projects" per suite, with "name", "root" (its folder relative to the repository root; leave it out for the root) and "runner" (vitest, jest, playwright, cypress, gradle, maven or pytest).
3. Add "args" only when the suite needs them, such as a config file, taken from how its test script runs it. Never add reporter, output file, watch or coverage options: Test Runner adds its own. Add "env" only for variables the tests need.
4. Set "autoRun": false for slow suites: browser tests (Playwright, Cypress) and tests that need a running server or database.
5. Start the file with "$schema": "https://raw.githubusercontent.com/h00ns/test-runner-for-orca/main/schema/orca-test-runner.schema.json" and keep it valid JSON, without comments.
6. Run each suite once with its runner and those args to check they work. Then tell me what you set up, and anything you left out and why.
```

## Supported runners

| Runner | Found from | After an agent finishes | Re-run failed | Notes |
| --- | --- | --- | --- | --- |
| Vitest | `vitest` in package.json, `vitest.config.*` | related tests | files | |
| Jest | `jest` in package.json, `jest.config.*` | related tests | files | runs with `--forceExit` |
| Playwright | `@playwright/test`, `playwright.config.*` | off by default | files | browser tests; Playwright 1.49 hangs on Node 24 (1.65 works) |
| Cypress | `cypress`, `cypress.config.*` | off by default | files | browser tests |
| Gradle | `build.gradle(.kts)`, `settings.gradle(.kts)` | whole suite | whole suite | uses `./gradlew` when present |
| Maven | `pom.xml` | whole suite | whole suite | uses `./mvnw` when present |
| pytest | `pytest.ini`, `[tool.pytest…]` in pyproject.toml, `conftest.py` | whole suite | files | uses `.venv` or `venv` when present |

JS runners are started from their own package, so npm, pnpm and yarn all work. Coverage is
turned off for these runs, so coverage thresholds do not fail a run of part of the suite. Gradle,
Maven and pytest results are read from their JUnit XML reports.

## After an agent finishes

1. Orca reports that an agent in a workspace finished a turn.
2. If the code is the same as at the last run (by content, not just `git status`), nothing runs.
3. Otherwise the files changed since that run pick the tests. Vitest and Jest run only the tests
   that import them; other runners run their suite when their folder changed. Browser tests are
   left out unless the config file opts them in. The first automatic run in a workspace, a
   deleted or renamed file, or a folder outside git runs everything instead.
4. A run that covers part of the suite keeps the earlier results for the rest, so a failure it
   did not re-run is still shown.
5. Failures are re-run once. Those that pass are marked flaky; the rest are compared with the run
   before, and the ones that were passing are marked new.
6. A notification tells you when tests start failing, and when they pass again.
7. With **Send new failures back to the agent** on, the failures the agent caused go back to the
   agent that just finished, up to the number of rounds in settings. Then it stops and tells you.
   It skips a turn you interrupted, never types into another agent, and never starts one.

## Monorepos

Test Runner reads `pnpm-workspace.yaml` or the `workspaces` field of package.json, and makes one
project per package and runner. A root that only installs the runner for its packages runs nothing
itself. A root with its own config (a Vitest workspace, Jest `projects`) runs its packages for them.
Pick one project in the panel to run only that one.

## Configuration

Detection covers most repositories. For the rest, put `.orca-test-runner.json` in the workspace
root and commit it, so your team shares it ([your agent can write it](#set-it-up-with-your-agent)):

```json
{
  "$schema": "https://raw.githubusercontent.com/h00ns/test-runner-for-orca/main/schema/orca-test-runner.schema.json",
  "autoRunScope": "related",
  "env": { "TZ": "UTC" },
  "projects": [
    { "name": "web", "root": "apps/web", "runner": "vitest", "args": ["--config", "vitest.unit.config.ts"] },
    { "name": "api", "root": "services/api", "runner": "gradle" },
    { "name": "e2e", "root": "apps/web", "runner": "playwright", "autoRun": false }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `projects` | The projects to run, instead of detecting them. Each has a `root` folder (default: the workspace root), and optionally `runner` (detected when left out), `name`, `args` added to the runner's command, `env`, and `autoRun` (default: true, false for browser tests). |
| `ignore` | Folders to leave out of detection, when `projects` is not given. |
| `autoRunScope` | `related` or `all`: what runs after an agent finishes, for this workspace. |
| `env` | Environment variables for every project. |

The panel says when the file has a problem, and where.

## Settings

Settings → Plugins → Test Runner.

| Setting | Default |
| --- | --- |
| Run tests when an agent finishes | on |
| What runs after an agent finishes | related tests |
| Re-run failures once to catch flaky tests | on |
| Send new failures back to the agent automatically | off |
| Rounds before automatic sending stops | 3 |
| Notify after automatic runs | on |
| Agent to start (when you ask for a fix and none is open) | Claude Code |
| Timeout per project | 10 minutes |

## Access

Test Runner is a full-access (`trusted-worker`) plugin, because it starts your test runners as
processes. Orca asks you to approve once that it may:

- read workspaces, their terminals and agent status
- open files in an editor tab and focus terminals
- type into agent terminals and start agents: when you press a button, or with automatic sending on
- show notifications and a status bar item
- keep its own storage (the last run per workspace) and settings

It makes no network requests and collects no data.

## Limitations

- Local workspaces only. SSH workspaces need a way for plugins to run processes on the remote
  host, which Orca does not offer yet.
- **Open file** opens the file at the top: Orca's API cannot open a file at a line yet.
- Related tests are picked by Vitest and Jest only. Other runners run their whole suite.

## Development

```sh
git clone https://github.com/h00ns/test-runner-for-orca
cd test-runner-for-orca
orca plugin dev watch .     # load into Orca and stream logs
orca plugin test .          # all tests (worker and panel tests need the Orca CLI)
node --test src/agent-prompt.test.ts src/workspace-signature.test.ts src/runner/*.test.ts   # pure tests, plain Node 24
orca plugin check .         # render the panel in each src/panel.check.ts scenario
```

| Path | |
| --- | --- |
| `src/worker.ts` | Follows the workspace, plans and runs, auto-run, auto-fix, status bar |
| `src/runner/projects.ts` | Finds projects: config file, monorepo packages, runners |
| `src/runner/run.ts` | The command for each runner and mode, the process, the report |
| `src/runner/report.ts`, `junit.ts` | Jest JSON and JUnit XML reports |
| `src/agent-prompt.ts` | The one-line prompt and reproduce command per runner |
| `src/panel.tsx`, `src/i18n.ts` | The panel, in English and Korean |

See [CHANGELOG.md](CHANGELOG.md) for what changed. Issues and pull requests are welcome.

## License

[MIT](LICENSE). A community plugin, not made by the Orca team.
