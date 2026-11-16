// Every call of one of dsk's async functions must be awaited: tsc does not say so, and a call that is not awaited runs
// on while its caller's `finally` (settle a script's changes, kill a process group) has already run. Lists each call
// that has no `await` before it on its line. A call meant to stay unawaited says so with `// not awaited: why` on its
// line; one inside Promise.all() on the same line passes too. Run from the repository root.
import fs from 'node:fs'
import path from 'node:path'

const root = 'skill/scripts'
const files = [path.join(root, 'dsk.ts'), ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.ts'))
  .map((f) => path.join(root, 'lib', f))].filter((f) => fs.existsSync(f))
const sources = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]))

const asyncNames = new Set<string>()
for (const text of sources.values()) {
  for (const m of text.matchAll(/\basync\s+function\s+(\w+)|\basync\s+(\w+)\s*\([^)]*\)\s*[:{]/g)) {
    asyncNames.add((m[1] ?? m[2]) as string)
  }
}

const found: string[] = []
for (const [file, text] of sources) {
  text.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    if (/^\s*(\*|\/\*)/.test(line) || line.includes('// not awaited:') || code.includes('Promise.all')) return
    for (const m of code.matchAll(/(?<![\w.$'"`])(\w+)\(/g)) {
      const name = m[1] as string
      if (!asyncNames.has(name)) continue
      const before = code.slice(0, m.index).trimEnd()
      if (/\bfunction$/.test(before) || /\basync$/.test(before) || /\bawait$/.test(before)) continue
      found.push(`${file}:${i + 1}: ${name}() is async and not awaited: ${line.trim()}`)
    }
  })
}
if (found.length) {
  console.log(found.join('\n'))
  process.exit(1)
}
console.log(`unawaited: every call of ${asyncNames.size} async functions is awaited`)
