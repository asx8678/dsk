// The stop rules of the worker loop, alone in a module with no imports: gdp-wired reads tally() from here, runs it
// beside the rule it reads, and proves the laws stated above it against this very code. `bun run prove` checks them (tools/prove.mjs).
// gdp: law the turn limit ends the round: turn.done + 1 >= turn.limit implies stop != "running"
// gdp: law three failing turns in a row never go on: stop == "running" implies failures < 3
// gdp: law a repeated reply or three idle turns never go on as they are: stop == "running" implies repeats < 2 and idle < 3
// gdp: law a move to the next provider starts it clean: failedOver implies repeats == 0 and failures == 0 and idle == 1
// gdp: law with no provider left a streak is not moved on: not turn.later implies not failedOver
// gdp: law only a hand-in that passed is done: stop == "done" implies turn.finished
// gdp: law a question stops the run unless it handed in: turn.asked and not turn.finished implies stop == "question"
/**
 * The stop rules of the worker loop: the counters after one turn, and whether the run goes on. dsk.py kept them as
 * local variables of loop(); they are a step of their own here so that gdp-wired proves the laws above against this
 * very code (`bun run prove`, tools/prove.mjs). The order is dsk.py's: a hand-in, a question, a streak of repeats or idle turns (moved to
 * the next provider while there is one), three failures, then the turn, time and token limits.
 */
export function tally(t = { repeats: 0, idle: 0, failures: 0, stop: 'running', failedOver: false }, turn) {
    let repeats = turn.repeat ? t.repeats + 1 : 0;
    let idle = turn.repeat || turn.stale ? t.idle + 1 : 0;
    let failures = turn.failed ? t.failures + 1 : 0;
    if (turn.finished)
        return { repeats, idle, failures, stop: 'done', failedOver: false };
    if (turn.asked)
        return { repeats, idle, failures, stop: 'question', failedOver: false };
    let failedOver = false;
    if (repeats >= 2 || idle >= 3) {
        if (!turn.later)
            return { repeats, idle, failures, stop: 'stuck', failedOver: false };
        // The next provider starts with a clean count, or its first failure would stop the run. It reads the same
        // repeated replies, though, so its first request is still sent warm.
        repeats = 0;
        failures = 0;
        idle = 1;
        failedOver = true;
    }
    if (failures >= 3)
        return { repeats, idle, failures, stop: 'stuck', failedOver };
    if (turn.done + 1 >= turn.limit || turn.spent)
        return { repeats, idle, failures, stop: 'limit', failedOver };
    return { repeats, idle, failures, stop: 'running', failedOver };
}
