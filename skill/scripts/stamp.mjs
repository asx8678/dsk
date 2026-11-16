// What a build of dsk was made from: the SHA-256 of its TypeScript sources and their configuration. `npm run build`
// writes it to dist/BUILD; start.mjs runs dist/ only while the sources still give the same hash.
const crypto = process.getBuiltinModule('node:crypto')
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')

export function sourceHash(dir) {
  const names = ['dsk.ts', 'tsconfig.json', 'tsconfig.build.json',
                 ...fs.readdirSync(path.join(dir, 'lib')).filter((n) => n.endsWith('.ts')).map((n) => `lib/${n}`)].sort()
  const hash = crypto.createHash('sha256')
  for (const name of names) hash.update(name + '\0').update(fs.readFileSync(path.join(dir, name))).update('\0')
  return hash.digest('hex')
}

// `node stamp.mjs`: write the stamp of the sources beside this file into dist/BUILD, after tsc built dist/.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  fs.writeFileSync(path.join(import.meta.dirname, 'dist', 'BUILD'), sourceHash(import.meta.dirname) + '\n')
}
