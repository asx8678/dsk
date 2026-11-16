/** One dsk session, as `dsk status --json` prints it. Times are epoch seconds. */
export type Job = {
  id: string
  /** running, review, question, stuck, limit, error, done, accepted or dropped. */
  status: string
  /** While running: model (waiting for a reply), script or checks. Else empty. */
  phase: string
  profile: string
  /** Turns finished in the current round, out of `max_turns`. */
  turn: number
  max_turns: number
  /** Turns over the whole session. */
  turns: number
  in: number
  out: number
  /** Cached share of the input tokens, 0 to 1; null when the provider never said. */
  cached: number | null
  /** The round's latest action, kind and argument (`read src/a.py`); before 0.10.6, the turn in flight's only. */
  act: string
  /** The shell command or check running now, or empty. */
  doing: string
  /** While running: the kind of the round's latest action (read, grep, edit, sh, search, done...), empty before
   * the first; absent from a dsk before 0.10.6. */
  step?: string
  /** The profile the run left and why (`coralbricks 429`), or empty. */
  failover: string
  /** Dollars so far, or null when a profile it used has no `price`. */
  cost: number | null
  /** The question, or why the run stopped. */
  note: string
  changed: number
  brief: string
  /** The Claude Code session that started the run, or empty. */
  owner: string
  root: string
  worktree: boolean
  created: number
  active: number
}

/** The last reading: the jobs, when it was taken (epoch ms), and whose session this is. */
export type Board = { jobs: Job[]; at: number; me: string; cwd: string }

/** When each dsk tool call started (epoch ms), by tool_use_id. */
export type Calls = Record<string, number>

/** What the pane shows in place of its list: one job's diff or its turns. */
export type View = { id: string; kind: 'diff' | 'log'; text: string }

/** One provider profile, as `dsk provider list --json` prints it. */
export type Provider = {
  name: string
  base_url: string
  model: string
  key_env: string
  /** Whether its key is set; the key itself is never read here. */
  key: boolean
  /** Whether runs use it: it is on the route. */
  enabled: boolean
  /** Its place on the route, from 1; null when disabled. */
  position: number | null
  /** Whether it is DeepSeek's own API, which web search uses: off the route it serves search alone. */
  official: boolean
  /** What the last speed test measured, in seconds; null when it has no time, absent from a dsk before 0.10.3. */
  seconds?: number | null
  /** "dsk" when built into dsk, "plugin" for the plugin's custom endpoint: those can only be disabled, not removed. "" or absent otherwise. */
  builtin?: '' | 'dsk' | 'plugin'
}

/** What the providers pane of /dsk config shows. The form's text is not here: no key is stored. */
export type Providers = {
  list: Provider[]
  /** Whether web search has its DeepSeek key. */
  search: boolean
  /** Whether `route_order` is `fastest`: the measured fastest is tried first, not the first listed. */
  isFastest: boolean
  /** The list, one provider and what can be done with it, the form that adds or changes one, or the question before one is deleted. */
  mode: 'list' | 'provider' | 'add' | 'edit' | 'delete'
  /** The provider that is open or that the form changes; in the list, the one last open, where the ring starts. */
  editing: string
  /** What dsk said last, and whether it was an error. */
  note: string
  isError: boolean
}

declare module 'claude-code' {
  interface PluginState {
    dsk: {
      board: Shaped<Board>
      calls: Shaped<Calls>
      // Which step of the working mark is drawn, moved on by a timer while a job runs.
      frame: number
      // Whether the display is loaded in this session: `/dsk enable` and `disable`, and its row in `/dsk config`.
      isOn: boolean
      // Whether Claude may hand work to dsk in this session: `/dsk enable` and `disable`, and its row in `/dsk config`.
      delegates: boolean
      view: Shaped<View | null>
      providers: Shaped<Providers>
    }
  }
}
