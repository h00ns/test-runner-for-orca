// Turns failures into one prompt line for a coding agent. Single line on purpose: typed into an
// agent's terminal, a newline would submit a half-written prompt, and a control character
// (ESC, Ctrl-C) would act on the agent's input.
import type { RunnerKind, TestFailure } from './protocol'

const MAX_ERROR_CHARS = 500
const MAX_LISTED = 10
const MAX_LISTED_NAME_CHARS = 120
const MAX_FILES = 12
/** `terminal.sendText` and `agent.launch` take at most 4096 characters. */
export const MAX_PROMPT_CHARS = 4000

/** One line without control characters. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function quoteArg(text: string): string {
  return `"${text.replace(/(["\\$`])/g, '\\$1')}"`
}

/** `-t` is a regular expression in both runners: a title with `(` or `[` must match literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A command the agent can run to see the failure itself. */
export function reproduceCommand(
  runner: RunnerKind,
  files: readonly string[],
  title?: string
): string {
  const base = runner === 'vitest' ? 'npx vitest run' : 'npx jest'
  const parts = [base, ...files.map((file) => oneLine(file)).map((file) => (/[\s"'$`]/.test(file) ? quoteArg(file) : file))]
  if (title) {
    parts.push('-t', quoteArg(escapeRegex(oneLine(title))))
  }
  return parts.join(' ')
}

function where(failure: TestFailure): string {
  return failure.line ? `${failure.file}:${failure.line}` : failure.file
}

function firstError(failure: TestFailure): string {
  return cut(oneLine(failure.message), MAX_ERROR_CHARS)
}

function finalize(parts: string[]): string {
  return cut(oneLine(parts.join(' ')), MAX_PROMPT_CHARS)
}

export function promptForFailure(runner: RunnerKind, failure: TestFailure): string {
  const subject = failure.title
    ? `The test "${cut(oneLine(failure.name), 300)}" in ${where(failure)} is failing.`
    : `The test file ${where(failure)} fails before its tests run.`
  return finalize([
    subject,
    `Error: ${firstError(failure)}`,
    `Reproduce with: ${reproduceCommand(runner, [failure.file], cut(oneLine(failure.title), 300) || undefined)}`,
    'Fix the code (or the test, if the test itself is wrong) and re-run it until it passes.'
  ])
}

export function promptForFailures(runner: RunnerKind, failures: readonly TestFailure[]): string {
  if (failures.length === 1) {
    return promptForFailure(runner, failures[0])
  }
  const listed = failures
    .slice(0, MAX_LISTED)
    .map((failure) => `"${cut(oneLine(failure.name), MAX_LISTED_NAME_CHARS)}" (${where(failure)})`)
  const more = failures.length > MAX_LISTED ? ` and ${failures.length - MAX_LISTED} more` : ''
  const files = [...new Set(failures.map((failure) => failure.file))]
  const command =
    files.length > MAX_FILES
      ? `${runner === 'vitest' ? 'npx vitest run' : 'npx jest'} (${files.length} files fail; run the whole suite)`
      : reproduceCommand(runner, files)
  return finalize([
    `${failures.length} tests are failing: ${listed.join('; ')}${more}.`,
    `Reproduce with: ${command}`,
    'Fix them (or the tests, if a test itself is wrong) and re-run until they all pass.'
  ])
}
