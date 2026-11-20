// The plugin's worker: follows the focused workspace, runs its tests, re-runs them when an agent
// in a workspace finishes, and hands failures to that workspace's agent.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { promptForFailures } from './agent-prompt'
import type {
  AskAgentResult,
  PanelState,
  RunScope,
  RunTrigger,
  TestFailure,
  TestRun,
  WorkspaceSupport
} from './protocol'
import { detectRunner, type DetectedRunner } from './runner/detect'
import { startRun, type RunHandle } from './runner/run'
import { workspaceSignature } from './workspace-signature'

type Workspace = { id: string; name: string; branch: string; path: string; hostId: string | null }
/** `handle` is null while the run is being prepared; the slot is already taken. */
type ActiveRun = {
  handle: RunHandle | null
  cancelled: boolean
  startedAt: number
  scope: RunScope
  trigger: RunTrigger
}
/** What one workspace keeps in storage. */
type Saved = { run: TestRun | null; signature: string | null }

const STORAGE_PREFIX = 'ws:'
const AGENT_DONE_DEBOUNCE_MS = 3000
const WORKSPACE_CACHE_MS = 10_000
/** Orca stops a worker after 5 min without host traffic; a post every minute keeps a long run. */
const KEEP_ALIVE_MS = 60_000
/** Posts and stored values are capped at 256 KiB (UTF-8); stay well under. */
const MAX_PAYLOAD_BYTES = 200_000
const LAUNCHABLE_AGENTS = new Set(['claude', 'codex', 'gemini', 'opencode', 'cursor', 'copilot'])

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
    next = { ...next, failures: shorten(next.failures, 200), error: next.error?.slice(0, 4000) ?? null }
  }
  return next
}

function failureSet(run: TestRun | null | undefined): string {
  return (run?.failures ?? []).map((f) => f.id).sort().join('\n')
}

/** Runs are detached process groups, so they outlive the worker unless stopped here. */
let stopAll: () => void = () => {}

