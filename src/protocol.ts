// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type RunnerKind = 'vitest' | 'jest'
export type RunScope = 'all' | 'failed'
export type RunTrigger = 'manual' | 'agent-done'

export type TestFailure = {
  /** Unique within one run: file + full test name (+ `#n` for repeats). */
  id: string
  /** Relative to the workspace, `/`-separated; absolute when the file is outside it. */
  file: string
  /** Describe blocks and the test title, joined with ` › `; one line, capped. */
  name: string
  /** The test's own title, for `-t` filters. */
  title: string
  line: number | null
  /** ANSI-free, truncated. A file that failed to load has one failure with an empty title. */
  message: string
}

export type TestRun = {
  runner: RunnerKind
  scope: RunScope
  trigger: RunTrigger
  startedAt: number
  finishedAt: number
  passed: number
  failed: number
  skipped: number
  total: number
  failures: TestFailure[]
  failuresTruncated: boolean
  /** Set when the runner produced no usable report (a config error, a crash, a timeout). */
  error: string | null
}

export type WorkspaceSupport =
  | { kind: 'ok'; runner: RunnerKind }
  | { kind: 'no-workspace' }
  | { kind: 'remote' }
  | { kind: 'no-runner' }

export type PanelState = {
  /** Opaque: names the workspace this state is about, so requests act on the one shown. */
  workspaceKey: string | null
  workspace: { name: string; branch: string } | null
  support: WorkspaceSupport
  running: { startedAt: number; scope: RunScope; trigger: RunTrigger } | null
  lastRun: TestRun | null
  autoRun: boolean
}

export type AskAgentResult = { via: 'terminal' | 'launch'; agent: string | null }

declare module 'orca' {
  interface PluginRequests {
    /** What the panel draws for the focused workspace. */
    'tests.state': { output: PanelState }
    /** Starts a run and answers at once; `tests.changed` follows. */
    'tests.run': { input: { workspaceKey: string; scope: RunScope }; output: PanelState }
    /** Stops a run, and any re-run queued behind it. */
    'tests.cancel': { input: { workspaceKey: string }; output: PanelState }
    /** Opens a failing test's file in an editor tab. */
    'tests.openFile': { input: { workspaceKey: string; failureId: string }; output: { opened: boolean } }
    /** Sends one failure (or every failure, without an id) to the workspace's agent. */
    'tests.askAgent': { input: { workspaceKey: string; failureId?: string }; output: AskAgentResult }
    'tests.setAutoRun': { input: { enabled: boolean }; output: PanelState }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel whenever the focused workspace or its run changes. */
    'tests.changed': PanelState
  }
}
