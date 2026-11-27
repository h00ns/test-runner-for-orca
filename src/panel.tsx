// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  CodeView,
  Collapsible,
  EmptyState,
  env,
  Heading,
  plugin,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Switch,
  Table,
  Text,
  type PanelContext
} from 'orca'
import { localeOf, strings } from './i18n.ts'
import type { PanelState, ProjectInfo, TestFailure, TestRun } from './protocol.ts'

const s = strings(localeOf(env.locale))
const ALL = '*'

/** What the worker last reported; null until it answers. */
const state = atom<PanelState | null>(null)
/** The outcome of the last button the person pressed. */
const notice = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)
/** A request in flight, so its button cannot be pressed twice. */
const busy = atom<string | null>(null)
/** Which project "Run all" runs, in a monorepo. */
const selected = atom('project', ALL, { persist: 'workspace' })

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function act(key: string, action: () => Promise<string | null>): Promise<void> {
  set(busy, key)
  set(notice, null)
  try {
    const message = await action()
    if (message) {
      set(notice, { tone: 'success', text: message })
    }
  } catch (error) {
    set(notice, { tone: 'danger', text: errorText(error) })
  } finally {
    set(busy, null)
  }
}

/** The workspace the panel shows; every action names it, so a focus change cannot redirect it. */
function shownKey(): string {
  const key = read(state)?.workspaceKey
  if (!key) {
    throw new Error(s.openWorkspaceFirst)
  }
  return key
}

function selectedProject(): string | undefined {
  const current = read(state)
  const value = read(selected)
  const known = current?.support.kind === 'ok' && current.support.projects.some((p) => p.id === value)
  return value !== ALL && known ? value : undefined
}

const runTests = (scope: 'all' | 'failed') =>
  act(`run:${scope}`, async () => {
    const project = selectedProject()
    // Why not `project: undefined`: Orca checks request input is JSON, and undefined is not.
    set(state, await plugin.request('tests.run', { workspaceKey: shownKey(), scope, ...(project ? { project } : {}) }))
    return null
  })

const cancel = () =>
  act('cancel', async () => {
    set(state, await plugin.request('tests.cancel', { workspaceKey: shownKey() }))
    return null
  })

const refresh = () =>
  act('refresh', async () => {
    set(state, await plugin.request('tests.state', { locale: localeOf(env.locale) }))
    return null
  })

const openFile = (failure: TestFailure) =>
  act(`open:${failure.id}`, async () => {
    await plugin.request('tests.openFile', { workspaceKey: shownKey(), failureId: failure.id })
    return null
  })

const askAgent = (options: { failure?: TestFailure; onlyNew?: boolean }) =>
  act(`ask:${options.failure?.id ?? (options.onlyNew ? 'new' : 'all')}`, async () => {
    const answer = await plugin.request(
      'tests.askAgent',
      {
        workspaceKey: shownKey(),
        ...(options.failure ? { failureId: options.failure.id } : {}),
        ...(options.onlyNew ? { onlyNew: true } : {})
      },
      // Starting an agent and waiting for it to be ready can take most of a minute.
      { timeoutMs: 90_000 }
    )
    const who = answer.agent ?? s.theAgent
    return answer.via === 'terminal' ? s.sentTo(who, answer.sent) : s.startedAgent(who)
  })

const setAutoRun = (enabled: boolean) =>
  act('auto', async () => {
    set(state, await plugin.request('tests.setAutoRun', { enabled }))
    return null
  })

const setAutoFix = (enabled: boolean) =>
  act('autofix', async () => {
    set(state, await plugin.request('tests.setAutoFix', { enabled }))
    return null
  })

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('tests.changed', (next) => set(state, next)))
  void plugin
    .request('tests.state', { locale: localeOf(env.locale) })
    .then((next) => set(state, next))
    .catch((error) => set(notice, { tone: 'danger', text: errorText(error) }))
}

/** `14:32`: the same in every language, unlike a relative time. */
function clock(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function seconds(run: TestRun): string {
  const ms = Math.max(0, run.finishedAt - run.startedAt)
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
}

function Summary({ run }: { run: TestRun }) {
  const fresh = run.failures.filter((f) => f.isNew).length
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        {run.failed > 0 ? <Badge tone="danger">{s.failed(run.failed)}</Badge> : null}
        {fresh > 0 ? <Badge tone="accent">{s.isNew(fresh)}</Badge> : null}
        {run.flaky > 0 ? <Badge tone="warning">{s.flaky(run.flaky)}</Badge> : null}
        <Badge tone="success">{s.passed(run.passed)}</Badge>
        {run.skipped > 0 ? <Badge tone="neutral">{s.skipped(run.skipped)}</Badge> : null}
      </Row>
      <Text muted size="xs">
        {s.finished(clock(run.finishedAt), seconds(run), s.scope(run.scope, run.changedFiles), s.trigger(run.trigger))}
      </Text>
      {run.ran < run.total ? (
        <Text muted size="xs">
          {s.ranCount(run.ran)}
        </Text>
      ) : null}
    </Stack>
  )
}

