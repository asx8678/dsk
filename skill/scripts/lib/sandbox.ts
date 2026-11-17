// The sandbox: the SBPL profile macOS's sandbox-exec applies to a worker's scripts and checks. The profile is cached
// per text, and so is the answer whether sandbox-exec applies it on this machine.
const fs = process.getBuiltinModule('node:fs')
const os = process.getBuiltinModule('node:os')
const path = process.getBuiltinModule('node:path')
import { Fail, expandUser, get, runSync, pyRepr, realPath, truthy, type Cfg } from './base.ts'
import { plugin } from './config.ts'
import { SANDBOX_EXEC, SANDBOX_HIDE, SANDBOX_WRITE } from './texts.ts'
import type { Session } from './session.ts'

/** Profile text -> whether sandbox-exec applies it here, tried once per process; "user_cache" holds the cache folder. */
export const sandboxes = new Map<string, any>()

/** A path as an SBPL string literal. */
export function sbpl(path: string): string {
  return '"' + path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** The git directory of a working tree and the common one (they differ in a worktree), or [] outside git. */
export function gitDirs(workdir: string): string[] {
  const done = runSync('git', ['-C', workdir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  if (done.code !== 0) return []
  const found = done.out.trim()
  return [...new Set((found ? found.split(/\s+/) : []).map((p) => realPath(p)))]
}

/** macOS's per-user cache folder, the sibling of the temp folder where clang keeps its module cache, or None. */
export function userCache(): string | null {
  if (!sandboxes.has('user_cache')) {
    const found = runSync('getconf', ['DARWIN_USER_CACHE_DIR'])
    const text = found.out.trim()
    sandboxes.set('user_cache', found.code === 0 && text ? realPath(text) : null)
  }
  return sandboxes.get('user_cache')
}

/**
 * The SBPL profile for the worker's scripts and the checks. Rules that come later win, so the order matters:
 * writes are denied, then allowed in the temp folders and build caches, denied again in the other Claude sessions'
 * scratchpads (where staged copies of tools such as dsk live), allowed in the working directory and the session's
 * scratch folder, and denied in git's own directory, whose hooks and config would run code outside any sandbox.
 */
export function sandboxProfile(cfg: Cfg, workdir: string, sdir: string): string {
  const home = (p: string): string => realPath(expandUser(p))
  const temp = [...new Set([realPath('/tmp'), realPath(os.tmpdir())])]
  const cache = userCache()
  const writes = [...SANDBOX_WRITE, ...(get(cfg, 'sandbox_write', []) as string[])].map(home)
  const caches = [...(cache ? [cache] : []), ...writes]
  const mine = [realPath(workdir), realPath(path.join(sdir, 'scratch')), ...temp.slice(1)]  // the temp folder may be a scratchpad too
  const gits = gitDirs(workdir)
  const under = (paths: string[]): string => paths.map((p) => `(subpath ${sbpl(p)})`).join(' ')
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)',
                  '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") ' +
                  '(literal "/dev/stderr") (regex #"^/dev/fd/"))',
                  `(allow file-write* ${under([...temp, ...caches])})`,
                  '(deny file-write* (regex #"^/private/tmp/claude-[0-9]+/"))',
                  `(allow file-write* ${under(mine)} (literal ${sbpl(path.join(realPath(sdir), 'answer'))}))`]
  if (gits.length) {
    forms.push(`(deny file-write* ${under(gits)})`,
               `(allow file-write* (literal ${sbpl(gits[0] + '/index')}) (literal ${sbpl(gits[0] + '/index.lock')}))`)
  }
  const hidden = [...SANDBOX_HIDE, ...(get(cfg, 'sandbox_hide', []) as string[])].map(home)
  const stored = plugin('path')  // the keys entered in the plugin's form, and the copy `configure --hook` writes beside it
  if (stored) hidden.push(realPath(stored), realPath(stored) + '.new')
  forms.push(`(deny file-read* ${under(hidden)})`)
  return forms.join(' ')
}

/**
 * Whether sandbox-exec applies `profile` here, tried once. A failure is never read off a command's own output:
 * sandbox-exec exits 65 when it cannot apply a profile, and so may any command.
 */
export function sandboxWorks(profile: string): boolean {
  if (!sandboxes.has(profile)) {
    try {
      sandboxes.set(profile, runSync(SANDBOX_EXEC, ['-p', profile, '/usr/bin/true'], { timeout: 30_000 }).code === 0)
    } catch {
      sandboxes.set(profile, false)
    }
  }
  return sandboxes.get(profile)
}

/**
 * At a run's start: [true, ''] when its scripts and checks will run sandboxed, else [false, why]. `refused` is
 * the lead's --no-sandbox, for a task whose tools start a sandbox of their own, which macOS will not nest.
 */
export function sandboxMode(cfg: Cfg, workdir: string, sdir: string, refused = false): [boolean, string] {
  const mode: any = get(cfg, 'sandbox', 'auto')
  if (mode !== 'auto' && mode !== 'off' && mode !== 'required') {
    throw new Fail(`config: sandbox is ${pyRepr(mode)}, not one of auto, off, required`)
  }
  if (refused && mode === 'required') {
    throw new Fail('config: sandbox is required, so --no-sandbox is refused')
  }
  if (refused) return [false, '--no-sandbox']
  if (mode === 'off') return [false, '']
  const why = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC) ? ''
    : 'no sandbox-exec on this system'
  const later = why || (sandboxWorks(sandboxProfile(cfg, workdir, sdir)) ? ''
    : 'sandbox-exec could not apply the profile')
  if (later && mode === 'required') {
    throw new Fail(`config: sandbox is required, but ${later}`)
  }
  return [!later, later]
}

/** The command prefix that runs a script or a check in the session's sandbox, or [] for a session without one. */
export function sandboxed(s: Session, cfg: Cfg): string[] {
  if (!truthy(get(s.head, 'sandbox'))) return []
  const profile = sandboxProfile(cfg, s.head['workdir'], s.dir)
  if (!sandboxWorks(profile)) {
    throw new Fail('the sandbox this run started with cannot be applied any more; dsk reject ID --drop, or set ' +
                   '"sandbox": "off" in the config and run it again')
  }
  return [SANDBOX_EXEC, '-p', profile]
}
