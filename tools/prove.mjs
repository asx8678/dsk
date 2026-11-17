// `bun run prove`: the laws of dsk's stateful rules, proven by gdp-wired against the code itself, and each rule's
// broken variants, which the law that rules them out must refuse. gdp-wired runs through bunx, on Bun's runtime, never
// through npm or npx; nothing is installed. Its CLI carries its own TypeScript, so the repository's TypeScript 7, which
// lacks the compiler API gdp-wired reads code with, does not matter to it.
//
// A broken variant is the rule's own file with one bug put in, so it never drifts from the code: when the code it
// patches changes, the variant says so and fails, and the bug is written again here.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LIB = path.join(import.meta.dirname, '..', 'skill', 'scripts', 'lib')
const CLI = ['--bun', 'gdp-wired-cli@0.50.0', 'check']

const RULES = [
  { file: 'stops.ts', entry: 'tally', broken: [
    { bug: 'a move to the next provider keeps the failures', find: '    failures = 0\n', replace: '',
      law: 'a move to the next provider starts it clean' },
    { bug: 'a fourth failing turn goes on', find: 'if (failures >= 3) return', replace: 'if (failures >= 4) return',
      law: 'three failing turns in a row never go on' },
    { bug: 'the turn limit is checked a turn late', find: 'if (turn.done + 1 >= turn.limit', replace: 'if (turn.done >= turn.limit',
      law: 'the turn limit ends the round' },
  ] },
  { file: 'revert.ts', entry: 'verdict', mode: 'standalone', broken: [
    { bug: 'the gate forgets that a script without a shell command changed only what it wrote',
      find: "  if (c.script && !c.shelled && !c.wrote) return 'theirs'\n", replace: '',
      law: 'what someone else changed while a script ran is left alone' },
    { bug: 'the gate ignores what the script wrote', find: 'if (c.script && !c.shelled && !c.wrote)',
      replace: 'if (c.script && !c.shelled)', law: 'a file the script wrote is its own' },
  ] },
  { file: 'lifecycle.ts', entry: 'admits', mode: 'standalone', broken: [
    { bug: '--drop is allowed on accepted work', find: "    || status === 'error'\n",
      replace: "    || status === 'error' || status === 'accepted'\n", law: 'accepted work is never dropped' },
    { bug: 'a question can be accepted', find: "if (command === 'accept' || command === 'reject') return status === 'review'",
      replace: "if (command === 'accept' || command === 'reject') return status === 'question' || status === 'review'",
      law: 'only work that stopped for review or ran out is accepted' },
  ] },
  { file: 'prune.ts', entry: 'prunable', mode: 'standalone', broken: [
    { bug: 'work that waits for review is deleted once it is old', find: "status !== 'dropped' && status !== 'done'",
      replace: "status !== 'dropped' && status !== 'done' && status !== 'review'",
      law: "work that waits for the lead's decision is never deleted" },
    { bug: 'a session another dsk process holds is deleted', find: '  if (held) return false\n', replace: '',
      law: 'a session another dsk process holds is never deleted' },
    { bug: 'the days kept are not counted', find: '  return age >= keep\n', replace: '  return true\n',
      law: 'nothing younger than the days kept is deleted' },
  ] },
  { file: 'retry.ts', entry: 'retries', mode: 'standalone', broken: [
    { bug: 'used-up credit is retried', find: '  if (last || spent) return false', replace: '  if (last) return false',
      law: 'credit that is used up is never retried' },
    { bug: 'a 400 counts as a passing failure', find: 'status === 429 ||', replace: 'status === 429 || status === 400 ||',
      law: 'a failure that is not passing is never retried' },
  ] },
]

/** Run gdp-wired on one file: its exit code and what it printed. */
function check(file, rule) {
  const args = [...CLI, file, ...(rule.mode ? ['--mode', rule.mode] : []), '--entry', rule.entry]
  return new Promise((resolve) => {
    const child = spawn('bunx', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.on('error', (e) => resolve({ code: -1, out: e.code === 'ENOENT'
      ? 'bunx is not on PATH: gdp-wired runs through Bun (https://bun.sh), never npx' : String(e) }))
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code, out }))
  })
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsk-prove-'))
const jobs = []
for (const rule of RULES) {
  const source = fs.readFileSync(path.join(LIB, rule.file), 'utf8')
  jobs.push(async () => {
    const { code, out } = await check(path.join(LIB, rule.file), rule)
    const tally = /(\d+) of (\d+) stated laws proven/.exec(out)
    const ok = code === 0 && tally && tally[1] === tally[2]
    return [ok, `${ok ? 'proven ' : 'FAILED '} lib/${rule.file}: ${tally ? `${tally[1]} of ${tally[2]} laws` : 'no verdict'}`, ok ? '' : out]
  })
  rule.broken.forEach((variant, n) => jobs.push(async () => {
    if (!source.includes(variant.find)) {
      return [false, `STALE   lib/${rule.file}: the code this broken variant patches is gone (${variant.bug}); write the bug again in tools/prove.mjs`, '']
    }
    const dir = path.join(scratch, `${rule.entry}-${n}`)
    fs.mkdirSync(dir)
    const file = path.join(dir, rule.file)
    fs.writeFileSync(file, source.replace(variant.find, variant.replace))
    const { code, out } = await check(file, rule)
    const refused = code === 1 && out.includes(`broken   ${variant.law}`)
    return [refused, `${refused ? 'refused' : 'MISSED '} broken variant: ${variant.bug} (by "${variant.law}")`, refused ? '' : out]
  }))
}

// Four at a time: each check is a process of its own, and bunx fetches the CLI the first time.
const results = []
for (let i = 0; i < jobs.length; i += 4) results.push(...await Promise.all(jobs.slice(i, i + 4).map((job) => job())))
fs.rmSync(scratch, { recursive: true, force: true })
for (const [, line] of results) console.log(line)
const failed = results.filter(([ok]) => !ok)
for (const [, , out] of failed) if (out) console.log('\n' + out)
console.log(failed.length ? `\n${failed.length} of ${results.length} failed` : `\nall ${results.length} hold`)
process.exit(failed.length ? 1 : 0)
