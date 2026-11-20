// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Callout,
  CodeView,
  Collapsible,
  EmptyState,
  Heading,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  type PanelContext
} from 'orca'
import type { PanelState, RunScope, TestFailure, TestRun } from './protocol'

/** What the worker last reported; null until it answers. */
const state = atom<PanelState | null>(null)
/** The outcome of the last button the person pressed. */
const notice = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)
/** A request in flight, so its button cannot be pressed twice. */
const busy = atom<string | null>(null)

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
    throw new Error('Open a workspace first.')
  }
  return key
}

const runTests = (scope: RunScope) =>
  act(`run:${scope}`, async () => {
    set(state, await plugin.request('tests.run', { workspaceKey: shownKey(), scope }))
    return null
  })

const cancel = () =>
  act('cancel', async () => {
    set(state, await plugin.request('tests.cancel', { workspaceKey: shownKey() }))
    return null
  })

const openFile = (failure: TestFailure) =>
  act(`open:${failure.id}`, async () => {
    await plugin.request('tests.openFile', { workspaceKey: shownKey(), failureId: failure.id })
    return null
  })

const askAgent = (failure?: TestFailure) =>
  act(`ask:${failure?.id ?? 'all'}`, async () => {
    const answer = await plugin.request(
      'tests.askAgent',
      failure ? { workspaceKey: shownKey(), failureId: failure.id } : { workspaceKey: shownKey() }
    )
    const who = answer.agent ?? 'the agent'
    return answer.via === 'terminal' ? `Sent to ${who}.` : `Started ${who} with the failure.`
  })

const refresh = () =>
  act('refresh', async () => {
    set(state, await plugin.request('tests.state'))
    return null
  })

const setAutoRun = (enabled: boolean) =>
  act('auto', async () => {
    set(state, await plugin.request('tests.setAutoRun', { enabled }))
    return null
  })

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('tests.changed', (next) => set(state, next)))
  void plugin
    .request('tests.state')
    .then((next) => set(state, next))
    .catch((error) => set(notice, { tone: 'danger', text: errorText(error) }))
}