export default function activate(orca: OrcaWorkerApi): void {
  let focusedId: string | null = null
  let workspaces: { at: number; rows: Workspace[] } | null = null
  const saved = new Map<string, Saved>()
  const active = new Map<string, ActiveRun>()
  const autoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const rerunQueued = new Set<string>()
  const runners = new Map<string, DetectedRunner | null>()
  let keepAlive: ReturnType<typeof setInterval> | null = null

  stopAll = () => {
    for (const timer of autoTimers.values()) {
      clearTimeout(timer)
    }
    if (keepAlive) {
      clearInterval(keepAlive)
    }
    for (const entry of active.values()) {
      entry.cancelled = true
      entry.handle?.cancel()
    }
  }

  async function load(id: string): Promise<Saved> {
    const cached = saved.get(id)
    if (cached) {
      return cached
    }
    const stored = (await orca.storage.get(STORAGE_PREFIX + workspaceKey(id)).catch(() => null)) as Saved | null
    const value: Saved = stored && typeof stored === 'object' ? { run: stored.run ?? null, signature: stored.signature ?? null } : { run: null, signature: null }
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
      throw hostError('invalid_params', 'That workspace is no longer open.')
    }
    return workspace
  }

  function isLocal(workspace: Workspace): boolean {
    return (workspace.hostId === null || workspace.hostId === 'local') && existsSync(workspace.path)
  }

  function runnerFor(workspace: Workspace, fresh = false): DetectedRunner | null {
    // Why re-detect when absent: the person may install vitest after the panel first looked.
    const known = fresh ? null : runners.get(workspace.id)
    if (known) {
      return known
    }
    const detected = detectRunner(workspace.path)
    runners.set(workspace.id, detected)
    return detected
  }

  function support(workspace: Workspace | null): WorkspaceSupport {
    if (!workspace) {
      return { kind: 'no-workspace' }
    }
    if (!isLocal(workspace)) {
      return { kind: 'remote' }
    }
    const runner = runnerFor(workspace)
    return runner ? { kind: 'ok', runner: runner.kind } : { kind: 'no-runner' }
  }

  async function panelState(): Promise<PanelState> {
    const workspace = focusedId ? await byId(focusedId) : null
    const running = workspace ? active.get(workspace.id) : undefined
    return {
      workspaceKey: workspace ? workspaceKey(workspace.id) : null,
      workspace: workspace ? { name: workspace.name, branch: workspace.branch } : null,
      support: support(workspace),
      running: running
        ? { startedAt: running.startedAt, scope: running.scope, trigger: running.trigger }
        : null,
      lastRun: workspace ? fitRun((await load(workspace.id)).run) : null,
      autoRun: await setting('autoRunWhenAgentFinishes', true)
    }
  }

  async function broadcast(): Promise<void> {
    try {
      orca.panels.post('tests.changed', await panelState())
    } catch (error) {
      orca.log(`could not update panels: ${String(error)}`)
    }
  }

  function updateKeepAlive(): void {
    if (active.size > 0 && !keepAlive) {
      keepAlive = setInterval(() => void broadcast(), KEEP_ALIVE_MS)
    } else if (active.size === 0 && keepAlive) {
      clearInterval(keepAlive)
      keepAlive = null
    }
  }

  async function notifyAfterAutoRun(workspace: Workspace, run: TestRun, previous: TestRun | null) {
    if (run.trigger !== 'agent-done' || !(await setting('notifyOnFailure', true))) {
      return
    }
    const wasFailing = previous ? previous.failed > 0 || previous.error !== null : false
    let title: string | null = null
    let body = ''
    if (run.error) {
      if (previous?.error === run.error) {
        return
      }
      title = `Tests could not run in ${workspace.name}`
      body = run.error.split('\n')[0]?.slice(0, 200) ?? ''
    } else if (run.failed > 0) {
      // Why: the same failures after every agent turn would be noise.
      if (wasFailing && !previous?.error && failureSet(previous) === failureSet(run)) {
        return
      }
      title = `${run.failed} failing test${run.failed === 1 ? '' : 's'} in ${workspace.name}`
      body = `${run.passed} passed after the agent finished. Open Test Runner to send them back.`
    } else if (wasFailing) {
      title = `Tests pass again in ${workspace.name}`
      body = `All ${run.passed} tests passed.`
    }
    if (title) {
      await orca.host.call('notifications.show', { title, body }).catch(() => undefined)
    }
  }

  async function run(workspace: Workspace, scope: RunScope, trigger: RunTrigger): Promise<void> {
    if (active.has(workspace.id)) {
      if (trigger === 'agent-done') {
        rerunQueued.add(workspace.id)
        return
      }
      throw hostError('conflict', 'Tests are already running in this workspace.')
    }
    if (!isLocal(workspace)) {
      throw hostError('not_permitted', 'Test Runner runs tests only in workspaces on this computer.')
    }
    const runner = runnerFor(workspace, true)
    if (!runner) {
      throw hostError('invalid_params', 'No vitest or jest found in this workspace.')
    }
    // Claim the slot before the first await, so a second request cannot start a second run.
    const entry: ActiveRun = { handle: null, cancelled: false, startedAt: Date.now(), scope, trigger }
    active.set(workspace.id, entry)
    updateKeepAlive()
    const release = () => {
      if (active.get(workspace.id) === entry) {
        active.delete(workspace.id)
      }
      updateKeepAlive()
    }

    let previous: Saved
    let signature: string | null
    let timeoutMs: number
    let handle: RunHandle
    try {
      previous = await load(workspace.id)
      const files =
        scope === 'failed' ? [...new Set((previous.run?.failures ?? []).map((failure) => failure.file))] : []
      if (scope === 'failed' && files.length === 0) {
        throw hostError('invalid_params', 'There are no failing tests to re-run.')
      }
      signature = scope === 'all' ? await workspaceSignature(workspace.path) : null
      timeoutMs = Math.max(1, await setting('timeoutMinutes', 10)) * 60_000
      if (entry.cancelled) {
        release()
        void broadcast()
        return
      }
      handle = startRun(workspace.path, runner, files, timeoutMs)
      entry.handle = handle
    } catch (error) {
      release()
      void broadcast()
      throw error
    }
    orca.log(`${runner.kind} ${scope} run started in ${workspace.name} (${trigger})`)
    void broadcast()

    void handle.done.then(async (outcome) => {
      release()
      if (outcome.kind === 'error' && outcome.cancelled) {
        // A cancelled run keeps the previous result on screen.
        orca.log(`${runner.kind} run cancelled in ${workspace.name}`)
        await broadcast()
        return
      }
      const base = { runner: runner.kind, scope, trigger, startedAt: entry.startedAt, finishedAt: Date.now() }
      const result: TestRun =
        outcome.kind === 'report'
          ? { ...base, ...outcome.report, error: null }
          : { ...base, passed: 0, failed: 0, skipped: 0, total: 0, failures: [], failuresTruncated: false, error: outcome.error }
      // Only a full run that produced a report vouches for this state of the code.
      const nextSignature = scope === 'all' && outcome.kind === 'report' ? signature : previous.signature
      await store(workspace.id, { run: result, signature: nextSignature })
      await notifyAfterAutoRun(workspace, result, previous.run)
      orca.log(
        `${runner.kind} run finished in ${workspace.name}: ` +
          (result.error ? `error: ${result.error.split('\n')[0]}` : `${result.passed} passed, ${result.failed} failed`)
      )
      await broadcast()
      if (rerunQueued.delete(workspace.id)) {
        scheduleAutoRun(workspace.id)
      }
    })
  }

  function scheduleAutoRun(workspaceId: string): void {
    clearTimeout(autoTimers.get(workspaceId))
    autoTimers.set(
      workspaceId,
      setTimeout(() => {
        autoTimers.delete(workspaceId)
        void autoRun(workspaceId).catch((error) => orca.log(`auto run skipped: ${String(error)}`))
      }, AGENT_DONE_DEBOUNCE_MS)
    )
  }

  async function autoRun(workspaceId: string): Promise<void> {
    if (!(await setting('autoRunWhenAgentFinishes', true))) {
      return
    }
    const workspace = await byId(workspaceId)
    if (!workspace || !isLocal(workspace) || !runnerFor(workspace)) {
      return
    }
    if (active.has(workspace.id)) {
      rerunQueued.add(workspace.id)
      return
    }
    // Why: an agent that only answered a question changed nothing; re-running would be noise.
    const signature = await workspaceSignature(workspace.path)
    const last = await load(workspace.id)
    if (signature !== null && signature === last.signature) {
      return
    }
    await run(workspace, 'all', 'agent-done')
  }

  async function askAgent(workspace: Workspace, prompt: string): Promise<AskAgentResult> {
    const { agents } = await orca.host.call('agents.list', { workspaceId: workspace.id })
    const withTerminal = agents.filter((agent) => agent.terminalId)
    // Why not blocked or working: typing would answer a permission prompt or interrupt a turn.
    const idle = withTerminal.find((agent) => agent.state === 'done' || agent.state === 'waiting')
    if (idle?.terminalId) {
      const sent = await orca.host.call('terminal.sendText', {
        terminalId: idle.terminalId,
        text: prompt,
        enter: true
      })
      if (!sent.accepted) {
        throw hostError('action_failed', 'The agent terminal did not accept the prompt.')
      }
      await orca.host.call('terminal.focus', { terminalId: idle.terminalId }).catch(() => undefined)
      return { via: 'terminal', agent: idle.title ?? idle.agent }
    }
    if (withTerminal.length > 0) {
      throw hostError('conflict', 'The agent in this workspace is busy. Try again when it finishes.')
    }
    const agent = String(await setting('agent', 'claude'))
    if (!LAUNCHABLE_AGENTS.has(agent)) {
      throw hostError('invalid_params', `Unknown agent "${agent}" in Test Runner settings.`)
    }
    const launched = await orca.host.call('agent.launch', { workspaceId: workspace.id, agent, prompt })
    await orca.host.call('terminal.focus', { terminalId: launched.terminalId }).catch(() => undefined)
    return { via: 'launch', agent }
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
    if (payload.state === 'done' && workspaceId) {
      scheduleAutoRun(workspaceId)
    }
  })

  orca.settings.onDidChange(() => void broadcast())

  orca.panels.handle('tests.state', async () => {
    if (focusedId === null) {
      const context = await orca.host.call('workspace.readContext', {}).catch(() => null)
      focusedId = context?.workspaceId ?? null
    }
    return panelState()
  })

  orca.panels.handle('tests.run', async ({ workspaceKey: key, scope }) => {
    await run(await byKey(key), scope, 'manual')
    return panelState()
  })

  orca.panels.handle('tests.cancel', async ({ workspaceKey: key }) => {
    const workspace = await byKey(key)
    rerunQueued.delete(workspace.id)
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
      throw hostError('invalid_params', 'That file is not inside this workspace.')
    }
    await orca.host.call('editor.open', { workspaceId: workspace.id, path: failure.file })
    return { opened: true }
  })

  orca.panels.handle('tests.askAgent', async ({ workspaceKey: key, failureId }) => {
    const workspace = await byKey(key)
    const last = (await load(workspace.id)).run
    const failures = failureId
      ? (last?.failures.filter((row) => row.id === failureId) ?? [])
      : (last?.failures ?? [])
    if (!last || failures.length === 0) {
      throw hostError('invalid_params', 'There is no failure to send.')
    }
    return askAgent(workspace, promptForFailures(last.runner, failures))
  })

  orca.panels.handle('tests.setAutoRun', async ({ enabled }) => {
    await orca.settings.set('autoRunWhenAgentFinishes', enabled)
    return panelState()
  })

  orca.commands.register('run-tests', async () => {
    const workspace = focusedId ? await byId(focusedId) : null
    if (!workspace) {
      throw hostError('invalid_params', 'Open a workspace first.')
    }
    await run(workspace, 'all', 'manual')
    return `Running tests in ${workspace.name}. Open the Test Runner panel to see the results.`
  })
}

export function deactivate(): void {
  stopAll()
}
