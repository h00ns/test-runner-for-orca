// The plugin's worker: follows the focused workspace, runs its projects' tests, re-runs them when
// an agent in a workspace finishes, hands failures back to that workspace's agent, and keeps the
// status bar item current.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { promptForFailures, type PromptProject } from './agent-prompt.ts'
import { AGENT_NAMES, localeOf, strings, type Strings } from './i18n.ts'
import type {
  AskAgentResult,
  Locale,
  PanelState,
  ProjectResult,
  RunScope,
  RunTrigger,
  TestFailure,
  TestRun,
  WorkspaceSupport
} from './protocol.ts'
import { discoverProjects, type Discovery, type ProjectSpec } from './runner/projects.ts'
import { runsFiles, runsRelated, startRun, type RunHandle, type RunMode, type RunOutcome } from './runner/run.ts'
import { changedFiles, headCommit, workspaceSignature, type Changes } from './workspace-signature.ts'

type Workspace = { id: string; name: string; branch: string; path: string; hostId: string | null }

type ActiveRun = {
  handle: RunHandle | null
  cancelled: boolean
  startedAt: number
  scope: RunScope
  trigger: RunTrigger
  project: string | null
  done: number
  total: number
}

/** What one workspace keeps in storage. */
type Saved = {
  /** The merged test state: the last run over what earlier runs found. */
  run: TestRun | null
  /** The code state the last full or agent-triggered run tested; equal means nothing changed. */
  signature: string | null
  /** The commit that run started from: `related` runs diff against it. */
  head: string | null
}

/** One auto-fix loop: how many times failures went back, and what failed before it began. */
type Loop = { round: number; baseline: string[]; stopNotified: boolean }

/** What one project's run produced, before it is merged into the workspace's state. */
export type ProjectOutcome = {
  project: Pick<ProjectSpec, 'id' | 'name' | 'runner'>
  /** Files the run reached; null when it covered the whole project. */
  ranFiles: string[] | null
  result: ProjectResult
  failures: TestFailure[]
  truncated: boolean
  /** Tests it executed. */
  ran: number
}

const STORAGE_PREFIX = 'ws:'
const AGENT_DONE_DEBOUNCE_MS = 3000
const WORKSPACE_CACHE_MS = 10_000
const DISCOVERY_CACHE_MS = 15_000
/** Posts and stored values are capped at 256 KiB (UTF-8); stay well under. */
const MAX_PAYLOAD_BYTES = 200_000
/** Past this many changed files, picking related tests costs more than running them all. */
const MAX_RELATED_FILES = 300
const MAX_RETRY_FILES = 20
const MAX_RUN_FAILURES = 100
const MAX_TRACKED_FILES = 3000
/** How long a started agent may take to be ready for its prompt. */
const LAUNCH_READY_MS = 60_000
const LAUNCHABLE_AGENTS = new Set(['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot'])
const STATUS_ITEM = 'tests'

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/** An opaque, path-free name for a workspace: raw ids can embed paths, which frames never see. */
export function workspaceKey(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 20)
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** The run, cut down until it fits a post or a stored value: shorter messages, then fewer rows. */
export function fitRun(run: TestRun | null, budget = MAX_PAYLOAD_BYTES): TestRun | null {
  if (!run || bytes(run) <= budget) {
    return run
  }
  const shorten = (failures: TestFailure[], max: number) =>
    failures.map((f) => (f.message.length > max ? { ...f, message: `${f.message.slice(0, max)}\n…` } : f))
  let next: TestRun = { ...run, failures: shorten(run.failures, 800) }
  while (bytes(next) > budget && next.failures.length > 1) {
    next = { ...next, failures: next.failures.slice(0, Math.ceil(next.failures.length / 2)), failuresTruncated: true }
  }
  if (bytes(next) > budget) {
    next = {
      ...next,
      failures: shorten(next.failures, 200),
      projects: next.projects.map((p) => ({ ...p, error: p.error?.slice(0, 2000) ?? null }))
    }
  }
  return next
}

/** What the panel gets of a run: everything but the per-file counts kept for merging. */
function forPanel(run: TestRun | null): TestRun | null {
  return run ? { ...run, projects: run.projects.map(({ files: _files, ...project }) => project) } : null
}

/** The address a failure could not connect to, when the test needed a running server or
 *  database that is not up (no code change fixes that); null otherwise. */
export function unreachableTarget(message: string): string | null {
  if (!/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET|connect ECONNREFUSED/.test(message)) {
    return null
  }
  const at = /(?:ERR_CONNECTION_REFUSED at |ECONNREFUSED )((?:https?:\/\/)?[\w.\-\[\]:]+:\d+)/.exec(message)
  return at?.[1] ?? 'the server'
}

