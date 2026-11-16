// Which command may act on a session in which state, alone in a module with no imports: gdp-wired reads admits()
// from here and proves the laws stated above it against this very code (`bun run prove`, tools/prove.mjs). resume() in commands.ts
// refuses a command by it, and names the states the command needs in the order of STATUSES.

/** Where a session stands: running, one of the six stops of a run, or decided by the lead. */
export type Status = 'running' | 'review' | 'question' | 'done' | 'stuck' | 'limit' | 'error' | 'accepted' | 'dropped'

/** The commands that act on an existing session; `drop` is `dsk reject --drop`, `reject` the one with defects. */
export type Command = 'answer' | 'continue' | 'accept' | 'reject' | 'drop'

/** Every status, in the order a refusal names the ones a command needs: dsk.py's order. */
export const STATUSES: Status[] = ['review', 'stuck', 'limit', 'question', 'done', 'accepted', 'error', 'running', 'dropped']

// gdp: law accepted work is never dropped: command == "drop" and status == "accepted" implies not result
// gdp: law nothing comes back from dropped: status == "dropped" implies not result
// gdp: law a session that is running takes no command: status == "running" implies not result
// gdp: law only work that stopped for review or ran out is accepted: command == "accept" and result implies status == "review" or status == "stuck" or status == "limit"
// gdp: law defects go back only to work that stopped for review or ran out: command == "reject" and result implies status == "review" or status == "stuck" or status == "limit"
// gdp: law only a question is answered: command == "answer" and result implies status == "question"
// gdp: law a next task follows only finished work: command == "continue" and result implies status == "done" or status == "accepted"
// gdp: law a run that failed can only be dropped: status == "error" and result implies command == "drop"
// gdp: law work waiting for review can always be accepted or dropped: status == "review" and (command == "accept" or command == "drop") implies result
/** Whether `command` may act on a session that is `status`: dsk.py's resume() calls, one rule. */
export function admits(command: Command, status: Status): boolean {
  if (command === 'answer') return status === 'question'
  if (command === 'continue') return status === 'done' || status === 'accepted'
  if (command === 'accept' || command === 'reject') return status === 'review' || status === 'stuck' || status === 'limit'
  return status === 'review' || status === 'stuck' || status === 'limit' || status === 'question' || status === 'done'
    || status === 'error'
}
