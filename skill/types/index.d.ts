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
  /** The last action the turn in flight finished. */
  act: string
  /** The shell command or check running now, or empty. */
  doing: string
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

declare module 'claude-code' {
  interface PluginState {
    dsk: {
      board: Shaped<Board>
      calls: Shaped<Calls>
      // Which step of the working mark is drawn, moved on by a timer while a job runs.
      frame: number
      // Whether the display is loaded in this session: `/dsk-jobs on` and `off`.
      isOn: boolean
      view: Shaped<View | null>
    }
  }
}