/** A failure id without the `#2` a repeated test name gets, which depends on run order. */
function baseId(id: string): string {
  return id.replace(/#\d+$/, '')
}

/** Marks failures a re-run did not reproduce as flaky. Compared by test, not by repeat order:
 *  a test that failed again in any of its copies is not flaky. Pure, for tests. */
export function markFlaky(failures: TestFailure[], reproduced: ReadonlySet<string>): TestFailure[] {
  const again = new Set([...reproduced].map(baseId))
  return failures.map((f) => (again.has(baseId(f.id)) ? f : { ...f, flaky: true }))
}

/** What changed files mean for one project: run related tests, run everything, or skip it. */
export function planForChanges(project: ProjectSpec, changes: Changes, workspaceRoot: string): RunMode | null {
  const inside = project.root
    ? changes.files.filter((file) => file === project.root || file.startsWith(`${project.root}/`))
    : changes.files
  if (runsRelated(project.runner)) {
    // A removed file's importers cannot be found any more: run the whole project.
    if (changes.removed) {
      return { scope: 'all' }
    }
    // Related tests can live in this package while the change is in a shared one, so every
    // changed file goes to every JS project; one that imports none of them runs nothing.
    return changes.files.length ? { scope: 'related', changed: changes.files.map((file) => join(workspaceRoot, file)) } : null
  }
  return inside.length || (changes.removed && !project.root) ? { scope: 'all' } : null
}

/** Folds this run's project outcomes into the previous state. A project run whole replaces its
 *  results; a partial run (related tests, failed files) replaces only the files it reached; a
 *  project it did not run keeps what it had. Pure, for tests. */
export function mergeRun(
  previous: TestRun | null,
  outcomes: readonly ProjectOutcome[],
  projectIds: readonly string[],
  meta: Pick<TestRun, 'scope' | 'trigger' | 'startedAt' | 'finishedAt' | 'changedFiles'>
): TestRun {
  const results: ProjectResult[] = []
  let failures: TestFailure[] = []
  let truncated = false
  for (const id of projectIds) {
    const outcome = outcomes.find((o) => o.project.id === id)
    const before = previous?.projects.find((p) => p.project === id) ?? null
    const beforeFailures = (previous?.failures ?? []).filter((f) => f.project === id).map((f) => ({ ...f, isNew: false }))
    if (!outcome) {
      if (before) {
        results.push(before)
        failures.push(...beforeFailures)
      }
      continue
    }
    truncated ||= outcome.truncated
    if (outcome.result.error) {
      // Unknown now: keep the last known failures under the error.
      results.push({ ...(before ?? outcome.result), name: outcome.result.name, runner: outcome.result.runner, error: outcome.result.error })
      failures.push(...beforeFailures)
      continue
    }
    if (outcome.ranFiles === null || !before) {
      results.push(outcome.result)
      failures.push(...outcome.failures)
      continue
    }
    const reached = new Set(outcome.ranFiles)
    const kept = beforeFailures.filter((f) => !reached.has(f.file))
    const merged = [...kept, ...outcome.failures]
    const flakyNow = merged.filter((f) => f.flaky).length
    if (!before.files || !outcome.result.files) {
      // No per-file counts (a result stored by an older version): this run's counts stand.
      results.push({ ...outcome.result, failed: merged.filter((f) => !f.flaky).length, flaky: flakyNow })
      failures.push(...merged)
      continue
    }
    // Exact: the files this run reached take its counts; every other file keeps its own.
    const files: Record<string, [number, number, number]> = { ...before.files }
    for (const file of reached) {
      delete files[file]
    }
    Object.assign(files, outcome.result.files)
    const totals = Object.values(files).reduce((t, [p, f, k]) => [t[0] + p, t[1] + f, t[2] + k], [0, 0, 0])
    results.push({
      ...before,
      name: outcome.result.name,
      runner: outcome.result.runner,
      passed: totals[0],
      // A flaky test failed in its file's counts; it is told apart, not counted twice.
      failed: Math.max(0, totals[1] - flakyNow),
      skipped: totals[2],
      flaky: flakyNow,
      error: null,
      files
    })
    failures.push(...merged)
  }
  failures = [...failures.filter((f) => !f.flaky), ...failures.filter((f) => f.flaky)]
  const sum = (key: 'passed' | 'failed' | 'skipped' | 'flaky') => results.reduce((n, r) => n + r[key], 0)
  return {
    ...meta,
    ran: outcomes.reduce((n, o) => n + o.ran, 0),
    passed: sum('passed'),
    failed: sum('failed'),
    skipped: sum('skipped'),
    flaky: sum('flaky'),
    total: sum('passed') + sum('failed') + sum('skipped') + sum('flaky'),
    projects: results,
    failures: failures.slice(0, MAX_RUN_FAILURES),
    failuresTruncated: truncated || failures.length > MAX_RUN_FAILURES || (previous?.failuresTruncated ?? false)
  }
}

function relativeTo(project: ProjectSpec, files: readonly string[]): string[] {
  return files.map((file) => (project.root && file.startsWith(`${project.root}/`) ? file.slice(project.root.length + 1) : file))
}

/** Runs are detached process groups, so they outlive the worker unless stopped here. */
let stopAll: () => void = () => {}

export default function activate(orca: OrcaWorkerApi): void {
  let focusedId: string | null = null
  let locale: Locale = 'en'
  let workspaces: { at: number; rows: Workspace[] } | null = null
  const saved = new Map<string, Saved>()
  const active = new Map<string, ActiveRun>()
  const autoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const rerunQueued = new Set<string>()
  const discoveries = new Map<string, { at: number; value: Discovery }>()
  const loops = new Map<string, Loop>()
  /** Agents that finished a turn in each workspace since its last automatic run, newest last.
   *  Auto-fix answers one of them, never another agent. */
  const finishedAgents = new Map<string, string[]>()
  let statusBar = ''

  const t = (): Strings => strings(locale)

  stopAll = () => {
    for (const timer of autoTimers.values()) {
      clearTimeout(timer)
    }
    for (const entry of active.values()) {
      entry.cancelled = true
      entry.handle?.cancel()
    }
  }

  void orca.storage
    .get('locale')
    .then((value) => {
      if (value === 'ko' || value === 'en') {
        locale = value
      }
    })
    .catch(() => undefined)

  async function load(id: string): Promise<Saved> {
    const cached = saved.get(id)
    if (cached) {
      return cached
    }
    const stored = (await orca.storage.get(STORAGE_PREFIX + workspaceKey(id)).catch(() => null)) as Partial<Saved> | null
    const value: Saved = {
      run: stored?.run && Array.isArray(stored.run.projects) && typeof stored.run.ran === 'number' ? stored.run : null,
      signature: stored?.signature ?? null,
      head: stored?.head ?? null
    }
    // Why not overwrite: a run may have finished while storage answered.
    return saved.get(id) ?? (saved.set(id, value), value)
  }

  async function store(id: string, value: Saved): Promise<void> {
    saved.set(id, value)
    const trimmed: Saved = { ...value, run: fitRun(value.run, MAX_PAYLOAD_BYTES - 1000) }
    await orca.storage
      .set(STORAGE_PREFIX + workspaceKey(id), trimmed as unknown as Parameters<typeof orca.storage.set>[1])
      .catch((error) => orca.log(`could not save the run: ${String(error)}`))
  }

  async function setting<T>(key: string, fallback: T): Promise<T> {
    try {
      const value = await orca.settings.get(key)
      return value === undefined || value === null ? fallback : (value as T)
    } catch {
      return fallback
    }
  }

  async function listWorkspaces(fresh = false): Promise<Workspace[]> {
    if (!fresh && workspaces && Date.now() - workspaces.at < WORKSPACE_CACHE_MS) {
      return workspaces.rows
    }
    const answer = await orca.host.call('workspace.list', {})
    const rows = answer.workspaces.map((row) => ({
      id: row.id,
      name: row.name,
      branch: row.branch ?? '',
      path: row.path,
      hostId: row.hostId
    }))
    workspaces = { at: Date.now(), rows }
    return rows
  }

  async function findWorkspace(match: (row: Workspace) => boolean): Promise<Workspace | null> {
    return (await listWorkspaces()).find(match) ?? (await listWorkspaces(true)).find(match) ?? null
  }

  const byId = (id: string) => findWorkspace((row) => row.id === id)

  async function byKey(key: string): Promise<Workspace> {
    const workspace = await findWorkspace((row) => workspaceKey(row.id) === key)
    if (!workspace) {
      throw hostError('invalid_params', t().errWorkspaceGone)
    }
    return workspace
  }

  /** Drops stored results of workspaces Orca no longer lists (removed worktrees). */
  async function pruneStorage(): Promise<void> {
    const answer = await orca.host.call('workspace.list', {})
    if (answer.truncated) {
      return
    }
    const live = new Set(answer.workspaces.map((row) => STORAGE_PREFIX + workspaceKey(row.id)))
    for (const key of await orca.storage.keys()) {
      if (key.startsWith(STORAGE_PREFIX) && !live.has(key)) {
        await orca.storage.delete(key)
      }
    }
  }

  function isLocal(workspace: Workspace): boolean {
    return (workspace.hostId === null || workspace.hostId === 'local') && existsSync(workspace.path)
  }

  function discover(workspace: Workspace, fresh = false): Discovery {
    const cached = discoveries.get(workspace.id)
    if (!fresh && cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) {
      return cached.value
    }
    let value: Discovery
    try {
      value = discoverProjects(workspace.path)
    } catch (error) {
      value = { kind: 'config-error', message: `Could not read the workspace: ${String(error)}` }
    }
    discoveries.set(workspace.id, { at: Date.now(), value })
    return value
  }

  function support(workspace: Workspace | null): { support: WorkspaceSupport; configFile: boolean } {
    if (!workspace) {
      return { support: { kind: 'no-workspace' }, configFile: false }
    }
    if (!isLocal(workspace)) {
      return { support: { kind: 'remote' }, configFile: false }
    }
    const found = discover(workspace)
    if (found.kind === 'config-error') {
      return { support: { kind: 'config-error', message: found.message }, configFile: true }
    }
    if (found.projects.length === 0) {
      return { support: { kind: 'no-runner' }, configFile: found.configFile }
    }
    return {
      support: {
        kind: 'ok',
        projects: found.projects.map(({ id, name, root, runner, e2e }) => ({ id, name, root, runner, e2e }))
      },
      configFile: found.configFile
    }
  }

  async function panelState(): Promise<PanelState> {
    const workspace = focusedId ? await byId(focusedId) : null
    const running = workspace ? active.get(workspace.id) : undefined
    const { support: s, configFile } = support(workspace)
    return {
      workspaceKey: workspace ? workspaceKey(workspace.id) : null,
      workspace: workspace ? { name: workspace.name, branch: workspace.branch } : null,
      support: s,
      configFile,
      running: running
        ? {
            startedAt: running.startedAt,
            scope: running.scope,
            trigger: running.trigger,
            project: running.project,
            done: running.done,
            total: running.total
          }
        : null,
      lastRun: workspace ? forPanel(fitRun((await load(workspace.id)).run)) : null,
      autoRun: await setting('autoRunWhenAgentFinishes', true),
      autoFix: {
        enabled: await setting('autoFix', false),
        round: workspace ? (loops.get(workspace.id)?.round ?? 0) : 0,
        maxRounds: Math.max(1, await setting('autoFixMaxRounds', 3))
      }
    }
  }

  async function updateStatusBar(state: PanelState): Promise<void> {
    const s = t()
    let item: {
      id: string
      visible: boolean
      text?: string
      icon?: 'refresh' | 'activity' | 'error' | 'warning' | 'check'
      tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
      tooltip?: string
    }
    if (state.support.kind !== 'ok') {
      item = { id: STATUS_ITEM, visible: false }
    } else if (state.running) {
      item = { id: STATUS_ITEM, visible: true, text: s.barRunning, icon: 'refresh', tone: 'accent', tooltip: s.barTooltip }
    } else if (!state.lastRun || state.lastRun.total === 0) {
      item = { id: STATUS_ITEM, visible: true, text: s.barIdle, icon: 'activity', tone: 'neutral', tooltip: s.barTooltip }
    } else if (state.lastRun.failed > 0) {
      item = { id: STATUS_ITEM, visible: true, text: s.barFailed(state.lastRun.failed), icon: 'error', tone: 'danger', tooltip: s.barTooltip }
    } else if (state.lastRun.projects.some((p) => p.error)) {
      item = { id: STATUS_ITEM, visible: true, text: s.barError, icon: 'warning', tone: 'warning', tooltip: s.barTooltip }
    } else {
      item = { id: STATUS_ITEM, visible: true, text: s.barPassed(state.lastRun.passed), icon: 'check', tone: 'success', tooltip: s.barTooltip }
    }
    const key = JSON.stringify(item)
    if (key === statusBar) {
      return
    }
    statusBar = key
    await orca.host.call('statusBar.update', item).catch(() => {
      statusBar = ''
    })
  }

  async function broadcast(): Promise<void> {
    try {
      const state = await panelState()
      orca.panels.post('tests.changed', state)
      await updateStatusBar(state)
    } catch (error) {
      orca.log(`could not update panels: ${String(error)}`)
    }
  }

  async function notify(title: string, body: string): Promise<void> {
    await orca.host.call('notifications.show', { title, body }).catch(() => undefined)
  }

  function failureIds(run: TestRun | null | undefined): string[] {
    return (run?.failures ?? []).filter((f) => !f.flaky).map((f) => f.id)
  }

  async function notifyAfterAutoRun(workspace: Workspace, run: TestRun, previous: TestRun | null) {
    if (run.trigger !== 'agent-done' || !(await setting('notifyOnFailure', true))) {
      return
    }
    const s = t()
    const errors = run.projects.filter((p) => p.error)
    const wasFailing = previous ? previous.failed > 0 || previous.projects.some((p) => p.error) : false
    if (errors.length) {
      if (JSON.stringify(previous?.projects.map((p) => p.error)) === JSON.stringify(run.projects.map((p) => p.error))) {
        return
      }
      await notify(s.notifyError(workspace.name), errors[0]!.error!.split('\n')[0]!.slice(0, 200))
    } else if (run.failed > 0) {
      // Why: the same failures after every agent turn would be noise.
      if (wasFailing && failureIds(previous).sort().join('\n') === failureIds(run).sort().join('\n')) {
        return
      }
      await notify(s.notifyFailing(run.failed, workspace.name), s.notifyFailingBody(run.passed))
    } else if (wasFailing && run.total > 0) {
      await notify(s.notifyPass(workspace.name), s.notifyPassBody(run.passed))
    }
  }

  function runProject(entry: ActiveRun, workspace: Workspace, project: ProjectSpec, mode: RunMode, timeoutMs: number): Promise<RunOutcome> {
    const handle = startRun(project, mode, timeoutMs, workspace.path)
    entry.handle = handle
    if (entry.cancelled) {
      handle.cancel()
    }
    return handle.done
  }

  /** One project's outcome, after re-running its failures once to tell flaky tests apart. */
  async function testProject(
    entry: ActiveRun,
    workspace: Workspace,
    project: ProjectSpec,
    mode: RunMode,
    timeoutMs: number,
    retry: boolean,
    before: ReadonlySet<string> | null
  ): Promise<{ outcome: ProjectOutcome; cancelled: boolean }> {
    const base: ProjectResult = { project: project.id, name: project.name, runner: project.runner, passed: 0, failed: 0, skipped: 0, flaky: 0, error: null }
    const empty = { project, ranFiles: null, failures: [], truncated: false, ran: 0 }
    const first = await runProject(entry, workspace, project, mode, timeoutMs)
    if (first.kind === 'error') {
      return { outcome: { ...empty, result: { ...base, error: first.error } }, cancelled: !!first.cancelled }
    }
    const report = first.report
    let failures: TestFailure[] = report.failures.map((f) => {
      const id = `${project.id}|${f.id}`
      const unreachable = unreachableTarget(f.message)
      return { ...f, id, project: project.id, isNew: !unreachable && before !== null && !before.has(id), flaky: false, unreachable }
    })
    const files = [...new Set(failures.map((f) => f.file))]
    if (
      retry &&
      failures.length > 0 &&
      !report.failuresTruncated &&
      runsFiles(project.runner) &&
      files.length <= MAX_RETRY_FILES &&
      !entry.cancelled
    ) {
      const again = await runProject(entry, workspace, project, { scope: 'files', files: relativeTo(project, files) }, timeoutMs)
      if (again.kind === 'error' && again.cancelled) {
        return { outcome: { ...empty, result: base }, cancelled: true }
      }
      // A capped re-run cannot say what did not fail again.
      if (again.kind === 'report' && !again.report.failuresTruncated) {
        failures = markFlaky(failures, new Set(again.report.failures.map((f) => `${project.id}|${f.id}`)))
        failures = failures.map((f) => (f.flaky ? { ...f, isNew: false } : f))
      }
    }
    const flaky = failures.filter((f) => f.flaky).length
    return {
      outcome: {
        project,
        ranFiles: mode.scope === 'all' ? null : Object.keys(report.files),
        result: {
          ...base,
          passed: report.passed,
          failed: report.failed - flaky,
          skipped: report.skipped,
          flaky,
          // Past this many files the counts would crowd storage; partial runs then use run totals.
          ...(Object.keys(report.files).length <= MAX_TRACKED_FILES ? { files: report.files } : {})
        },
        failures,
        truncated: report.failuresTruncated,
        ran: report.total
      },
      cancelled: false
    }
  }

  async function run(
    workspace: Workspace,
    scope: RunScope,
    trigger: RunTrigger,
    options: { project?: string; agents?: string[] } = {}
  ): Promise<void> {
    if (active.has(workspace.id)) {
      if (trigger === 'agent-done') {
        rerunQueued.add(workspace.id)
        return
      }
      throw hostError('conflict', t().errAlreadyRunning)
    }
    if (!isLocal(workspace)) {
      throw hostError('not_permitted', t().errNotLocal)
    }
    const found = discover(workspace, true)
    if (found.kind === 'config-error') {
      throw hostError('invalid_params', found.message)
    }
    if (found.projects.length === 0) {
      throw hostError('invalid_params', t().errNoRunner)
    }
    // Claim the slot before the first await, so a second request cannot start a second run.
    const entry: ActiveRun = { handle: null, cancelled: false, startedAt: Date.now(), scope, trigger, project: null, done: 0, total: 0 }
    active.set(workspace.id, entry)
    const release = () => {
      if (active.get(workspace.id) === entry) {
        active.delete(workspace.id)
      }
    }
    const drainQueue = () => {
      if (rerunQueued.delete(workspace.id)) {
        scheduleAutoRun(workspace.id)
      }
    }

    let previous: Saved
    let planned: { plan: { project: ProjectSpec; mode: RunMode }[]; scope: RunScope; changed: number | null }
    let signature: string | null
    let head: string | null
    try {
      previous = await load(workspace.id)
      ;[signature, head] = await Promise.all([workspaceSignature(workspace.path), headCommit(workspace.path)])
      planned = await planRun(workspace, found.projects, scope, trigger, previous, options.project)
    } catch (error) {
      release()
      void broadcast()
      drainQueue()
      throw error
    }
    if (planned.plan.length === 0) {
      release()
      if (trigger === 'agent-done') {
        // Nothing related changed: remember this state, so the next unchanged turn is skipped.
        await store(workspace.id, { ...previous, signature, head })
        await broadcast()
        drainQueue()
        return
      }
      void broadcast()
      throw hostError('invalid_params', scope === 'failed' ? t().errNoFailing : t().errNoTests)
    }

    entry.scope = planned.scope
    entry.total = planned.plan.length
    const timeoutMs = Math.max(1, await setting('timeoutMinutes', 10)) * 60_000
    const retry = await setting('retryFailures', true)
    // New: not failing in the state before. Without a complete state before, nothing is new.
    const before = previous.run && !previous.run.failuresTruncated ? new Set(failureIds(previous.run)) : null
    orca.log(`${planned.scope} run started in ${workspace.name} (${trigger}): ${planned.plan.map((p) => p.project.name).join(', ')}`)
    void broadcast()

    void (async () => {
      try {
        const outcomes: ProjectOutcome[] = []
        for (const step of planned.plan) {
          if (entry.cancelled) {
            break
          }
          entry.project = step.project.name
          void broadcast()
          const { outcome, cancelled } = await testProject(entry, workspace, step.project, step.mode, timeoutMs, retry, before)
          if (cancelled) {
            entry.cancelled = true
            break
          }
          entry.done += 1
          outcomes.push(outcome)
        }
        if (entry.cancelled) {
          orca.log(`run cancelled in ${workspace.name}`)
          return
        }
        const result = mergeRun(
          previous.run,
          outcomes,
          found.projects.map((p) => p.id),
          { scope: planned.scope, trigger, startedAt: entry.startedAt, finishedAt: Date.now(), changedFiles: planned.changed }
        )
        // Only a clean run over every auto-run project vouches for this state of the code.
        const covering = trigger === 'agent-done' || (scope === 'all' && !options.project)
        const vouch = covering && outcomes.every((o) => !o.result.error)
        await store(workspace.id, { run: result, signature: vouch ? signature : previous.signature, head: vouch ? head : previous.head })
        orca.log(`run finished in ${workspace.name}: ${result.ran} ran; ${result.passed} passed, ${result.failed} failed, ${result.flaky} flaky`)
        await notifyAfterAutoRun(workspace, result, previous.run)
        if (trigger === 'agent-done') {
          const observed = new Set(outcomes.flatMap((o) => o.failures.map((f) => f.id)))
          await autoFix(workspace, result, previous.run, observed, options.agents ?? []).catch((error) =>
            orca.log(`auto-fix skipped: ${String(error)}`)
          )
        } else {
          loops.delete(workspace.id)
        }
      } catch (error) {
        orca.log(`run failed in ${workspace.name}: ${String(error)}`)
      } finally {
        release()
        await broadcast()
        if (!entry.cancelled) {
          drainQueue()
        }
      }
    })()
  }

  /** Which projects run, and how, for this request; `scope` is what the run will really cover. */
  async function planRun(
    workspace: Workspace,
    projects: ProjectSpec[],
    scope: RunScope,
    trigger: RunTrigger,
    previous: Saved,
    only: string | undefined
  ): Promise<{ plan: { project: ProjectSpec; mode: RunMode }[]; scope: RunScope; changed: number | null }> {
    if (scope === 'failed') {
      const failing = previous.run?.failures ?? []
      const plan = projects
        .filter((p) => failing.some((f) => f.project === p.id) && (!only || p.id === only))
        .map((project) => {
          const files = [...new Set(failing.filter((f) => f.project === project.id).map((f) => f.file))]
          const mode: RunMode = runsFiles(project.runner) ? { scope: 'files', files: relativeTo(project, files) } : { scope: 'all' }
          return { project, mode }
        })
      return { plan, scope, changed: null }
    }
    if (trigger === 'manual') {
      return { plan: projects.filter((p) => !only || p.id === only).map((project) => ({ project, mode: { scope: 'all' } })), scope: 'all', changed: null }
    }
    const auto = projects.filter((p) => p.autoRun)
    if (scope === 'related') {
      const since = previous.run?.startedAt ?? null
      const changes = await changedFiles(workspace.path, previous.head, since)
      if (changes !== null && changes.files.length <= MAX_RELATED_FILES) {
        const plan = auto.flatMap((project) => {
          const mode = planForChanges(project, changes, workspace.path)
          return mode ? [{ project, mode }] : []
        })
        return { plan, scope: 'related', changed: changes.files.length }
      }
    }
    // Not a git folder, no earlier run to diff against, or too many changes: run everything.
    return { plan: auto.map((project) => ({ project, mode: { scope: 'all' } })), scope: 'all', changed: null }
  }

  /** Sends failures the agent's turns caused back to the agent that just finished, at most
   *  `autoFixMaxRounds` times. Only failures this run saw; never to another agent. */
  async function autoFix(workspace: Workspace, run: TestRun, previous: TestRun | null, observed: ReadonlySet<string>, agents: string[]) {
    if (!(await setting('autoFix', false))) {
      return
    }
    const max = Math.max(1, await setting('autoFixMaxRounds', 3))
    const loop = loops.get(workspace.id) ?? { round: 0, baseline: failureIds(previous), stopNotified: false }
    const baseline = new Set(loop.baseline)
    const caused = run.failures.filter((f) => !f.flaky && !f.unreachable && !baseline.has(f.id))
    if (caused.length === 0) {
      loops.delete(workspace.id)
      return
    }
    loops.set(workspace.id, loop)
    const seenNow = caused.filter((f) => observed.has(f.id))
    if (seenNow.length === 0) {
      // This turn's run did not reach them: nothing new to say about them.
      return
    }
    if (loop.round >= max) {
      if (!loop.stopNotified) {
        loop.stopNotified = true
        await notify(t().notifyAutoFixStop(max, workspace.name), t().notifyAutoFixStopBody)
      }
      return
    }
    if (agents.length === 0) {
      return
    }
    const { agents: live } = await orca.host.call('agents.list', { workspaceId: workspace.id })
    const target = [...agents]
      .reverse()
      .map((terminalId) => live.find((a) => a.terminalId === terminalId))
      .find((a) => a && (a.state === 'done' || a.state === 'waiting'))
    if (!target?.terminalId) {
      // The agent that finished is busy again: never type into it, or into another one.
      return
    }
    loop.round += 1
    const prompt = promptForFailures(promptProjects(workspace), seenNow, `(Test Runner, automatic round ${loop.round} of ${max})`)
    const sent = await orca.host.call('terminal.sendText', { terminalId: target.terminalId, text: prompt, enter: true })
    if (sent.accepted) {
      await notify(t().notifyAutoFix(seenNow.length, agentName(target), loop.round, max), '')
    }
  }

  function promptProjects(workspace: Workspace): Map<string, PromptProject> {
    const found = discover(workspace)
    const projects = found.kind === 'ok' ? found.projects : []
    return new Map(projects.map((p) => [p.id, { id: p.id, root: p.root, runner: p.runner }]))
  }

  function scheduleAutoRun(workspaceId: string): void {
    clearTimeout(autoTimers.get(workspaceId))
    autoTimers.set(
      workspaceId,
      setTimeout(() => {
        autoTimers.delete(workspaceId)
        const agents = finishedAgents.get(workspaceId) ?? []
        finishedAgents.delete(workspaceId)
        void autoRun(workspaceId, agents).catch((error) => orca.log(`auto run skipped: ${String(error)}`))
      }, AGENT_DONE_DEBOUNCE_MS)
    )
  }

  async function autoRun(workspaceId: string, agents: string[]): Promise<void> {
    if (!(await setting('autoRunWhenAgentFinishes', true))) {
      return
    }
    const workspace = await byId(workspaceId)
    if (!workspace || !isLocal(workspace)) {
      return
    }
    const found = discover(workspace, true)
    if (found.kind !== 'ok' || !found.projects.some((p) => p.autoRun)) {
      return
    }
    if (active.has(workspace.id)) {
      // Keep who finished for the run queued behind this one.
      finishedAgents.set(workspace.id, [...agents, ...(finishedAgents.get(workspace.id) ?? [])])
      rerunQueued.add(workspace.id)
      return
    }
    // Why: an agent that only answered a question changed nothing; re-running would be noise.
    const signature = await workspaceSignature(workspace.path)
    const last = await load(workspace.id)
    if (signature !== null && signature === last.signature) {
      return
    }
    const scope = found.autoRunScope ?? (await setting<'related' | 'all'>('autoRunScope', 'related'))
    await run(workspace, scope, 'agent-done', { agents })
  }

  function agentName(agent: { agent: string | null; title: string | null }): string {
    return (agent.agent && AGENT_NAMES[agent.agent]) || agent.agent || agent.title || t().theAgent
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Waits until Orca lists the terminal's agent as idle: it can take a prompt then. */
  async function waitUntilReady(workspaceId: string, terminalId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { agents } = await orca.host.call('agents.list', { workspaceId }).catch(() => ({ agents: [] }))
      const agent = agents.find((a) => a.terminalId === terminalId)
      if (agent && (agent.state === 'done' || agent.state === 'waiting')) {
        // The agent reports itself a moment before its input box draws.
        await sleep(500)
        return true
      }
      await sleep(500)
    }
    return false
  }

  async function askAgent(workspace: Workspace, prompt: string, count: number): Promise<AskAgentResult> {
    const { agents } = await orca.host.call('agents.list', { workspaceId: workspace.id })
    const withTerminal = agents.filter((agent) => agent.terminalId)
    // Why not blocked or working: typing would answer a permission prompt or interrupt a turn.
    const idle = withTerminal.find((agent) => agent.state === 'done' || agent.state === 'waiting')
    if (idle?.terminalId) {
      const sent = await orca.host.call('terminal.sendText', { terminalId: idle.terminalId, text: prompt, enter: true })
      if (!sent.accepted) {
        throw hostError('action_failed', t().errNotAccepted)
      }
      await orca.host.call('terminal.focus', { terminalId: idle.terminalId }).catch(() => undefined)
      return { via: 'terminal', agent: agentName(idle), sent: count }
    }
    if (withTerminal.length > 0) {
      throw hostError('conflict', t().errBusy)
    }
    const agent = String(await setting('agent', 'claude'))
    if (!LAUNCHABLE_AGENTS.has(agent)) {
      throw hostError('invalid_params', t().errUnknownAgent(agent))
    }
    const name = AGENT_NAMES[agent] ?? agent
    // Why not agent.launch's own prompt: Orca checks the terminal runs an agent right after
    // starting it, before the agent is up, and drops the prompt. Start it, wait, then type.
    const launched = await orca.host.call('agent.launch', { workspaceId: workspace.id, agent })
    await orca.host.call('terminal.focus', { terminalId: launched.terminalId }).catch(() => undefined)
    if (!(await waitUntilReady(workspace.id, launched.terminalId, LAUNCH_READY_MS))) {
      throw hostError('action_failed', t().errNotReady(name))
    }
    const sent = await orca.host.call('terminal.sendText', { terminalId: launched.terminalId, text: prompt, enter: true })
    if (!sent.accepted) {
      throw hostError('action_failed', t().errNotAccepted)
    }
    return { via: 'launch', agent: name, sent: count }
  }

  orca.events.on('workspace.changed', ({ context }) => {
    const next = context?.workspaceId ?? null
    if (next !== focusedId) {
      focusedId = next
      void broadcast()
    }
  })

  orca.events.on('agent.status.changed', (payload) => {
    const workspaceId = payload.workspaceListId ?? payload.workspaceId
    if (payload.state !== 'done' || !workspaceId) {
      return
    }
    // A turn the person stopped is not one to answer with failures; its tests still run.
    const outcome = payload.mainAgent?.outcome
    if (payload.terminalId && outcome !== 'interruption' && outcome !== 'cancellation') {
      const list = (finishedAgents.get(workspaceId) ?? []).filter((id) => id !== payload.terminalId)
      finishedAgents.set(workspaceId, [...list, payload.terminalId])
    }
    scheduleAutoRun(workspaceId)
  })

  orca.settings.onDidChange(() => void broadcast())

  orca.panels.handle('tests.state', async (input) => {
    if (input?.locale) {
      const next = localeOf(input.locale)
      if (next !== locale) {
        locale = next
        statusBar = ''
        void orca.storage.set('locale', next).catch(() => undefined)
      }
    }
    if (focusedId === null) {
      const context = await orca.host.call('workspace.readContext', {}).catch(() => null)
      focusedId = context?.workspaceId ?? null
    }
    if (focusedId) {
      discoveries.delete(focusedId)
    }
    const state = await panelState()
    void updateStatusBar(state)
    return state
  })

  orca.panels.handle('tests.run', async ({ workspaceKey: key, scope, project }) => {
    await run(await byKey(key), scope, 'manual', { project })
    return panelState()
  })

  orca.panels.handle('tests.cancel', async ({ workspaceKey: key }) => {
    const workspace = await byKey(key)
    rerunQueued.delete(workspace.id)
    finishedAgents.delete(workspace.id)
    clearTimeout(autoTimers.get(workspace.id))
    autoTimers.delete(workspace.id)
    const entry = active.get(workspace.id)
    if (entry) {
      entry.cancelled = true
      entry.handle?.cancel()
    }
    return panelState()
  })

  orca.panels.handle('tests.openFile', async ({ workspaceKey: key, failureId }) => {
    const workspace = await byKey(key)
    const failure = (await load(workspace.id)).run?.failures.find((row) => row.id === failureId)
    if (!failure || failure.file.startsWith('/') || /^[A-Za-z]:/.test(failure.file)) {
      throw hostError('invalid_params', t().errNotInWorkspace)
    }
    await orca.host.call('editor.open', { workspaceId: workspace.id, path: failure.file })
    return { opened: true }
  })

  orca.panels.handle('tests.askAgent', async ({ workspaceKey: key, failureId, onlyNew }) => {
    const workspace = await byKey(key)
    const last = (await load(workspace.id)).run
    const all = last?.failures ?? []
    const fixable = all.filter((f) => !f.flaky && !f.unreachable)
    const failures = failureId
      ? all.filter((row) => row.id === failureId)
      : onlyNew
        ? fixable.filter((f) => f.isNew)
        : fixable.length
          ? fixable
          : all.filter((f) => !f.unreachable)
    if (failures.length === 0) {
      const onlyUnreachable = all.length > 0 && all.every((f) => f.unreachable || f.flaky) && all.some((f) => f.unreachable)
      throw hostError('invalid_params', onlyNew ? t().errNoNew : onlyUnreachable ? t().errOnlyUnreachable : t().errNoFailure)
    }
    return askAgent(workspace, promptForFailures(promptProjects(workspace), failures), failures.length)
  })

  orca.panels.handle('tests.setAutoRun', async ({ enabled }) => {
    await orca.settings.set('autoRunWhenAgentFinishes', enabled)
    return panelState()
  })

  orca.panels.handle('tests.setAutoFix', async ({ enabled }) => {
    await orca.settings.set('autoFix', enabled)
    loops.clear()
    return panelState()
  })

  orca.commands.register('run-tests', async () => {
    const workspace = focusedId ? await byId(focusedId) : null
    if (!workspace) {
      throw hostError('invalid_params', t().openWorkspaceFirst)
    }
    if (active.has(workspace.id)) {
      return t().barRunning
    }
    await run(workspace, 'all', 'manual')
    return `${t().barRunning} ${workspace.name}`
  })

  // The worker runs from the moment the plugin is enabled (it has a status bar item): show the
  // focused workspace's last result right away, and forget workspaces that are gone.
  void (async () => {
    const context = await orca.host.call('workspace.readContext', {}).catch(() => null)
    focusedId ??= context?.workspaceId ?? null
    await broadcast()
    await pruneStorage().catch((error) => orca.log(`could not prune storage: ${String(error)}`))
  })()
}

export function deactivate(): void {
  stopAll()
}
