// Turns failures into one prompt line for a coding agent. Single line on purpose: typed into an
// agent's terminal, a newline would submit a half-written prompt, and a control character
// (ESC, Ctrl-C) would act on the agent's input.
import type { RunnerKind, TestFailure } from './protocol.ts'

const MAX_ERROR_CHARS = 500
const MAX_LISTED = 10
const MAX_LISTED_NAME_CHARS = 120
const MAX_FILES = 12
const MAX_COMMANDS = 3
/** `terminal.sendText` and `agent.launch` take at most 4096 characters. */
export const MAX_PROMPT_CHARS = 4000

export type PromptProject = {
  id: string
  root: string
  runner: RunnerKind
  /** Variables `.orca-test-runner.json` sets for this project: the agent's shell has none of them. */
  env?: Record<string, string>
  /** The Python that runs pytest, relative to the project folder when it is a virtualenv's. */
  python?: string
}

/** Longer than this, the variables are named instead of written into the command. */
const MAX_ENV_CHARS = 600

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

function shellPath(path: string): string {
  const flat = oneLine(path)
  return /[\s"'$`]/.test(flat) ? quoteArg(flat) : flat
}

/** `-t` and `-g` are regular expressions in Vitest, Jest and Playwright: match literally. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The file relative to the project folder, which is where the command runs. */
function inProject(project: PromptProject, file: string): string {
  return project.root && file.startsWith(`${project.root}/`) ? file.slice(project.root.length + 1) : file
}

/** A command the agent can run to see the failure itself, from the workspace root. */
export function reproduceCommand(project: PromptProject, files: readonly string[], title?: string): string {
  const paths = files.map((file) => shellPath(inProject(project, file)))
  const name = title ? oneLine(title) : ''
  let command: string
  switch (project.runner) {
    case 'vitest':
      command = ['npx vitest run', ...paths, ...(name ? ['-t', quoteArg(escapeRegex(name))] : [])].join(' ')
      break
    case 'jest':
      command = ['npx jest', ...paths, ...(name ? ['-t', quoteArg(escapeRegex(name))] : [])].join(' ')
      break
    case 'playwright':
      command = ['npx playwright test', ...paths, ...(name ? ['-g', quoteArg(escapeRegex(name))] : [])].join(' ')
      break
    case 'cypress':
      command = ['npx cypress run', ...(paths.length ? ['--spec', paths.join(',')] : [])].join(' ')
      break
    case 'pytest':
      command = [`${shellPath(project.python ?? 'python3')} -m pytest`, ...paths, ...(name ? ['-k', quoteArg(name)] : [])].join(' ')
      break
    case 'gradle': {
      const cls = files.length === 1 ? (files[0]!.split('/').pop() ?? '').replace(/\.\w+$/, '') : ''
      command = `./gradlew test${cls ? ` --tests ${quoteArg(`*${cls}${name ? `.${name}` : ''}`)}` : ''}`
      break
    }
    case 'maven': {
      const cls = files.length === 1 ? (files[0]!.split('/').pop() ?? '').replace(/\.\w+$/, '') : ''
      command = `./mvnw test${cls ? ` -Dtest=${quoteArg(`${cls}${name ? `#${name}` : ''}`)}` : ''}`
      break
    }
  }
  const env = envPrefix(project.env)
  if (env === null) {
    command += ' (with the env from .orca-test-runner.json set)'
  } else if (env) {
    command = `${env} ${command}`
  }
  return project.root ? `cd ${shellPath(project.root)} && ${command}` : command
}

/** `NAME=value …` for the command line; '' when there is nothing to set, null when it is too long. */
function envPrefix(env: Record<string, string> | undefined): string | null {
  const parts = Object.entries(env ?? {})
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${/^[\w@%+=:,./-]*$/.test(value) ? value : quoteArg(oneLine(value))}`)
  const line = parts.join(' ')
  return line.length > MAX_ENV_CHARS ? null : line
}

function where(failure: TestFailure): string {
  return failure.line ? `${failure.file}:${failure.line}` : failure.file
}

function firstError(failure: TestFailure): string {
  return cut(oneLine(failure.message), MAX_ERROR_CHARS)
}

function finalize(parts: string[]): string {
  return cut(oneLine(parts.filter(Boolean).join(' ')), MAX_PROMPT_CHARS)
}

export function promptForFailure(project: PromptProject, failure: TestFailure, prefix = ''): string {
  const subject = failure.title
    ? `The test "${cut(oneLine(failure.name), 300)}" in ${where(failure)} is failing.`
    : `The test file ${where(failure)} fails before its tests run.`
  return finalize([
    prefix,
    subject,
    `Error: ${firstError(failure)}`,
    `Reproduce with: ${reproduceCommand(project, [failure.file], cut(oneLine(failure.title), 300) || undefined)}`,
    'Fix the code (or the test, if the test itself is wrong) and re-run it until it passes.'
  ])
}

export function promptForFailures(
  projects: ReadonlyMap<string, PromptProject>,
  failures: readonly TestFailure[],
  prefix = ''
): string {
  const fallback: PromptProject = { id: '', root: '', runner: 'vitest' }
  if (failures.length === 1) {
    return promptForFailure(projects.get(failures[0]!.project) ?? fallback, failures[0]!, prefix)
  }
  const listed = failures
    .slice(0, MAX_LISTED)
    .map((failure) => `"${cut(oneLine(failure.name), MAX_LISTED_NAME_CHARS)}" (${where(failure)})`)
  const more = failures.length > MAX_LISTED ? ` and ${failures.length - MAX_LISTED} more` : ''
  const byProject = new Map<string, string[]>()
  for (const failure of failures) {
    const files = byProject.get(failure.project) ?? []
    if (!files.includes(failure.file)) {
      files.push(failure.file)
    }
    byProject.set(failure.project, files)
  }
  const entries = [...byProject.entries()].slice(0, MAX_COMMANDS)
  // Each command starts from the workspace root: in one line, a second `cd` would start from
  // the first one's folder, so commands that change folder run in a subshell.
  const alone = (command: string) => (entries.length > 1 && command.startsWith('cd ') ? `(${command})` : command)
  const commands = entries.map(([id, files]) => {
    const project = projects.get(id) ?? fallback
    return files.length > MAX_FILES
      ? `${alone(reproduceCommand(project, []))} (${files.length} files fail; run the whole suite)`
      : alone(reproduceCommand(project, files))
  })
  return finalize([
    prefix,
    `${failures.length} tests are failing: ${listed.join('; ')}${more}.`,
    `Reproduce with: ${commands.join(' ; ')}`,
    'Fix them (or the tests, if a test itself is wrong) and re-run until they all pass.'
  ])
}
