// When a request to a provider is tried again, alone in a module with no imports: gdp-wired reads retries() from
// here, runs it beside the rule it reads, and proves the laws stated above it against this very code
// (`bun run prove`, tools/prove.mjs). post() in wire.ts asks it after every failed try, and chat() asks transient() whether a failure
// is worth the next provider.

/** A failure worth another try, here or on the next profile: the network (0), a timeout, a rate limit, any 5xx. */
export function transient(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599)
}

// gdp: law a success is never sent again: status == 200 implies not result
// gdp: law a failure that is not passing is never retried: not (status == 0 or status == 408 or status == 429 or status >= 500 and status <= 599) implies not result
// gdp: law credit that is used up is never retried: spent implies not result
// gdp: law the last try is never retried: last implies not result
// gdp: law a caller with somewhere else to go gets a slow failure at once: not patient and slow implies not result
// gdp: law a passing failure is tried again while tries are left: (status == 0 or status == 429 or status == 503) and not spent and not last and patient implies result
/**
 * Whether post() waits and sends the same bytes again after a try that ended with `status` (0 for a network failure;
 * a 400 that names a limit counts as 429, an interrupted reply as 503). `spent`: the error says the provider's credit
 * or quota is used up, which does not come back in seconds. `last`: no wait is left in the backoff. `patient`: the
 * caller waits out a slow failure; one with another profile to move to does not, and `slow` is a failure that took
 * longer than SLOW seconds to arrive, as a gateway timeout does.
 */
export function retries(status: number, spent: boolean, last: boolean, patient: boolean, slow: boolean): boolean {
  if (!transient(status)) return false
  if (last || spent) return false
  if (!patient && slow) return false
  return true
}
