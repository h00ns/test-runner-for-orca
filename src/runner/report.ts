// Reads the Jest-compatible JSON report that both `vitest --reporter=json` and `jest --json`
// write. Pure: no file system, so tests feed it plain objects.
import type { TestFailure } from '../protocol.ts'

/** A failure as a report states it; the worker adds the project and the new/flaky flags. */
export type ParsedFailure = Omit<TestFailure, 'project' | 'isNew' | 'flaky'>

export const MAX_FAILURES = 50
export const MAX_MESSAGE_CHARS = 3000
export const MAX_NAME_CHARS = 300
export const MAX_ID_CHARS = 600

type AssertionResult = {
  title?: unknown
  fullName?: unknown
  ancestorTitles?: unknown
  status?: unknown
  failureMessages?: unknown
  location?: { line?: unknown } | null
}
type FileResult = {
  name?: unknown
  status?: unknown
  message?: unknown
  assertionResults?: unknown
}

export type ParsedReport = {
  passed: number
  failed: number
  skipped: number
  total: number
  failures: ParsedFailure[]
  failuresTruncated: boolean
  /** Workspace-relative test files the run reached, passing or not. */
  files: string[]
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

const RUNNER_FRAME =
  /^\s*at .*(node_modules[\\/]|node:internal|\(<anonymous>\)|processTicksAndRejections)|^\s*at (?:[\w.-]+\/\/)?(org\.junit|org\.opentest4j|org\.gradle|worker\.org\.gradle|org\.apache\.maven|java\.base\/|java\.lang\.reflect|jdk\.internal|sun\.reflect|kotlin\.coroutines)|^\s*\.\.\. \d+ more$/

/** Drops stack frames inside the runner and Node, which say nothing about the test. */
export function trimStack(text: string): string {
  return text
    .split('\n')
    .filter((line) => !RUNNER_FRAME.test(line))
    .join('\n')
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** One line, no control characters, at most `max` characters. */
export function clip(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text
}

/** `src/a.test.ts`: relative to the first root that holds the file, with `/`; the path itself
 *  when no root does. Several roots: the workspace path and its real path, when they differ. */
export function workspaceRelative(
  roots: string | readonly string[],
  file: string,
  caseInsensitive = process.platform === 'darwin' || process.platform === 'win32'
): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p)
  const target = norm(file)
  for (const root of typeof roots === 'string' ? [roots] : roots) {
    const base = norm(root)
    if (fold(target).startsWith(`${fold(base)}/`)) {
      return target.slice(base.length + 1)
    }
  }
  return target
}

/** The first `file:line` (or `file:line:col`) in a stack that names this test file. */
export function lineFromMessage(message: string, absoluteFile: string): number | null {
  const name = absoluteFile.replace(/\\/g, '/').split('/').pop()
  if (!name) {
    return null
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[\\s/(\\\\"'])${escaped}:(\\d+)`).exec(message.replace(/\\/g, '/'))
  return match ? Number(match[1]) : null
}

export function parseReport(report: unknown, roots: string | readonly string[]): ParsedReport {
  const files = Array.isArray((report as { testResults?: unknown })?.testResults)
    ? ((report as { testResults: FileResult[] }).testResults ?? [])
    : null
  if (!files) {
    throw new Error('The test report has no testResults.')
  }
  const failures: ParsedFailure[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let truncated = false
  const seen = new Map<string, number>()
  const push = (failure: ParsedFailure) => {
    if (failures.length >= MAX_FAILURES) {
      truncated = true
      return
    }
    // Why unique: the same file can run twice (Vitest projects) and titles can repeat; the panel
    // keys rows by id and Orca refuses a render with duplicate keys.
    const count = (seen.get(failure.id) ?? 0) + 1
    seen.set(failure.id, count)
    failures.push(count === 1 ? failure : { ...failure, id: `${failure.id}#${count}` })
  }

  const ran = new Set<string>()
  for (const fileResult of files) {
    const absolute = str(fileResult.name)
    const file = workspaceRelative(roots, absolute)
    if (absolute) {
      ran.add(file)
    }
    const assertions = Array.isArray(fileResult.assertionResults)
      ? (fileResult.assertionResults as AssertionResult[])
      : []
    let fileFailures = 0
    for (const assertion of assertions) {
      const status = str(assertion.status)
      if (status === 'passed') {
        passed += 1
        continue
      }
      if (status !== 'failed') {
        // pending, skipped, todo, disabled
        skipped += 1
        continue
      }
      failed += 1
      fileFailures += 1
      const title = str(assertion.title)
      const ancestors = Array.isArray(assertion.ancestorTitles)
        ? assertion.ancestorTitles.filter((t): t is string => typeof t === 'string' && t !== '')
        : []
      const name = clip(
        [...ancestors, title].join(' › ') || str(assertion.fullName) || '(unnamed test)',
        MAX_NAME_CHARS
      )
      const messages = Array.isArray(assertion.failureMessages)
        ? assertion.failureMessages.filter((m): m is string => typeof m === 'string')
        : []
      const message = trimStack(stripAnsi(messages.join('\n\n'))).trim()
      const locationLine =
        typeof assertion.location?.line === 'number' ? assertion.location.line : null
      push({
        id: clip(`${file}::${name}`, MAX_ID_CHARS),
        file,
        name,
        title,
        line: locationLine ?? lineFromMessage(message, absolute),
        message: truncate(message, MAX_MESSAGE_CHARS)
      })
    }
    // A file that failed before any test ran (syntax error, failing import, hook error).
    const fileMessage = trimStack(stripAnsi(str(fileResult.message))).trim()
    if (str(fileResult.status) === 'failed' && fileFailures === 0) {
      failed += 1
      push({
        id: clip(`${file}::`, MAX_ID_CHARS),
        file,
        name: 'Test file failed to run',
        title: '',
        line: lineFromMessage(fileMessage, absolute),
        message: truncate(fileMessage || 'The runner reported this file as failed.', MAX_MESSAGE_CHARS)
      })
    }
  }

  return {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    failures,
    failuresTruncated: truncated,
    files: [...ran]
  }
}
