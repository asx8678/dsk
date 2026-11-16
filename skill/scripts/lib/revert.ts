// The scope gate's decision for one changed path, alone in a module with no imports: gdp-wired reads verdict() from
// here, runs it beside the rule it reads, and proves the laws stated above it against this very code
// (`bun run prove`, tools/prove.mjs). settle() in gates.ts asks it about every path that changed while a script or the checks ran.

/** One path that changed while a script or the checks ran. */
export type Change = {
  /** It matches the round's --allow patterns. */
  inside: boolean
  /** The script wrote it with write() or edit(). */
  wrote: boolean
  /** The window was a script's turn; false for the checks. */
  script: boolean
  /** The script started a shell command, which can change any file. */
  shelled: boolean
}

/** What settle() does with the change: undo it, keep it as the worker's, or leave it as someone else's. */
export type Verdict = 'undo' | 'worker' | 'theirs'

// gdp: law a path inside --allow is never undone: c.inside implies result != "undo"
// gdp: law what someone else changed while a script ran is left alone: c.script and not c.shelled and not c.wrote implies result == "theirs"
// gdp: law the checks answer for every change they made: not c.script implies result != "theirs"
// gdp: law a script that started a shell command answers for every change: c.script and c.shelled implies result != "theirs"
// gdp: law a file the script wrote is its own: c.script and c.wrote implies result != "theirs"
// gdp: law only a path inside --allow counts as the worker's: result == "worker" implies c.inside
// gdp: law a change of the window's own outside --allow is undone: not c.inside and result != "theirs" implies result == "undo"
/**
 * What settle() does with one changed path. A script that started no shell command changed exactly the files it
 * wrote, since write() and edit() are checked when they are called: whatever else moved meanwhile is someone else's,
 * the lead's edits between turns among them, and is left alone. Of the rest, what is outside --allow is undone (a copy
 * is kept), and what is inside is the worker's.
 */
export function verdict(c: Change): Verdict {
  if (c.script && !c.shelled && !c.wrote) return 'theirs'
  if (c.inside) return 'worker'
  return 'undo'
}
