# Changelog

## 0.2.1

- Tests now run with your own `node`. 0.2.0 ran JS runners with Orca's built-in Electron inside
  the plugin worker, which cannot load unsigned native addons, so toolchains such as Vite 8
  (rolldown), esbuild or swc failed with "Cannot find native binding".
- Runners no longer inherit `ELECTRON_RUN_AS_NODE` from the plugin worker.
- "Run all" with "All projects" selected failed with "input: Invalid input".

## 0.2.0

- Monorepos: one project per package and runner, from `pnpm-workspace.yaml` or package.json
  `workspaces`. Pick one project in the panel to run only that one.
- Playwright, Cypress, Gradle, Maven and pytest, read from their JUnit XML reports.
- After an agent finishes, only the tests related to the changed files run (Vitest, Jest).
- Failures are re-run once; those that pass are marked flaky.
- Failures that were passing in the run before are marked new. "Fix new only" sends just those.
- Optional automatic loop: new failures go back to the agent that caused them, for a set number of
  rounds.
- Status bar item with the focused workspace's result.
- `.orca-test-runner.json` for projects, arguments, environment and auto-run, with a JSON Schema.
- Korean interface, following Orca's language.
- A run that covers part of the suite keeps the earlier results for the rest.
- Coverage is turned off for test runs, so thresholds do not fail partial runs.
- Stored results of removed workspaces are cleaned up.
- Fixes: a run can no longer hang on a process the tests left running; a non-zero exit without a
  failing test shows as an error, not a pass; `-t` titles are matched literally; Gradle and Maven
  wrappers start on Windows.

## 0.1.0

- First release: Vitest and Jest in the right sidebar, runs after an agent finishes, sends
  failures to the agent.
