// A fingerprint of a workspace's code: equal fingerprints mean nothing changed between them.
// Content-based on purpose: `git status` alone reads the same after a second edit to a file that
// was already modified.
import { spawn } from 'node:child_process'
import { createHash, type Hash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

const GIT_TIMEOUT_MS = 10_000
const MAX_UNTRACKED = 5000

/** Streams a git command's stdout into the hash; false when git fails or times out. */
function gitInto(cwd: string, args: string[], hash: Hash | null, collect?: (chunk: Buffer) => void) {
  return new Promise<boolean>((resolve) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      hash?.update(chunk)
      collect?.(chunk)
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/** HEAD, the full diff against it, and each untracked file's size and mtime; null outside git. */
export async function workspaceSignature(root: string): Promise<string | null> {
  const hash = createHash('sha1')
  if (!(await gitInto(root, ['rev-parse', 'HEAD'], hash))) {
    return null
  }
  if (!(await gitInto(root, ['diff', 'HEAD', '--no-ext-diff', '--no-color', '--binary'], hash))) {
    return null
  }
  const chunks: Buffer[] = []
  if (!(await gitInto(root, ['ls-files', '--others', '--exclude-standard', '-z'], null, (c) => chunks.push(c)))) {
    return null
  }
  const untracked = Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean).sort()
  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    const info = await stat(join(root, file)).catch(() => null)
    hash.update(`\0${file}\0${info ? `${info.size}:${info.mtimeMs}` : 'gone'}`)
  }
  hash.update(`\0untracked:${untracked.length}`)
  return hash.digest('hex')
}