/** `14:32`: the same in every language, unlike a relative time that follows Orca's locale. */
function clock(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function seconds(run: TestRun): string {
  const ms = Math.max(0, run.finishedAt - run.startedAt)
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`
}

function Summary({ run }: { run: TestRun }) {
  const how = run.trigger === 'agent-done' ? 'after an agent finished' : 'run by you'
  const what = run.scope === 'failed' ? 'failed tests only' : 'all tests'
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        {run.failed > 0 ? <Badge tone="danger">{`${run.failed} failed`}</Badge> : null}
        <Badge tone="success">{`${run.passed} passed`}</Badge>
        {run.skipped > 0 ? <Badge tone="neutral">{`${run.skipped} skipped`}</Badge> : null}
      </Row>
      <Text muted size="xs">
        {`Finished ${clock(run.finishedAt)} · ${seconds(run)} · ${what}, ${how}`}
      </Text>
    </Stack>
  )
}

function Failure({ failure, first }: { failure: TestFailure; first: boolean }) {
  const pending = read(busy)
  return (
    <Collapsible
      title={failure.name}
      description={failure.line ? `${failure.file}:${failure.line}` : failure.file}
      defaultOpen={first}
    >
      <Stack gap="sm">
        <CodeView code={failure.message || '(no message)'} label="Failure message" wrap maxHeight="sm" />
        <Row gap="xs" wrap>
          <Button
            size="sm"
            icon="agent"
            disabled={pending !== null}
            onPress={() => askAgent(failure)}
            tooltip="Types this failure into the workspace's idle agent, or starts one"
          >
            Ask agent to fix
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="file"
            disabled={pending !== null}
            onPress={() => openFile(failure)}
          >
            Open file
          </Button>
        </Row>
      </Stack>
    </Collapsible>
  )
}

function Results({ run }: { run: TestRun }) {
  if (run.error) {
    return (
      <Callout tone="danger" title={`${run.runner} did not finish`} icon="error">
        <CodeView code={run.error} label="Runner output" wrap maxHeight="md" />
      </Callout>
    )
  }
  if (run.total === 0) {
    return <Callout tone="warning" title={`${run.runner} found no tests`} />
  }
  if (run.failed === 0) {
    return <Callout tone="success" icon="check" title={`All ${run.passed} tests passed`} />
  }
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={2}>Failures</Heading>
        {run.failures.length > 1 ? (
          <Button
            size="sm"
            variant="outline"
            icon="agent"
            disabled={read(busy) !== null}
            onPress={() => askAgent()}
          >
            Ask agent to fix all
          </Button>
        ) : null}
      </Row>
      <Stack gap="xs">
        {run.failures.map((failure, index) => (
          <Failure key={`f${index}`} failure={failure} first={index === 0} />
        ))}
      </Stack>
      {run.failuresTruncated ? (
        <Text muted size="xs">{`Showing the first ${run.failures.length} failures.`}</Text>
      ) : null}
    </Stack>
  )
}

export default function Panel() {
  const current = read(state)
  const message = read(notice)
  const pending = read(busy)

  if (!current) {
    return message ? (
      <Callout tone="danger" title="Test Runner could not start">
        <Text>{message.text}</Text>
      </Callout>
    ) : (
      <Spinner label="Loading" />
    )
  }
  if (current.support.kind === 'no-workspace') {
    return <EmptyState icon="folder" title="No workspace" description="Open a workspace to run its tests." />
  }
  if (current.support.kind === 'remote') {
    return (
      <EmptyState
        icon="cloud"
        title="Remote workspace"
        description="Test Runner runs tests in workspaces on this computer only, not over SSH yet."
      />
    )
  }
  if (current.support.kind === 'no-runner') {
    return (
      <EmptyState
        icon="search"
        title="No test runner found"
        description="Add vitest or jest to this workspace's package.json and install dependencies."
      >
        <Button variant="outline" icon="refresh" disabled={pending !== null} onPress={refresh}>
          Check again
        </Button>
      </EmptyState>
    )
  }

  const { running, lastRun } = current
  const hasFailures = (lastRun?.failures.length ?? 0) > 0
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Stack gap="none">
          <Heading>{current.workspace?.name ?? 'Workspace'}</Heading>
          {current.workspace?.branch ? (
            <Text muted size="xs" truncate>
              {current.workspace.branch}
            </Text>
          ) : null}
        </Stack>
        <Badge tone="accent">{current.support.runner}</Badge>
      </Row>

      <Row gap="xs" wrap>
        {running ? (
          <Button tone="danger" variant="outline" icon="stop" disabled={pending !== null} onPress={cancel}>
            Stop
          </Button>
        ) : null}
        {running ? null : (
          <Button icon="play" disabled={pending !== null} onPress={() => runTests('all')}>
            Run all
          </Button>
        )}
        {running ? null : (
          <Button
            variant="outline"
            icon="refresh"
            disabled={pending !== null || !hasFailures}
            onPress={() => runTests('failed')}
            tooltip="Runs only the files that failed last time"
          >
            Re-run failed
          </Button>
        )}
      </Row>

      <Switch
        label="Run when an agent finishes"
        checked={current.autoRun}
        disabled={pending === 'auto'}
        onChange={setAutoRun}
      />

      {message ? (
        <Callout tone={message.tone}>
          <Text>{message.text}</Text>
        </Callout>
      ) : null}

      {running ? (
        <Row gap="sm" align="center">
          <Spinner label="Running tests" labelHidden />
          <Text>
            {running.scope === 'failed' ? 'Re-running failed tests' : 'Running all tests'}
            {running.trigger === 'agent-done' ? ' after an agent finished' : ''} ·{' '}
            {`started ${clock(running.startedAt)}`}
          </Text>
        </Row>
      ) : null}

      {lastRun ? (
        <Stack gap="sm">
          {lastRun.error ? null : <Summary run={lastRun} />}
          <Results run={lastRun} />
        </Stack>
      ) : running ? null : (
        <EmptyState
          icon="play"
          title="No runs yet"
          description="Run the tests now, or let an agent finish and they run on their own."
        />
      )}
    </Stack>
  )
}