function ProjectTable({ run }: { run: TestRun }) {
  return (
    <Table
      label={s.projects}
      columns={[
        { key: 'name', label: s.colProject, minWidth: 'sm' },
        { key: 'runner', label: s.colRunner, hideBelow: 'sm' },
        { key: 'passed', label: s.colPassed, align: 'end' },
        { key: 'failed', label: s.colFailed, align: 'end' }
      ]}
      rows={run.projects.map((p) => ({
        key: p.project,
        cells: { name: p.name, runner: p.runner, passed: p.passed, failed: p.error ? '!' : p.failed }
      }))}
      maxHeight="sm"
    />
  )
}

function Failure({ failure, first, projectName }: { failure: TestFailure; first: boolean; projectName: string | null }) {
  const pending = read(busy)
  const where = failure.line ? `${failure.file}:${failure.line}` : failure.file
  return (
    <Collapsible title={failure.name} description={projectName ? `${projectName} · ${where}` : where} defaultOpen={first}>
      <Stack gap="sm">
        {failure.isNew || failure.flaky || failure.unreachable ? (
          <Row gap="xs">
            {failure.isNew ? <Badge tone="accent">{s.newBadge}</Badge> : null}
            {failure.flaky ? <Badge tone="warning">{s.flakyBadge}</Badge> : null}
            {failure.unreachable ? <Badge tone="neutral">{s.unreachableBadge}</Badge> : null}
          </Row>
        ) : null}
        {failure.flaky ? (
          <Text muted size="xs">
            {s.flakyNote}
          </Text>
        ) : null}
        <CodeView code={failure.message || s.noMessage} label={s.failureMessage} wrap maxHeight="sm" />
        <Row gap="xs" wrap>
          {failure.unreachable ? null : (
            <Button size="sm" icon="agent" disabled={pending !== null} onPress={() => askAgent({ failure })} tooltip={s.askFixHint}>
              {s.askFix}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon="file" disabled={pending !== null} onPress={() => openFile(failure)}>
            {s.openFile}
          </Button>
        </Row>
      </Stack>
    </Collapsible>
  )
}

function Results({ run, projects }: { run: TestRun; projects: ProjectInfo[] }) {
  const pending = read(busy)
  const errors = run.projects.filter((p) => p.error)
  const names = new Map(projects.map((p) => [p.id, p.name]))
  const multi = projects.length > 1
  const real = run.failures.filter((f) => !f.flaky && !f.unreachable)
  const fresh = real.filter((f) => f.isNew)
  // Grouped by address: "12 tests could not reach http://localhost:3000".
  const unreachable = new Map<string, number>()
  for (const f of run.failures) {
    if (f.unreachable) {
      unreachable.set(f.unreachable, (unreachable.get(f.unreachable) ?? 0) + 1)
    }
  }
  return (
    <Stack gap="md">
      {multi && run.projects.length > 1 ? <ProjectTable run={run} /> : null}
      {errors.map((p) => (
        <Callout key={`e-${p.project}`} tone="danger" title={s.didNotFinish(p.name, p.runner)} icon="error">
          <CodeView code={p.error ?? ''} label={s.runnerOutput} wrap maxHeight="md" />
        </Callout>
      ))}
      {[...unreachable.entries()].map(([target, n]) => (
        <Callout key={`u-${target}`} tone="warning" title={s.unreachableBadge} icon="warning">
          <Text size="sm">{s.unreachableNote(n, target)}</Text>
        </Callout>
      ))}
      {run.ran === 0 && run.scope === 'related' && errors.length === 0 ? (
        <Callout tone="neutral" title={s.noTestsRan}>
          <Text muted size="sm">
            {s.noTestsRanBody}
          </Text>
        </Callout>
      ) : null}
      {run.total > 0 && run.failed === 0 && errors.length === 0 ? (
        <Callout tone="success" icon="check" title={s.allPassed(run.passed + run.flaky)} />
      ) : null}
      {run.failures.length > 0 ? (
        <Stack gap="sm">
          <Row justify="between" align="center" wrap>
            <Heading level={2}>{s.failures}</Heading>
            <Row gap="xs">
              {fresh.length > 0 && fresh.length < real.length ? (
                <Button size="sm" variant="ghost" icon="agent" disabled={pending !== null} onPress={() => askAgent({ onlyNew: true })}>
                  {s.askFixNew}
                </Button>
              ) : null}
              {real.length > 1 ? (
                <Button size="sm" variant="outline" icon="agent" disabled={pending !== null} onPress={() => askAgent({})}>
                  {s.askFixAll}
                </Button>
              ) : null}
            </Row>
          </Row>
          <Stack gap="xs">
            {run.failures.map((failure, index) => (
              <Failure
                key={failure.id}
                failure={failure}
                first={index === 0}
                projectName={multi ? (names.get(failure.project) ?? null) : null}
              />
            ))}
          </Stack>
          {run.failuresTruncated ? <Text muted size="xs">{s.truncated(run.failures.length)}</Text> : null}
        </Stack>
      ) : null}
    </Stack>
  )
}

function Header({ current }: { current: PanelState }) {
  const projects = current.support.kind === 'ok' ? current.support.projects : []
  const label = projects.length === 1 ? projects[0]!.runner : `${projects.length} ${s.projects.toLowerCase()}`
  return (
    <Row justify="between" align="center">
      <Stack gap="none">
        <Heading>{current.workspace?.name ?? ''}</Heading>
        {current.workspace?.branch ? (
          <Text muted size="xs" truncate>
            {current.workspace.branch}
          </Text>
        ) : null}
      </Stack>
      {projects.length ? <Badge tone="neutral">{label}</Badge> : null}
    </Row>
  )
}

export default function Panel() {
  const current = read(state)
  const message = read(notice)
  const pending = read(busy)

  if (!current) {
    return message ? (
      <Callout tone="danger" title={s.couldNotStart}>
        <Text>{message.text}</Text>
      </Callout>
    ) : (
      <Spinner label={s.loading} />
    )
  }
  const support = current.support
  if (support.kind === 'no-workspace') {
    return <EmptyState icon="folder" title={s.noWorkspace} description={s.noWorkspaceBody} />
  }
  if (support.kind === 'remote') {
    return <EmptyState icon="cloud" title={s.remote} description={s.remoteBody} />
  }
  if (support.kind === 'no-runner' || support.kind === 'config-error') {
    return (
      <Stack gap="md">
        {support.kind === 'config-error' ? (
          <Callout tone="danger" title={s.configError}>
            <Text size="sm">{support.message}</Text>
          </Callout>
        ) : (
          <EmptyState icon="search" title={s.noRunner} description={s.noRunnerBody} />
        )}
        <Row>
          <Button variant="outline" icon="refresh" disabled={pending !== null} onPress={refresh}>
            {s.checkAgain}
          </Button>
        </Row>
      </Stack>
    )
  }

  const { running, lastRun, autoFix } = current
  const projects = support.projects
  const hasFailures = (lastRun?.failures.length ?? 0) > 0
  return (
    <Stack gap="md">
      <Header current={current} />

      {projects.length > 1 ? (
        <Select
          label={s.project}
          labelHidden
          value={projects.some((p) => p.id === read(selected)) ? read(selected) : ALL}
          options={[
            { value: ALL, label: s.allProjects },
            ...projects.map((p) => ({ value: p.id, label: `${p.name} · ${p.runner}` }))
          ]}
          onChange={(value) => set(selected, value)}
        />
      ) : null}

      <Row gap="xs" wrap>
        {running ? (
          <Button tone="danger" variant="outline" icon="stop" disabled={pending !== null} onPress={cancel}>
            {s.stop}
          </Button>
        ) : null}
        {running ? null : (
          <Button icon="play" disabled={pending !== null} onPress={() => runTests('all')}>
            {s.runAll}
          </Button>
        )}
        {running ? null : (
          <Button
            variant="outline"
            icon="refresh"
            disabled={pending !== null || !hasFailures}
            onPress={() => runTests('failed')}
            tooltip={s.rerunFailedHint}
          >
            {s.rerunFailed}
          </Button>
        )}
      </Row>

      <Stack gap="xs">
        <Switch label={s.autoRun} checked={current.autoRun} disabled={pending === 'auto'} onChange={setAutoRun} />
        <Switch label={s.autoFix} checked={autoFix.enabled} disabled={pending === 'autofix' || !current.autoRun} onChange={setAutoFix} />
        {autoFix.enabled ? (
          <Text muted size="xs">
            {autoFix.round > 0 ? s.autoFixRound(autoFix.round, autoFix.maxRounds) : s.autoFixIdle(autoFix.maxRounds)}
          </Text>
        ) : null}
      </Stack>

      {message ? (
        <Callout tone={message.tone}>
          <Text>{message.text}</Text>
        </Callout>
      ) : null}

      {running ? (
        <Stack gap="xs">
          <Row gap="sm" align="center">
            <Spinner label={s.loading} labelHidden />
            <Text>{`${s.running(running.scope, running.trigger)} · ${s.started(clock(running.startedAt))}`}</Text>
          </Row>
          {running.project ? (
            <Text muted size="xs">
              {s.runningProject(running.project, Math.min(running.done + 1, running.total), running.total)}
            </Text>
          ) : null}
        </Stack>
      ) : null}

      {lastRun ? (
        <Stack gap="sm">
          {lastRun.total > 0 ? <Summary run={lastRun} /> : null}
          <Results run={lastRun} projects={projects} />
        </Stack>
      ) : running ? null : (
        <EmptyState icon="play" title={s.noRuns} description={s.noRunsBody} />
      )}

      {current.configFile ? (
        <Text muted size="xs">
          {s.configFooter}
        </Text>
      ) : null}
    </Stack>
  )
}
