// Which sessions `dsk prune` deletes, alone in a module with no imports: gdp-wired reads prunable() from here, runs it
// beside the rule it reads, and proves the laws stated above it against this very code (`bun run prove`,
// tools/prove.mjs). prune() in stats.ts asks it about every session folder before it removes one.

/** Where a session stands, as lifecycle.ts names it: prune() hands over a lifecycle Status, so the two cannot drift. */
export type Standing = 'running' | 'review' | 'question' | 'done' | 'stuck' | 'limit' | 'error' | 'accepted' | 'dropped'

// gdp: law work that waits for the lead's decision is never deleted: status == "review" or status == "question" or status == "stuck" or status == "limit" or status == "error" implies not result
// gdp: law a session that is running is never deleted: status == "running" implies not result
// gdp: law a session another dsk process holds is never deleted: held implies not result
// gdp: law nothing younger than the days kept is deleted: age < keep implies not result
// gdp: law a settled session past the days kept goes: (status == "accepted" or status == "dropped" or status == "done") and not held and age >= keep implies result
/**
 * Whether a session's folder may be deleted: its log, its turn outputs, the copies of what the scope gate undid. Only
 * a session the lead has settled (`accepted`, `dropped`) or that only answered (`done`) goes, once nothing has been
 * written to it for `keep` days. One that waits for a decision holds work nobody has judged, and its worktree: it
 * stays until `dsk accept` or `dsk reject ID --drop` settles it. `held`: another dsk process has the session's lock.
 * `age` and `keep` are in days.
 */
export function prunable(status: Standing, held: boolean, age: number, keep: number): boolean {
  if (held) return false
  if (status !== 'accepted' && status !== 'dropped' && status !== 'done') return false
  return age >= keep
}
