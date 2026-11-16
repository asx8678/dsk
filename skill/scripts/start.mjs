// The entry of dsk. dsk is TypeScript, which Node runs as it is from 22.18 on; an older Node cannot even parse it. So
// this file, plain JavaScript, says what is missing first, the way dsk.py did when its Python was too old: once to
// the user at session start, never from another hook, so that no hook fails on every turn.
//
// Then it runs dist/, the same TypeScript compiled by `npm run build`, when dist/BUILD says it was built from the
// sources as they are now. Node then skips its TypeScript stripper, which costs every call about 55 ms and 37 MB.
// After any edit the hash no longer matches, and dsk.ts runs itself: slower, never stale.
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
import { sourceHash } from './stamp.mjs'

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  const needs = `dsk needs Node.js 22.18 or newer on PATH; ${process.execPath} is ${process.version}`
  const argv = process.argv.slice(2)
  if (argv.includes('--announce')) console.log(JSON.stringify({ systemMessage: needs }))
  else if (!argv.includes('--hook')) console.error(needs)
  process.exitCode = argv.includes('--hook') ? 0 : 1
} else {
  let built = ''
  try {
    built = fs.readFileSync(path.join(import.meta.dirname, 'dist', 'BUILD'), 'utf8').trim()
  } catch {
    // no build: run the sources
  }
  await import(built && built === sourceHash(import.meta.dirname) ? './dist/dsk.js' : './dsk.ts')
}
