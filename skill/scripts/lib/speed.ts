// How fast each provider answers: the probes, the seconds they measured, and the route ordered fastest first.
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
import { Interrupted, STATE, eprint, fixed, flockWait, get, now as timeNow, pyJson, pyRound, tokenHex, type Cfg } from './base.ts'
import { claimSlot, secret } from './config.ts'
import { BENCH_PROMPT, SYSTEM } from './texts.ts'
import { headers, paused, release, requestBody, send } from './wire.ts'

/** The last measurement of every profile, {name: {"seconds", "why", "at"}}; {} when there is none or it is broken. */
export function speeds(): any {
  let found
  try {
    found = JSON.parse(fs.readFileSync(path.join(STATE, 'speed.json'), 'utf8'))
  } catch (e) {
    if (e instanceof Interrupted) throw e  // a signal is not a broken file, as dsk.py's except did not catch it
    return {}
  }
  return found !== null && typeof found === 'object' && !Array.isArray(found) ? found : {}
}

/** Time profile `name` with two small requests: {"seconds": the smaller one, rounded, or None, "why": why not}. */
export async function probe(cfg: Cfg, name: any): Promise<any> {
  const profile = get(get(cfg, 'profiles'), name)
  const key = secret(profile.key_env)
  if (!key) return { seconds: null, why: 'no key' }
  if (paused(name)) return { seconds: null, why: 'paused' }
  if (!claimSlot(cfg, name)) return { seconds: null, why: 'busy' }
  try {
    const url = profile.base_url.replace(/\/+$/, '') + '/chat/completions'
    const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: BENCH_PROMPT }]
    const body = requestBody(profile, 'off', msgs)
    const sent = headers(profile, 'dsk-bench-' + tokenHex(4))
    const times: number[] = []
    for (let n = 0; n < 2; n++) {  // send(), not post(): a retry would time the backoff, not the provider
      const started = timeNow()
      const [status] = await send(url, key, body, sent, 30)
      if (status !== 200) return { seconds: null, why: status ? `HTTP ${status}` : 'no answer' }
      times.push(timeNow() - started)
    }
    return { seconds: pyRound(Math.min(...times), 2), why: '' }
  } finally {
    release(cfg, name)
  }
}

/** Probe the profiles at the same time, one thread each, and merge the result into STATE/speed.json. */
export async function bench(cfg: Cfg, names: any): Promise<any> {
  const results = new Map<string, any>()

  // Promise.all is the join the threads needed; a rejected probe is recorded, never fatal to the benchmark.
  await Promise.all(names.map(async (name: any) => {
    try {
      results.set(name, await probe(cfg, name))
    } catch (e) {  // one profile must never take the whole benchmark down with it
      if (e instanceof Interrupted) throw e
      results.set(name, { seconds: null, why: 'no answer' })
    }
  }))
  const found = speeds()
  const at = timeNow()
  for (const [name, result] of results) {
    const old = get(found, name) || {}
    if (result.why === 'busy' && get(old, 'seconds') !== null) {
      // whatever holds the slot is busy, not slower: keep its time, and `busy` says the time is an older one
      found[name] = { seconds: get(old, 'seconds'), why: 'busy', at: get(old, 'at') }
    } else {
      found[name] = { seconds: result.seconds, why: result.why, at }
    }
  }
  const file = path.join(STATE, 'speed.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}`
  fs.writeFileSync(temp, pyJson(found), 'utf8')
  fs.renameSync(temp, file)
  return found
}

/** How long ago, for the line about a kept measurement: whole minutes up to an hour and a half, else hours. */
export function ago(seconds: any): any {
  const minutes = Math.max(0, Math.floor(seconds / 60))
  return minutes < 90 ? `${minutes}m` : `${pyRound(minutes / 60)}h`
}

/** What one profile's line says: its time, or why it has none, and a busy profile's last time and when. */
export function speedText(entry: any, now: any = null): any {
  const seconds = get(entry, 'seconds')
  if (seconds === null) return get(entry, 'why') || 'no answer'
  const text = `${fixed(seconds, 2)}s`
  if (get(entry, 'why') === 'busy') {
    return `busy (last ${text}, ${ago((now || timeNow()) - (get(entry, 'at') || 0))} ago)`
  }
  return text
}

/** `route` fastest first: the profiles with a time by ascending time, then the rest as they are listed. */
export function fastOrder(found: any, route: any): any {
  const timed = route.filter((name: any) => get(get(found, name) || {}, 'seconds') !== null)
  timed.sort((a: any, b: any) => get(get(found, a), 'seconds') - get(get(found, b), 'seconds'))
  return timed.concat(route.filter((name: any) => !timed.includes(name)))
}

/** The route to try: as listed, or fastest first from measurements fresh enough to trust (measuring first). */
export async function orderedRoute(cfg: Cfg, route: any): Promise<any> {
  if (get<string>(cfg, 'route_order', 'listed') !== 'fastest' || route.length < 2) {
    return [...route]  // a route of one profile has nothing to order
  }
  fs.mkdirSync(STATE, { recursive: true })
  // waits: runs started together measure once, not once each
  const handle = flockWait(path.join(STATE, 'bench.lock'))
  let found: any = {}
  try {
    found = speeds()
    const fresh = timeNow() - 60 * Number(get(cfg, 'bench_minutes', 15))
    const stale = route.filter((name: any) => Number(get(get(found, name) || {}, 'at', 0)) < fresh)
    if (stale.length) {
      found = await bench(cfg, stale)
      eprint('bench:   ' + stale.map((name: any) => `${name} ${speedText(get(found, name) || {})}`).join(' \u00b7 '))
    }
  } finally {
    handle.close()
  }
  return fastOrder(found, route)
}
