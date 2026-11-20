// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type RunnerKind = 'vitest' | 'jest' | 'playwright' | 'cypress' | 'gradle' | 'maven' | 'pytest'
/** `related`: only tests that import files changed since the last run (Vitest, Jest). */
export type RunScope = 'all' | 'failed' | 'related'
export type RunTrigger = 'manual' | 'agent-done'
export type Locale = 'en' | 'ko'

/** One runner in one folder of the workspace: a monorepo has several. */
export type ProjectInfo = {
  /** Stable within a workspace: `<root>:<runner>`. */
  id: string
  name: string
  /** Relative to the workspace, `/`-separated; `''` for the workspace root. */
  root: string
  runner: RunnerKind
  /** Browser tests: never run on their own after an agent finishes, unless configured. */
  e2e: boolean
}

export type TestFailure = {
  /** Unique within one run. */
  id: string
  /** The project it belongs to (`ProjectInfo.id`). */
  project: string
  /** Relative to the workspace, `/`-separated; absolute when the file is outside it. */
  file: string
  /** Describe blocks (or class) and the test title, joined with ` › `; one line, capped. */
  name: string
  /** The test's own title, for `-t` filters; `''` when a whole file failed to run. */
  title: string
  line: number | null
  /** ANSI-free, truncated. */
  message: string
  /** Not failing in the previous run: most likely the latest change broke it. */
  isNew: boolean
  /** Failed, then passed when re-run: probably not the change's fault. */
  flaky: boolean
}

export type ProjectResult = {
  project: string
  name: string
  runner: RunnerKind
  passed: number
  failed: number
  skipped: number
  flaky: number
  /** The runner produced no usable report: a config or compile error, a crash, a timeout. */
  error: string | null
}

/** The workspace's test state: the last run merged over what earlier runs found for the projects
 *  and files it did not run. */
export type TestRun = {
  /** What the last run covered. */
  scope: RunScope
  trigger: RunTrigger
  startedAt: number
  finishedAt: number
  /** For `related` runs: how many changed files picked the tests. */
  changedFiles: number | null
  /** Tests the last run executed; the counts below also hold earlier results it did not redo. */
  ran: number
  passed: number
  failed: number
  skipped: number
  flaky: number
  total: number
  projects: ProjectResult[]
  failures: TestFailure[]
  failuresTruncated: boolean
}

export type WorkspaceSupport =
  | { kind: 'ok'; projects: ProjectInfo[] }
  | { kind: 'no-workspace' }
  | { kind: 'remote' }
  | { kind: 'no-runner' }
  | { kind: 'config-error'; message: string }

export type PanelState = {
  /** Opaque: names the workspace this state is about, so requests act on the one shown. */
  workspaceKey: string | null
  workspace: { name: string; branch: string } | null
  support: WorkspaceSupport
  /** `.orca-test-runner.json` in the workspace root shaped the projects. */
  configFile: boolean
  running: {
    startedAt: number
    scope: RunScope
    trigger: RunTrigger
    /** The project running now, and how many of this run's projects are done. */
    project: string | null
    done: number
    total: number
  } | null
  lastRun: TestRun | null
  autoRun: boolean
  autoFix: { enabled: boolean; round: number; maxRounds: number }
}

export type AskAgentResult = { via: 'terminal' | 'launch'; agent: string | null; sent: number }

declare module 'orca' {
  interface PluginRequests {
    /** What the panel draws for the focused workspace; `locale` is Orca's, for notifications. */
    'tests.state': { input: { locale?: Locale }; output: PanelState }
    /** Starts a run and answers at once; `tests.changed` follows. `project` limits it to one. */
    'tests.run': {
      input: { workspaceKey: string; scope: 'all' | 'failed'; project?: string }
      output: PanelState
    }
    /** Stops a run, and any re-run queued behind it. */
    'tests.cancel': { input: { workspaceKey: string }; output: PanelState }
    /** Opens a failing test's file in an editor tab. */
    'tests.openFile': { input: { workspaceKey: string; failureId: string }; output: { opened: boolean } }
    /** Sends one failure, or every failure (`onlyNew`: the new ones), to the workspace's agent. */
    'tests.askAgent': {
      input: { workspaceKey: string; failureId?: string; onlyNew?: boolean }
      output: AskAgentResult
    }
    'tests.setAutoRun': { input: { enabled: boolean }; output: PanelState }
    'tests.setAutoFix': { input: { enabled: boolean }; output: PanelState }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel whenever the focused workspace or its run changes. */
    'tests.changed': PanelState
  }
}
