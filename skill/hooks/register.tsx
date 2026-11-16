import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register, RenderNode, Timer } from 'claude-code'

import type { Board, Job, Provider, Providers } from '../types'

const PANE = 'dsk-jobs'
const COMMAND = 'dsk'
const PERIOD_MS = 2000
// While nothing runs, one reading per this many periods.
const IDLE_PERIODS = 8
// Periods read after a dsk call starts or ends, until its job shows up.
const GRACE_PERIODS = 10
// How often the working mark moves on, while a job of this session runs.
const FRAME_MS = 300
// Jobs the band draws, two rows each, before it counts the rest.
const BAND_JOBS = 4
const FINISHED_ROWS = 8
// Seconds without a word in a running job's log before the display says so.
const QUIET_S = 45
// Diff lines a result in the transcript draws, and the pane's own view of one.
const CARD_LINES = 60
const VIEW_LINES = 600
const WAITING = ['review', 'question', 'stuck', 'limit', 'error']
// The verbs that start or continue a run: their rows show its progress.
const RUNS = ['run', 'answer', 'reject', 'continue']
// A Bash command that calls dsk, dsk standing where a command starts: the verb,
// and the session id after it.
const CALL =
  /(?:^|[;&|(\n]|\bdo|\bthen)\s*(?:\S*\/)?dsk(?:\.py)?\s+(run|answer|reject|continue|accept|show|status)\b(?:\s+([0-9a-f]{4})\b)?/
// A quoted argument, with the flag it belongs to when one stands right before it.
const ARGUMENT = /(--[a-z-]+[ =]+)?(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g
// What a command only carries as text: a here-document's body, and a quoted string.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
// The first line of a dsk report: `dsk 7f3a · review · ...`, and its figures.
const REPORT = /^dsk ([0-9a-f]{4}) · /m
const HEAD = /^dsk ([0-9a-f]{4}) · ([a-z]+)(?: · (.*))?$/
const SPENT = /^(.*?) · (\d+ turns?) · in (\S+)(?: \((\d+)% cached\))? · out (\S+)(.*)$/
// A line of a report after the first, a check and a changed file as it lists them.
const FIELD = /^([a-z]+):\s+(.*)$/
const LABELS = [
  'brief',
  'allow',
  'where',
  'question',
  'error',
  'why',
  'notes',
  'answer',
  'summary',
  'open',
  'checks',
  'scope',
  'changed',
  'ignored',
  'sources',
  'cache',
  'context',
  'next',
]
const CHECK = /(.+?) → (-?\d+)(?:; |$)/g
const CHANGED = /(.+?) \((binary|\+\d+(?: -\d+)?)\)(?:, |$)/g
// One turn of `dsk show ID --log`: tokens in, cache hits, tokens out, what it did.
const TURN = /^t(\d+)\s+in\s+(\d+) hit\s+(\S+) miss\s+\S+ out\s+(\d+) \| ?(.*)$/
// The mark Claude Code draws while it works, out and back.
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
// A bar's last cell, by how many eighths of it are filled.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const TONE: Record<string, Color> = {
  running: 'claude',
  review: 'warning',
  question: 'warning',
  stuck: 'error',
  limit: 'error',
  error: 'error',
  done: 'success',
  accepted: 'success',
  dropped: 'inactive',
}
// What a running job is doing, by its phase, and how a stopped one stands, by its status.
const WORD: Record<string, string> = {
  model: 'Thinking…',
  script: 'Working…',
  checks: 'Checking…',
  review: 'ready for review',
  question: 'asks a question',
  stuck: 'stuck',
  limit: 'hit a limit',
  error: 'failed',
  done: 'done',
  accepted: 'accepted',
  dropped: 'dropped',
}
// A running job named by what it works on: the kind of its latest action. A worker waits for its model most of the
// time, so the phase alone said Thinking… nearly always. Before its first action it plans; after a hand-in it is
// sent back to, by a failed check or the second look, it revises.
const STEP: Record<string, string> = {
  '': 'Planning…',
  read: 'Reading…',
  glob: 'Searching…',
  grep: 'Searching…',
  edit: 'Editing…',
  write: 'Editing…',
  sh: 'Running…',
  search: 'Researching…',
  fetch: 'Researching…',
  done: 'Revising…',
}
// Every word as wide as the widest, so that the bars of the rows line up.
const ACTIVITY_WIDTH = Math.max(...[...Object.values(STEP), WORD.model, WORD.script, WORD.checks].map(word => word?.length ?? 0))

/** The word for a running job: the checks by name, else what it works on; a dsk before 0.10.6 sends no step. */
const activity = (job: Job) =>
  (job.phase === 'checks' || job.step === undefined
    ? (WORD[job.phase] ?? job.phase)
    : (STEP[job.step] ?? WORD[job.phase] ?? job.phase)
  ).padEnd(ACTIVITY_WIDTH)

const MARK: Record<string, string> = {
  review: '⏺',
  question: '⏺',
  stuck: '✘',
  limit: '✘',
  error: '✘',
  done: '✔',
  accepted: '✔',
  dropped: '○',
}

// Change a tag when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const board = atom(
  { plugin: 'dsk', key: 'board' } as const,
  { jobs: [], at: 0, me: '', cwd: '' },
  { shape: 'board-2' },
)
const calls = atom({ plugin: 'dsk', key: 'calls' } as const, {}, { shape: 'calls-1' })
const frame = atom({ plugin: 'dsk', key: 'frame' } as const, 0)
const isOn = atom({ plugin: 'dsk', key: 'isOn' } as const, false)
const delegates = atom({ plugin: 'dsk', key: 'delegates' } as const, true)
const view = atom({ plugin: 'dsk', key: 'view' } as const, null, { shape: 'view-1' })
const providers = atom(
  { plugin: 'dsk', key: 'providers' } as const,
  { list: [], search: false, isFastest: false, mode: 'list', editing: '', note: '', isError: false } as Providers,
  { shape: 'providers-2' },
)
// The pane of /dsk config.
const SETUP = 'dsk-providers'
/**
 * How the settings pane asks to be seated: with the keys, closed by Escape as a dialog is, and as tall as its rows
 * for `count` providers, so that all of it shows where the layout has the room: the arrows then walk its rows.
 */
const seat = (count: number) => ({
  id: SETUP,
  title: 'dsk config',
  focus: true as const,
  closeOnEscape: true as const,
  rows: 15 + count,
})

// What /dsk takes after its name, each with the line the typeahead shows beside it.
const WORDS = [
  { word: 'enable', description: 'Enable dsk: Claude hands work to dsk, and running jobs show above the prompt' },
  { word: 'disable', description: 'Disable dsk: Claude does the work itself, and nothing is shown' },
  { word: 'update', description: 'Fetch the newest dsk and install it' },
  { word: 'config', description: 'Open the settings: delegation, the display, and the providers' },
] as const
// A dsk call that starts a round of work, wherever it stands in a command, with the rest of its arguments: looser
// than CALL, because what it guards must not get by on a spelling.
const ROUND = /(?:^|[\s;&|(\/])dsk(?:\.py)?\s+(run|answer|continue|reject)\b([^;&|\n]*)/g
// What Claude is told while dsk is disabled: when a dsk call is refused, when it opens the skill, and in its prompt.
const OFF_CALL =
  'dsk is disabled (the user typed /dsk disable): nothing is delegated to dsk, so this call was not run. Do the work yourself. dsk show, dsk status, dsk accept and dsk reject ID --drop still work on the jobs there are. /dsk enable turns delegation on again; say so if the user asks for dsk.'
const OFF_SKILL =
  'dsk is disabled: the user turned delegation off with /dsk disable. Do not hand work to dsk: a dsk run, answer or continue, and a dsk reject that sends defects back, are refused. Do the work yourself, as you would without this skill. Jobs that exist can still be read (dsk show, dsk status), accepted (dsk accept) or dropped (dsk reject ID --drop). If the user asks for dsk, say that /dsk enable turns it on.'
const OFF_PROMPT =
  'dsk is disabled: the user turned delegation to dsk off with /dsk disable. Do not use the dsk:delegate skill and do not start dsk jobs (dsk run, answer, continue, or a reject that sends defects back): they are refused. Do the work yourself. /dsk enable turns delegation on again.'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Code' | 'Button'>
type Call = { verb: string; id: string | undefined; said: string }
type Report = {
  id: string
  status: string
  // The first line after the status: its figures when it has them, else its words.
  spent: { before: string; cached: number | null; after: string } | undefined
  rest: string
  fields: [string, string][]
  diff: string
  more: string
}
type FileDiff = { path: string; added: number; removed: number; source: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const kilo = (n: number) => (n >= 999_950 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1000).toFixed(1)}k`)

const cut = (text: string, room: number) =>
  text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text

const elapsed = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** A bar's cells for a share from 0 to 1: full blocks, one part block, then room. */
const blocks = (fraction: number, cells: number) => {
  const part = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  const eighths = Math.round(part * cells * 8)
  const drawn = '█'.repeat(Math.floor(eighths / 8)) + (EIGHTHS[eighths % 8] ?? '')

  return drawn + ' '.repeat(cells - drawn.length)
}

const percent = (cached: number | null) =>
  cached === null ? 'n/a' : `${Math.round(cached * 100)}%`

const cachedShare = (cached: number | null) =>
  cached === null ? 'cache n/a' : `${percent(cached)} cached`

const cacheTone = (cached: number | null): Color =>
  cached === null ? 'inactive' : cached >= 0.8 ? 'success' : cached >= 0.5 ? 'warning' : 'error'

const markAt = (tick: number) => FRAMES[tick % FRAMES.length] ?? '✻'

// Small sums need the digits a cent hides.
const money = (dollars: number) => `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`

// The turn in flight while the job runs, else the turns its last round took.
const turnOf = (job: Job) =>
  Math.min(job.max_turns, job.turn + (job.status === 'running' ? 1 : 0))

const isMine = (job: Job, me: string, cwd: string) =>
  job.owner === ''
    ? cwd === job.root || cwd.startsWith(`${job.root}/`)
    : job.owner === me

/**
 * Jobs counted and their tokens and dollars added up. The cached share is over
 * the jobs that report one; `isPriced` says every job's cost is in the sum.
 */
const totals = (jobs: readonly Job[]) => {
  const known = jobs.filter(job => job.cached !== null)
  const read = known.reduce((sum, job) => sum + job.in, 0)
  const hit = known.reduce((sum, job) => sum + job.in * (job.cached ?? 0), 0)

  return {
    running: jobs.filter(job => job.status === 'running').length,
    waiting: jobs.filter(job => WAITING.includes(job.status)).length,
    in: jobs.reduce((sum, job) => sum + job.in, 0),
    out: jobs.reduce((sum, job) => sum + job.out, 0),
    cached: read > 0 ? hit / read : null,
    cost: jobs.reduce((sum, job) => sum + (job.cost ?? 0), 0),
    isPriced: jobs.every(job => job.cost !== null),
  }
}

// Letters and digits only, so that shell quoting and spacing do not matter.
const flat = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The first quoted argument after the verb that is no flag's value: the brief, the answer, the defects. */
const positional = (text: string) => {
  for (const found of text.matchAll(ARGUMENT)) {
    if (found[1] === undefined) {
      const said = found[2] ?? found[3] ?? ''

      return said.replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').trim()
    }
  }

  return ''
}

/**
 * The dsk call a Bash command makes, if it makes one: the verb, the session it
 * names, and what it was told. A command that only holds such words as text (in
 * a here-document or in quotes) makes none.
 */
const callOf = (command: string): Call | undefined => {
  // Blanked to the same length, so a place in one is the same place in the other.
  const visible = command.replace(HEREDOC, body => body.replace(/[^\n]/g, ' '))
  const blanked = visible.replace(QUOTED, quoted => ' '.repeat(quoted.length))
  const found = CALL.exec(blanked)

  if (found === null) {
    return undefined
  }

  // Its own arguments end where the next command starts.
  const after = found.index + found[0].length
  const next = blanked.slice(after).search(/[;&|\n]/)
  const own = visible.slice(found.index, next === -1 ? undefined : after + next)

  return { verb: found[1] ?? '', id: found[2], said: positional(own) }
}

/**
 * Whether a Bash command starts a round of work in dsk: a run, an answer, a continue, or a reject that sends defects
 * back and does not drop the work. Words in a here-document or in quotes are text, and start nothing.
 */
const startsRound = (command: string) => {
  const visible = command.replace(HEREDOC, body => body.replace(/[^\n]/g, ' '))
  const blanked = visible.replace(QUOTED, quoted => ' '.repeat(quoted.length))

  return [...blanked.matchAll(ROUND)].some(found => found[1] !== 'reject' || !/(?:^|\s)--drop\b/.test(found[2] ?? ''))
}

/** What a Bash call printed, as the row's props hold it: the text, or its standard output. */
const textOf = (output: unknown) =>
  typeof output === 'string'
    ? output
    : isRecord(output) && typeof output.stdout === 'string'
      ? output.stdout
      : ''

/** The job a dsk tool call started or continued, or undefined while none can be told. */
const jobFor = (
  call: Call,
  command: string,
  output: unknown,
  startedAt: number | undefined,
  { jobs, me, cwd }: Board,
): Job | undefined => {
  const id = call.verb === 'run' ? REPORT.exec(textOf(output))?.[1] : call.id

  if (id !== undefined) {
    return jobs.find(job => job.id === id)
  }

  if (call.verb !== 'run') {
    return undefined
  }

  // A run names no id until it reports: tell it by its brief, which the command holds.
  const wanted = flat(command)
  const since = startedAt === undefined ? 0 : startedAt / 1000 - 2
  const fresh = jobs.filter(job => job.created >= since)
  const named = fresh.filter(
    job => flat(job.brief).length >= 8 && wanted.includes(flat(job.brief)),
  )

  if (startedAt === undefined) {
    return named[0]
  }

  // Jobs come newest first: the one this call made is the oldest made since it began.
  // A brief the command does not hold (--brief FILE) leaves only the time to go by.
  const near = fresh.filter(
    job => job.created <= startedAt / 1000 + 20 && isMine(job, me, cwd),
  )

  return (named.length > 0 ? named : near).at(-1)
}

/**
 * A dsk report read back into its parts: the first line, the labelled lines
 * under it, and the diff a review packet carries. Undefined for any other text,
 * and for one that holds several reports.
 */
const reportOf = (text: string): Report | undefined => {
  const lines = text.split('\n')
  const first = lines.findIndex(line => HEAD.test(line))
  const head = HEAD.exec(lines[first] ?? '')

  if (head === null || lines.filter(line => HEAD.test(line)).length > 1) {
    return undefined
  }

  const rest = head[3] ?? ''
  const spent = SPENT.exec(rest)
  const fields: [string, string][] = []
  const diff: string[] = []
  let more = ''

  for (const line of lines.slice(first + 1)) {
    const field = FIELD.exec(line)
    const isLabel = field !== null && LABELS.includes(field[1] ?? '')
    const last = fields.at(-1)

    if (line.startsWith('diff --git ') || (diff.length > 0 && !line.startsWith('next:'))) {
      // A packet cut short says how much of the diff it left out.
      if (/^\.\.\. \d+ more diff lines/.test(line)) {
        more = line
      } else {
        diff.push(line)
      }
    } else if (isLabel) {
      fields.push([field[1] ?? '', field[2] ?? ''])
    } else if (last !== undefined && !line.startsWith('diff since your last review')) {
      // A value that runs over several lines: an answer, mostly.
      last[1] = `${last[1]}\n${line}`
    }
  }

  return {
    id: head[1] ?? '',
    status: head[2] ?? '',
    spent:
      spent === null
        ? undefined
        : {
            before: `${spent[2]} · ↑ ${spent[3]} · ↓ ${spent[5]}`,
            cached: spent[4] === undefined ? null : Number(spent[4]) / 100,
            after: `${spent[6] ?? ''} · ${spent[1]}`,
          },
    rest,
    fields,
    diff: diff.join('\n'),
    more,
  }
}

/**
 * A git diff as its files, each with as many of its lines as `budget` still has
 * room for, and how many lines were left out. A hunk cut short is still a hunk
 * once its header counts what is left of it, so what is kept always parses.
 */
const filesOf = (diff: string, budget: number) => {
  const files: FileDiff[] = []
  let room = budget
  let left = 0

  for (const part of diff.split(/^(?=diff --git )/m)) {
    const lines = part.split('\n')
    const path =
      /^\+\+\+ b\/(.+)$/m.exec(part)?.[1] ?? /^diff --git a\/(.+?) b\//.exec(part)?.[1]

    if (path === undefined) {
      continue
    }

    const hunks: string[] = []
    let added = 0
    let removed = 0
    let at = lines.findIndex(line => line.startsWith('@@'))

    while (at !== -1) {
      const start = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[at] ?? '')
      let end = at + 1

      while (end < lines.length && /^[ +\-\\]/.test(lines[end] ?? '')) {
        end += 1
      }

      const body = lines.slice(at + 1, end)
      const kept = start === null ? [] : body.slice(0, Math.max(0, room))
      added += body.filter(line => line.startsWith('+')).length
      removed += body.filter(line => line.startsWith('-')).length

      if (start !== null && kept.length > 0) {
        const olds = kept.filter(line => /^[ -]/.test(line)).length
        const news = kept.filter(line => /^[ +]/.test(line)).length
        hunks.push([`@@ -${start[1]},${olds} +${start[2]},${news} @@`, ...kept].join('\n'))
      }

      room -= kept.length
      left += body.length - kept.length
      const from = end
      at = lines.findIndex((line, index) => index >= from && line.startsWith('@@'))
    }

    files.push({
      path,
      added,
      removed,
      source: hunks.length === 0 ? '' : [`--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n'),
    })
  }

  return { files, left }
}

/** A bar as Claude Code draws its own: blocks in `color` over a shaded track. */
const meter = (Text: Kit['Text'], fraction: number, cells: number, color: Color) => (
  <Text color={color} backgroundColor="subtle">
    {blocks(fraction, cells)}
  </Text>
)

/**
 * What a job is doing now, or how it stopped, with its figures: the words after
 * `⎿` under a branch or a tool row. A running job has its turns as a bar, and
 * says so when its log has been quiet for a while.
 */
const detail = (Text: Kit['Text'], job: Job, at: number, tail: string) => {
  const tone = TONE[job.status] ?? 'text'
  const tokens = ` · ↑ ${kilo(job.in)} · ↓ ${kilo(job.out)} · `
  const cached = <Text color={cacheTone(job.cached)}>{cachedShare(job.cached)}</Text>

  if (job.status === 'running') {
    const turn = turnOf(job)
    const quiet = at / 1000 - job.active

    return (
      <Text>
        <Text color={tone}>{`${activity(job)} `}</Text>
        {meter(Text, turn / job.max_turns, 8, 'claude')}
        <Text dimColor>{` ${turn}/${job.max_turns}${tokens}`}</Text>
        {cached}
        {quiet >= QUIET_S && <Text color="warning">{` · quiet ${elapsed(quiet)}`}</Text>}
        <Text dimColor>{tail}</Text>
      </Text>
    )
  }

  const turns = `${job.turns} turn${job.turns === 1 ? '' : 's'}`

  return (
    <Text>
      <Text color={tone}>{`${MARK[job.status] ?? '⏺'} ${WORD[job.status] ?? job.status}`}</Text>
      <Text dimColor>{` · ${turns} · ${elapsed(job.active - job.created)}${tokens}`}</Text>
      {cached}
      <Text dimColor>{tail}</Text>
    </Text>
  )
}

/** What a running job does right now: the command in flight, else the last one it finished. */
const doing = (job: Job) =>
  job.doing !== '' ? ` · ▸ ${job.doing}` : job.act !== '' ? ` · ${target(job)}` : ''

/** What the latest action was on: the file, pattern or command. The word before it already names its kind. */
const target = (job: Job) =>
  job.step !== undefined && job.step !== '' && job.act.startsWith(`${job.step} `) && STEP[job.step] !== undefined
    ? job.act.slice(job.step.length + 1)
    : job.act

/**
 * One job as a branch of the tree, as Claude Code draws a subagent: what it is
 * for and its id, then each `under` on a `⎿` line beneath, then its `actions`.
 */
const branch = (
  { Box, Text }: Kit,
  job: Job,
  isLast: boolean,
  columns: number,
  about: string,
  under: readonly RenderNode[],
  actions: RenderNode | undefined,
) => {
  // A profile whose slots other runs held was skipped before any request: nothing failed, so nothing is said.
  const moved =
    job.failover === '' || job.failover.endsWith(' full')
      ? ''
      : ` · ↯ ${job.failover} → ${job.profile}`
  const tail = ` · ${job.id}${about}`
  const room = Math.max(12, columns - 5 - tail.length - moved.length)
  const lead = isLast ? '     ⎿  ' : '  │  ⎿  '

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>{isLast ? '  └─ ' : '  ├─ '}</Text>
        {cut(job.brief, room)}
        <Text dimColor>{tail}</Text>
        {moved !== '' && <Text color="warning">{moved}</Text>}
      </Text>
      {under.map(line => (
        <Text wrap="truncate-end">
          <Text dimColor>{lead}</Text>
          {line}
        </Text>
      ))}
      {actions !== undefined && (
        <Box>
          <Text dimColor>{lead}</Text>
          {actions}
        </Box>
      )}
    </Box>
  )
}

/** A section of the pane: its heading, then its jobs as one tree. */
const section = (
  kit: Kit,
  heading: string,
  jobs: readonly Job[],
  columns: number,
  draw: (job: Job) => {
    about: string
    under: readonly RenderNode[]
    actions: RenderNode | undefined
  },
) => {
  const { Box, Text } = kit

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{heading}</Text>
      {jobs.map((job, index) => {
        const { about, under, actions } = draw(job)

        return branch(kit, job, index === jobs.length - 1, columns, about, under, actions)
      })}
    </Box>
  )
}

/** Tokens in and out and the cache level as a bar: the pane's own figures. */
const figures = (
  Text: Kit['Text'],
  sent: number,
  received: number,
  cached: number | null,
  tail: string,
) => (
  <Text wrap="truncate-end">
    <Text dimColor>{`↑ ${kilo(sent)}  ↓ ${kilo(received)}`}</Text>
    {cached !== null && <Text dimColor>{'  cache '}</Text>}
    {cached !== null && meter(Text, cached, 10, cacheTone(cached))}
    {cached !== null && <Text color={cacheTone(cached)}>{` ${percent(cached)}`}</Text>}
    <Text dimColor>{tail}</Text>
  </Text>
)

/** A diff as Claude Code draws its own edits: each file's name and counts, then its lines. */
const diffRows = ({ Text, Code }: Kit, diff: string, budget: number): RenderNode[] => {
  const { files, left } = filesOf(diff, budget)
  const rows = files.flatMap(file => [
    <Text wrap="truncate-end">
      <Text bold>{file.path}</Text>
      {file.added > 0 && <Text color="success">{` +${file.added}`}</Text>}
      {file.removed > 0 && <Text color="error">{` -${file.removed}`}</Text>}
    </Text>,
    ...(file.source === ''
      ? []
      : [<Code format="diff" path={file.path} source={file.source} wrap="truncate-end" />]),
  ])

  return left > 0 ? [...rows, <Text dimColor>{`… ${left} more diff lines`}</Text>] : rows
}

/** A job's turns, as `dsk show ID --log` lists them: each turn's cache level as a bar, tokens, what it did. */
const logRows = ({ Text }: Kit, log: string): RenderNode[] =>
  log.split('\n').map(line => {
    const turn = TURN.exec(line)

    if (turn === null) {
      // A line between turns says where a new series began: a compaction, a failover.
      return (
        <Text color={line.includes('failover') ? 'warning' : 'inactive'} wrap="truncate-end">
          {line.replace(/^-- new series: /, '↯ ')}
        </Text>
      )
    }

    const sent = Number(turn[2])
    const hit = turn[3] === '?' ? null : Number(turn[3]) / Math.max(1, sent)

    return (
      <Text wrap="truncate-end">
        <Text dimColor>{`t${turn[1]}`.padEnd(4)}</Text>
        {meter(Text, hit ?? 0, 8, cacheTone(hit))}
        <Text color={cacheTone(hit)}>{` ${percent(hit)}`.padEnd(6)}</Text>
        <Text dimColor>{`↑ ${kilo(sent)}  ↓ ${kilo(Number(turn[4]))}  `}</Text>
        {turn[5] ?? ''}
      </Text>
    )
  })

/**
 * A dsk report as a card under its tool row: how the job stopped and its
 * figures, what the worker says, the checks, the files, and a packet's diff.
 */
const card = (kit: Kit, report: Report) => {
  const { Box, Text } = kit
  const tone = TONE[report.status] ?? 'text'
  const field = (label: string) =>
    report.fields.find(([name]) => name === label)?.[1].trim() ?? ''
  const said = field('summary') || field('answer')
  const checks = [...field('checks').matchAll(CHECK)]
  const changed = [...field('changed').matchAll(CHANGED)]
  const noted = (labels: readonly string[]) =>
    labels
      .filter(label => field(label) !== '')
      .map(label => `${label}: ${cut(field(label).replace(/\s+/g, ' '), 240)}`)
  // What the lead asked for, on a review packet; and after the worker's words, what stands in the way.
  const asked = noted(['brief', 'allow', 'where'])
  const notes = noted(['why', 'open', 'notes', 'sources', 'cache', 'context'])

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text dimColor>{'  ⎿  '}</Text>
        <Text color={tone}>
          {`${MARK[report.status] ?? '⏺'} ${WORD[report.status] ?? report.status}`}
        </Text>
        {report.spent === undefined ? (
          <Text dimColor>{report.rest === '' ? '' : ` · ${report.rest}`}</Text>
        ) : (
          <Text>
            <Text dimColor>{` · ${report.spent.before} · `}</Text>
            <Text color={cacheTone(report.spent.cached)}>{cachedShare(report.spent.cached)}</Text>
            <Text dimColor>{report.spent.after}</Text>
          </Text>
        )}
        <Text dimColor>{` · ${report.id}`}</Text>
      </Text>
      <Box flexDirection="column" paddingLeft={5}>
        {asked.map(note => (
          <Text dimColor>{note}</Text>
        ))}
        {field('question') !== '' && (
          <Text>
            <Text color="warning">{'question: '}</Text>
            {cut(field('question'), 600)}
          </Text>
        )}
        {field('error') !== '' && <Text color="error">{cut(field('error'), 400)}</Text>}
        {said !== '' && <Text>{cut(said.split('\n').slice(0, 8).join('\n'), 700)}</Text>}
        {notes.map(note => (
          <Text dimColor>{note}</Text>
        ))}
        {checks.map(check => (
          <Text wrap="truncate-end">
            <Text color={check[2] === '0' ? 'success' : 'error'}>
              {check[2] === '0' ? '✔ ' : '✘ '}
            </Text>
            {check[1] ?? ''}
            {check[2] !== '0' && <Text color="error">{` → ${check[2]}`}</Text>}
          </Text>
        ))}
        {/* A packet's diff names each file with its counts, so they are not listed twice. */}
        {(report.diff === '' ? changed : []).slice(0, 8).map(file => {
          const counts = /^\+(\d+)(?: -(\d+))?$/.exec(file[2] ?? '')

          return (
            <Text wrap="truncate-end">
              {file[1] ?? ''}
              {counts === null ? (
                <Text dimColor>{` ${file[2]}`}</Text>
              ) : (
                <Text color="success">{` +${counts[1]}`}</Text>
              )}
              {counts?.[2] !== undefined && <Text color="error">{` -${counts[2]}`}</Text>}
            </Text>
          )
        })}
        {report.diff === '' && changed.length > 8 && (
          <Text dimColor>{`… and ${changed.length - 8} more files`}</Text>
        )}
        {field('scope') !== '' && (
          <Text color="warning">{cut(`scope: ${field('scope')}`, 240)}</Text>
        )}
        {/* Files the worker wrote that git ignores are in no diff, so the card has to name them. */}
        {field('ignored') !== '' && (
          <Text color="warning">{cut(`ignored: ${field('ignored')}`, 240)}</Text>
        )}
        {report.diff !== '' && diffRows(kit, report.diff, CARD_LINES)}
        {report.more !== '' && <Text dimColor>{report.more}</Text>}
        {field('next') !== '' && (
          <Text dimColor wrap="truncate-end">{`next: ${field('next').split('\n')[0]}`}</Text>
        )}
      </Box>
    </Box>
  )
}

/**
 * What dsk prints for these arguments, and whether it succeeded: this plugin's
 * own copy first, then the one on PATH. Undefined when neither can be run.
 */
const dsk = async ($: EngineInterface, args: readonly string[], stdin?: string) => {
  for (const program of [`${$.plugin.root}/scripts/dsk.py`, 'dsk']) {
    try {
      const ran = await $.process.run(
        [program, ...args],
        stdin === undefined ? { timeoutMs: 10_000 } : { timeoutMs: 10_000, stdin },
      )

      return { isOk: ran.exitCode === 0, text: ran.stdout }
    } catch {
      // Not there, or not runnable: try the next.
    }
  }

  return undefined
}

// What the provider form holds while it is typed. Kept here and not in the
// session's state, so an API key is never stored by the engine; it goes to dsk
// on standard input alone.
let draft = { name: '', url: '', model: '', key: '' }

/** Reads the providers again (`dsk provider list --json`) and sets what the pane shows. */
const refresh = async ($: EngineInterface, patch: Partial<Providers> = {}) => {
  const ran = await dsk($, ['provider', 'list', '--json'])
  let read: Pick<Providers, 'list' | 'search' | 'isFastest'> | undefined

  try {
    const parsed: unknown = JSON.parse(ran?.text ?? '')

    if (isRecord(parsed) && Array.isArray(parsed.providers)) {
      read = {
        list: parsed.providers as Provider[],
        search: parsed.search === true,
        isFastest: parsed.order === 'fastest',
      }
    }
  } catch {
    // Not JSON: dsk said why, and the pane shows it.
  }

  const failed =
    read === undefined
      ? { note: (ran?.text ?? '').trim() || 'dsk did not answer. Is it on PATH and up to date?', isError: true }
      : {}
  await update($, providers, now => ({ ...now, ...read, ...patch, ...failed }))
}

/** What dsk answered, without the name it starts every line with; what to say when it did not answer. */
const said = (ran: { isOk: boolean; text: string } | undefined) =>
  (ran?.text ?? '').trim().replace(/^dsk · /, '') || 'dsk did not answer. Is it on PATH and up to date?'

/**
 * Puts the pane's ring on one of its controls. The ring holds a place in the drawing, not a control: once another
 * view is drawn, that place is some other control, and Enter would press it.
 */
const land = async ($: EngineInterface, key: string) => {
  try {
    await $.ui.focus({ requestId: SETUP, key })
  } catch {
    // A surface that keeps no ring has nothing to move.
  }
}

/** Opens the form: empty to add a provider, or filled with one to change it. */
const openForm = async ($: EngineInterface, editing?: Provider) => {
  draft = { name: editing?.name ?? '', url: editing?.base_url ?? '', model: editing?.model ?? '', key: '' }
  await update($, providers, (now): Providers => ({
    ...now,
    mode: editing === undefined ? 'add' : 'edit',
    editing: editing?.name ?? '',
    note: '',
    isError: false,
  }))
  await land($, editing === undefined ? 'provider-name' : 'provider-url')
}

/** The action a provider's view starts on: the first that would change something, else the edit. */
const startOn = (one: Provider, used: number) =>
  !one.enabled || used < 2 ? 'act-edit' : one.position === 1 ? 'act-down' : 'act-first'

/** Shows one provider and what can be done with it, in place of the list. */
const openProvider = async ($: EngineInterface, one: Provider) => {
  const now = await read($, providers)
  await update($, providers, (was): Providers => ({ ...was, mode: 'provider', editing: one.name, note: '', isError: false }))
  await land($, startOn(one, now.list.filter(it => it.enabled).length))
}

/**
 * Back to the list from a provider or the form, the ring on the provider that was open. `regain` asks for the keys
 * first, for when Escape has handed them to the prompt: the ring moves once the pane holds them again.
 */
const toList = async ($: EngineInterface, regain = false) => {
  const now = await read($, providers)
  draft = { name: '', url: '', model: '', key: '' }
  await update($, providers, (was): Providers => ({ ...was, mode: 'list', note: '', isError: false }))

  if (regain) {
    await $.ui.open(seat(now.list.length))
  }

  await land($, now.list.some(one => one.name === now.editing) ? `row-${now.editing}` : 'provider-add')
}

/** Sends the form to `dsk provider add` or `set`; on success, to the list for a new provider, else back to its view. */
const save = async ($: EngineInterface) => {
  const now = await read($, providers)
  const field = { name: draft.name.trim(), url: draft.url.trim(), model: draft.model.trim(), key: draft.key.trim() }
  const missing = [
    ...(field.name === '' ? ['name'] : []),
    ...(field.url === '' ? ['API URL'] : []),
    ...(field.model === '' ? ['model name'] : []),
    ...(now.mode === 'add' && field.key === '' ? ['API key'] : []),
  ]

  if (missing.length > 0) {
    await update($, providers, was => ({ ...was, note: `Still needed: ${missing.join(', ')}.`, isError: true }))

    return
  }

  const failed = async (text: string) => {
    await update($, providers, was => ({ ...was, note: text, isError: true }))
  }
  const old = now.list.find(one => one.name === now.editing)
  const saidAll: string[] = []

  // A new name first, so the change below finds the provider under it. A rename that went through stays, even when
  // the change after it fails: the form then edits the provider under its new name.
  if (now.mode === 'edit' && field.name !== now.editing) {
    const renamed = await dsk($, ['provider', 'rename', now.editing, field.name])

    if (renamed?.isOk !== true) {
      await failed(said(renamed))

      return
    }

    saidAll.push(said(renamed))
    await update($, providers, was => ({ ...was, editing: field.name }))
  }

  const isChanged = old?.base_url !== field.url || old?.model !== field.model || field.key !== ''

  if (now.mode === 'add' || isChanged) {
    const args =
      now.mode === 'add'
        ? ['provider', 'add', field.name, '--url', field.url, '--model', field.model]
        : [
            'provider',
            'set',
            field.name,
            ...(old?.base_url === field.url ? [] : ['--url', field.url]),
            ...(old?.model === field.model ? [] : ['--model', field.model]),
          ]
    const ran = await dsk($, field.key === '' ? args : [...args, '--key-stdin'], field.key === '' ? undefined : field.key)

    if (ran?.isOk !== true) {
      await refresh($, { note: [...saidAll, said(ran)].join('\n'), isError: true })

      return
    }

    saidAll.push(said(ran))
  }

  draft = { name: '', url: '', model: '', key: '' }
  await refresh($, {
    mode: now.mode === 'add' ? 'list' : 'provider',
    editing: field.name,
    note: saidAll.join('\n') || `${field.name}: nothing to change`,
    isError: false,
  })
  await land($, now.mode === 'add' ? `row-${field.name}` : 'act-edit')
}

const ORDINALS = ['1st', '2nd', '3rd']
const ordinal = (place: number) => ORDINALS[place - 1] ?? `${place}th`

/**
 * Gives an enabled provider its place among the `last` on the route: 1 is tried first. A place it already has, or
 * one past either end, runs nothing and says where it stands. dsk makes a place chosen here the order from then on,
 * whatever the speed test measured.
 */
const moveTo = async ($: EngineInterface, one: Provider, place: number, last: number) => {
  const at = one.position ?? 1

  if (place === at || place < 1 || place > last) {
    const where = at === 1 ? 'first' : at === last ? 'last' : ordinal(at)
    await update($, providers, was => ({ ...was, note: `${one.name} is already tried ${where}.`, isError: false }))

    return
  }

  const ran = await dsk($, ['provider', 'move', one.name, String(place)])
  await refresh($, { note: said(ran), isError: ran?.isOk !== true })
}

/** Sets what decides who is tried first: the priority as listed, or the speed test. */
const orderBy = async ($: EngineInterface, order: 'listed' | 'fastest') => {
  const ran = await dsk($, ['provider', 'order', order])
  await refresh($, { note: said(ran), isError: ran?.isOk !== true })
}

/** Leaves the form without saving: back to the provider it was changing, or to the list. */
const cancel = async ($: EngineInterface) => {
  const now = await read($, providers)
  draft = { name: '', url: '', model: '', key: '' }
  await update($, providers, (was): Providers => ({
    ...was,
    mode: now.mode === 'edit' ? 'provider' : 'list',
    note: '',
    isError: false,
  }))
  await land($, now.mode === 'edit' ? 'act-edit' : 'provider-add')
}

/**
 * Takes a provider off the route, or puts it back: ahead of official DeepSeek, or last. For official DeepSeek
 * that is the choice between web search alone and work as well.
 */
const toggle = async ($: EngineInterface, one: Provider, on = !one.enabled) => {
  if (on === one.enabled) {
    return
  }

  const ran = await dsk($, ['provider', on ? 'enable' : 'disable', one.name])
  await refresh($, { note: said(ran), isError: ran?.isOk !== true })
  // Its view lists other actions now: the ring stays on the one just pressed.
  await land($, 'act-toggle')
}

/**
 * Asks before a provider is deleted, in a view of its own with the ring on Cancel, so a stray Enter deletes nothing.
 * One that dsk built in, or the plugin's custom endpoint, would come back: its view says so instead.
 */
const askDelete = async ($: EngineInterface, one: Provider) => {
  if (one.builtin === 'dsk' || one.builtin === 'plugin') {
    const from = one.builtin === 'dsk' ? 'is built into dsk' : "is the plugin's custom endpoint, set in /plugin configure"
    await update($, providers, was => ({ ...was, note: `${one.name} ${from}: it cannot be deleted, only disabled.`, isError: true }))

    return
  }

  await update($, providers, (was): Providers => ({ ...was, mode: 'delete', editing: one.name, note: '', isError: false }))
  await land($, 'delete-cancel')
}

/** Back from the question to the provider's view, the ring on Delete. */
const keepIt = async ($: EngineInterface) => {
  await update($, providers, (was): Providers => ({ ...was, mode: 'provider', note: '', isError: false }))
  await land($, 'act-delete')
}

/** Deletes a provider (`dsk provider remove`): to the list once it is gone, else back to its view with why not. */
const deleteIt = async ($: EngineInterface, one: Provider) => {
  const ran = await dsk($, ['provider', 'remove', one.name])

  if (ran?.isOk !== true) {
    await refresh($, { mode: 'provider', note: said(ran), isError: true })
    await land($, 'act-delete')

    return
  }

  await refresh($, { mode: 'list', editing: '', note: said(ran), isError: false })
  const now = await read($, providers)
  await land($, now.list[0] === undefined ? 'provider-add' : `row-${now.list[0].name}`)
}

const hidden = (key: string) => (key === '' ? '' : `•••• ${key.slice(-4)}`)

// What the timers and the hooks share. A reload starts these over, and the
// session's start fills them in again.
let me = ''
let cwd = ''
// Whether the display is loaded: what the store holds, read at the start.
let isLoaded = false
// Whether Claude may hand work to dsk: on until `/dsk disable` says otherwise.
let isDelegating = true
let periods = 0
let grace = 0
let inFlight = 0
let hasRunning = false
let isPolling = false
let lastSeen = ''
// Never a line the status takes, so the first reading after a load always sets or clears it.
let lastStatus: string | undefined = ''
let statuses: Record<string, string> | undefined
let ticker: Timer | undefined
let frames: Timer | undefined

/**
 * Reads dsk once: writes the board when it changed, keeps the status line and the
 * mark's clock in step with what runs, and says when a job of ours stopped.
 */
const poll = async ($: EngineInterface) => {
  if (isPolling || !isLoaded) {
    return
  }

  isPolling = true

  try {
    const read = await dsk($, ['status', '--json'])
    // An older dsk has no `--json`: it fails, and nothing is drawn.
    const jobs: unknown = read?.isOk === true ? JSON.parse(read.text).jobs : undefined

    // Unloaded while dsk ran: what it read is not drawn.
    if (!Array.isArray(jobs) || !isLoaded) {
      return
    }

    const list = jobs as Job[]
    hasRunning = list.some(job => job.status === 'running')
    const seen = JSON.stringify(list)

    // While a job runs every reading is written, so the time it shows moves on.
    if (seen !== lastSeen || hasRunning) {
      lastSeen = seen
      const at = await $.clock.now()
      await update($, board, () => ({ jobs: list, at, me, cwd }))
    }

    const mine = list.filter(job => isMine(job, me, cwd))
    const live = totals(mine.filter(job => job.status === 'running'))
    const { waiting } = totals(mine)
    const cached = live.cached === null ? '' : ` · ${percent(live.cached)} cached`
    const queue = waiting > 0 ? ` · ${waiting} waiting for you` : ''
    const line =
      live.running > 0
        ? `✻ dsk ${live.running} running · ↑ ${kilo(live.in)} · ↓ ${kilo(live.out)}${cached}${queue}`
        : waiting > 0
          ? `⏺ dsk ${waiting} waiting for you · /${COMMAND}`
          : undefined

    if (line !== lastStatus) {
      lastStatus = line
      $.ui.status(line)
    }

    // The mark moves only while a job of this session runs.
    if (live.running > 0 && frames === undefined) {
      frames = $.clock.every(FRAME_MS, () => {
        update($, frame, tick => (tick + 1) % FRAMES.length).catch(() => undefined)
      })
    } else if (live.running === 0 && frames !== undefined) {
      frames.cancel()
      frames = undefined
    }

    const before = statuses
    statuses = Object.fromEntries(list.map(job => [job.id, job.status]))

    for (const job of before === undefined ? [] : mine) {
      if (before?.[job.id] === 'running' && job.status !== 'running') {
        const why = job.note === '' ? '' : ` · ${cut(job.note, 60)}`
        $.ui.toast(
          `${MARK[job.status] ?? '⏺'} dsk ${job.id} ${WORD[job.status] ?? job.status}${why}`,
        )
      }
    }
  } catch {
    // A reading that failed is taken again at the next period.
  } finally {
    isPolling = false
  }
}

/**
 * Loads or unloads the display in this session. Loaded, dsk is read on a timer
 * and its jobs are drawn; unloaded, nothing is read or drawn, the status line
 * is cleared and the pane closed.
 */
const load = async ($: EngineInterface, on: boolean) => {
  isLoaded = on
  await update($, isOn, () => on)

  if (on && ticker === undefined) {
    ticker = $.clock.every(PERIOD_MS, () => {
      periods += 1
      const isDue =
        inFlight > 0 || hasRunning || grace > 0 || periods % IDLE_PERIODS === 0
      grace = Math.max(0, grace - 1)

      if (isDue) {
        void poll($)
      }
    })
  }

  if (on) {
    await poll($)

    return
  }

  ticker?.cancel()
  frames?.cancel()
  ticker = undefined
  frames = undefined
  hasRunning = false
  lastSeen = ''
  lastStatus = ''
  statuses = undefined
  $.ui.status(undefined)
  await update($, view, () => null)
  await $.ui.close({ id: PANE })
}

/** This dsk's version, from its manifest; '' when it cannot be read. */
const version = async ($: EngineInterface) => {
  let root: string | undefined

  // A test engine may load the plugin without a directory, and refuse $.plugin.
  try {
    root = $.plugin.root
  } catch {
    return ''
  }

  for (const path of [`${root}/.claude-plugin/plugin.json`, `${root}/plugin.json`]) {
    try {
      const parsed: unknown = JSON.parse(await $.fs.read(path))

      if (isRecord(parsed) && typeof parsed.version === 'string') {
        return parsed.version
      }
    } catch {
      // Not there: try the next.
    }
  }

  return ''
}
let shownVersion = ''

/** Runs the claude command; its output, or why it could not run. */
const claude = async ($: EngineInterface, args: readonly string[]) => {
  try {
    const ran = await $.process.run(['claude', ...args], { timeoutMs: 180_000 })

    return { isOk: ran.exitCode === 0, text: `${ran.stdout}\n${ran.stderr}`.trim() }
  } catch (error) {
    return { isOk: false, text: `claude could not run: ${String(error)}` }
  }
}

/**
 * `/dsk update`: fetches the marketplace dsk came from, then updates dsk from it.
 * The new version loads after a restart or /reload-plugins.
 */
const upgrade = async ($: EngineInterface) => {
  const listed = await claude($, ['plugin', 'list', '--json'])
  let entry: { id: string; version: string } | undefined

  try {
    const all: unknown = JSON.parse(listed.text)

    if (Array.isArray(all)) {
      const found = all.filter(
        (one): one is { id: string; version?: string; installPath?: string } =>
          isRecord(one) && typeof one.id === 'string' && one.id.startsWith('dsk@'),
      )
      const mine =
        found.find(one => typeof one.installPath === 'string' && $.plugin.root.startsWith(one.installPath)) ??
        found[0]

      if (mine !== undefined) {
        entry = { id: mine.id, version: typeof mine.version === 'string' ? mine.version : '?' }
      }
    }
  } catch {
    // Not JSON: said below.
  }

  if (entry === undefined || entry.id === 'dsk@skills-dir') {
    return entry === undefined
      ? `No installed dsk plugin found by \`claude plugin list\`. ${cut(listed.text, 300)}`
      : 'This dsk runs from a checkout (dsk@skills-dir): git pull there updates it.'
  }

  const marketplace = entry.id.slice('dsk@'.length)
  const fetched = await claude($, ['plugin', 'marketplace', 'update', marketplace])

  if (!fetched.isOk) {
    return `Could not fetch the ${marketplace} marketplace: ${cut(fetched.text, 400)}`
  }

  const updated = await claude($, ['plugin', 'update', entry.id])

  if (!updated.isOk) {
    return `Could not update ${entry.id}: ${cut(updated.text, 400)}`
  }

  const after = await claude($, ['plugin', 'list', '--json'])
  let now = ''

  try {
    const all: unknown = JSON.parse(after.text)
    const one = Array.isArray(all) ? all.find(it => isRecord(it) && it.id === entry.id) : undefined
    now = isRecord(one) && typeof one.version === 'string' ? one.version : ''
  } catch {
    // Said as unknown below.
  }

  return now === '' || now === entry.version
    ? `dsk ${entry.version} is the latest version.${now === '' ? ` ${cut(updated.text, 300)}` : ''}`
    : `dsk ${entry.version} → ${now} updated. Restart Claude Code or run /reload-plugins to load it.`
}

/** Turns the display on or off here, and keeps the choice for the sessions after this one. */
const power = async ($: EngineInterface, on: boolean) => {
  await $.store.set('on', on)
  await load($, on)
}

/** Lets Claude hand work to dsk, or not, here and in the sessions after this one. */
const delegate = async ($: EngineInterface, on: boolean) => {
  isDelegating = on
  await $.store.set('delegate', on)
  await update($, delegates, () => on)
}

/** Puts one job's diff or its turns in the pane, in place of the list. */
const show = async ($: EngineInterface, id: string, kind: 'diff' | 'log') => {
  // What dsk says when it cannot show the job (its repository is gone) is shown in its place.
  const text = (await dsk($, ['show', id, `--${kind}`]))?.text ?? ''
  await update($, view, () => ({ id, kind, text: text.slice(0, 200_000) }))
}

/** Opens the settings pane, and says in a line how dsk is set up. */
const configure = async ($: EngineInterface) => {
  await refresh($, { mode: 'list', editing: '', note: '', isError: false })
  const now = await read($, providers)
  await $.ui.open(seat(now.list.length))
  const used = now.list.filter(one => one.enabled).map(one => `${one.name} (${one.model})`)
  const searchOnly = now.list.filter(one => !one.enabled && one.official).map(one => one.name)
  const off = now.list.filter(one => !one.enabled && !one.official).map(one => one.name)
  const state = `dsk${shownVersion === '' ? '' : ` ${shownVersion}`}: delegation ${isDelegating ? 'on' : 'off'}, job display ${isLoaded ? 'on' : 'off'}. `

  return {
    text: now.isError
      ? now.note
      : `${state}The work goes to ${used.join(' → ') || 'nothing'}${searchOnly.length > 0 ? `; web search only: ${searchOnly.join(', ')}` : ''}${off.length > 0 ? `; disabled: ${off.join(', ')}` : ''}. Web search: ${now.search ? 'on' : 'off, no DeepSeek key'}. In the dsk config pane: Delegation and Job display turn each on or off; ↑/↓ and Enter open a provider to set its priority, edit, enable or disable it; Route order chooses between your priority and the fastest first; Esc closes it.`,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    me = await $.session.id()
    cwd = e.cwd
    shownVersion = await version($)
    await $.command.register({
      name: COMMAND,
      description: 'Open the list of dsk jobs; /dsk enable or disable turns delegation to dsk and its display on or off; /dsk update updates it; /dsk config configures it',
      argumentHint: '[enable|disable|update|config]',
      immediate: true,
    })
    // The choice made with `/dsk enable` or `disable` holds for the sessions after it. Delegation is on until it was
    // turned off: an install that never chose has the display off and hands work to dsk.
    isDelegating = (await $.store.get('delegate')) !== false
    await update($, delegates, () => isDelegating)

    // Unloaded is how a session starts, so there is nothing to take down.
    if ((await $.store.get('on')) === true) {
      await load($, true)
    } else {
      await update($, isOn, () => false)
    }

    return next(e)
  })

  // The settings: a list, one provider's view with what can be done to it, and the form. Every row is one control
  // and nothing sits beside anything: the engine gives a pane's controls Tab, the up and down arrows and Enter, and
  // hands the left and right arrows to the prompt, where the left one opens the agents view over the pane.
  on('ui.render', { component: 'Pane', requestId: SETUP }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const now = await read($, providers)
    const columns = Math.max(30, e.props.bodyColumns)
    const note =
      now.note === '' ? null : (
        <Text color={now.isError ? 'error' : 'success'} wrap="wrap">
          {`${now.isError ? '✘' : '✔'} ${now.note}`}
        </Text>
      )
    // Rows a text takes once wrapped to the pane, counted high so the keys line never promises too much.
    const tall = (text: string) => Math.ceil((text.length + 8) / columns)
    // The keys that move the ring. The engine walks a pane's controls with the arrows only while all of it shows;
    // in one cut short the arrows scroll, and Tab walks.
    const moves = (rows: number) =>
      rows <= e.props.scroll.bodyRows ? '↑/↓ to move' : 'Tab to move · ↑/↓ to scroll'
    // One row of a menu, two cells in: its hotkey when it has one, then its words, all of it one control.
    const item = (
      key: string,
      label: string,
      parts: RenderNode[],
      onPress: () => unknown,
      more: { hotkey?: string; isStart?: boolean; isDim?: boolean } = {},
    ) => (
      <Box>
        <Text>{'  '}</Text>
        <Button
          key={key}
          label={label}
          plain
          {...(more.hotkey === undefined ? {} : { hotkey: more.hotkey })}
          {...(more.isStart === true ? { autoFocus: true as const } : {})}
          {...(more.isDim === true ? { dimColor: true } : {})}
          onPress={onPress}
        >
          {parts}
        </Button>
      </Box>
    )

    if (now.mode === 'add' || now.mode === 'edit') {
      const isAdd = now.mode === 'add'
      const was = now.list.find(one => one.name === now.editing)

      return (
        <Box flexDirection="column">
          <Text bold>{isAdd ? 'Add a provider' : `Edit ${now.editing}`}</Text>
          <Text dimColor wrap="wrap">
            {isAdd
              ? 'Any OpenAI-compatible API that serves a DeepSeek model.'
              : `Change any field; an empty API key keeps the one in ${was?.key_env ?? 'its variable'}.`}
          </Text>
          <Text> </Text>
          <Input
            key="provider-name"
            label="Name       "
            placeholder="lower-case letters, digits, - or _, such as myhost"
            value={draft.name}
            {...(isAdd ? { autoFocus: true as const } : {})}
            onInput={value => {
              draft.name = value
            }}
            onSubmit={value => {
              draft.name = value
            }}
          />
          <Input
            key="provider-url"
            label="API URL    "
            placeholder="https://example.com/v1"
            value={draft.url}
            {...(isAdd ? {} : { autoFocus: true as const })}
            onInput={value => {
              draft.url = value
            }}
            onSubmit={value => {
              draft.url = value
            }}
          />
          <Input
            key="provider-model"
            label="Model name "
            placeholder="the model id as the endpoint lists it"
            value={draft.model}
            onInput={value => {
              draft.model = value
            }}
            onSubmit={value => {
              draft.model = value
            }}
          />
          <Input
            key="provider-key"
            label="API key    "
            placeholder={isAdd ? "the endpoint's API key" : `leave empty to keep it (${was?.key ? 'set' : 'missing now'})`}
            value={draft.key}
            onInput={value => {
              draft.key = value
            }}
            onSubmit={async value => {
              draft.key = value
              await save($)
            }}
          />
          {draft.key !== '' && <Text dimColor>{`key entered: ${hidden(draft.key.trim())}`}</Text>}
          {draft.name.trim() !== now.editing && now.list.some(one => one.name === draft.name.trim()) ? (
            <Text color="error" wrap="wrap">{`${draft.name.trim()} is already the name of another provider, with its own key; dsk will not save over it. Pick a name no provider has.`}</Text>
          ) : (
            !isAdd &&
            draft.name.trim() !== now.editing &&
            draft.name.trim() !== '' && (
              <Text dimColor wrap="wrap">{`Renames ${now.editing} to ${draft.name.trim()}; its key and place on the route stay. Running jobs carry on.`}</Text>
            )
          )}
          <Text> </Text>
          {item('provider-save', isAdd ? 'Add' : 'Save', [isAdd ? 'Add the provider' : 'Save the changes'], () => save($))}
          {item('provider-cancel', 'Cancel', ['Cancel'], () => cancel($))}
          <Text> </Text>
          {note}
          <Text dimColor wrap="wrap">
            The key goes to ~/.config/dsk/env, readable by you alone; the rest to ~/.config/dsk/config.json.
          </Text>
          <Text dimColor wrap="wrap">Tab to the next field · Enter in the last field to save · Esc to go back</Text>
        </Box>
      )
    }

    const used = now.list.filter(one => one.enabled)

    if (now.mode === 'delete') {
      const one = now.list.find(it => it.name === now.editing)

      if (one !== undefined) {
        // dsk deletes only a key it named itself (`DSK_<NAME>_API_KEY`): one named by hand may serve more than dsk.
        const keyGoes = /^DSK_[A-Z0-9_]+_API_KEY$/.test(one.key_env)
          ? `Its API key in ${one.key_env} is deleted from ~/.config/dsk/env as well, unless another provider or web search uses it.`
          : `Its API key stays in ${one.key_env}: dsk did not name it.`

        return (
          <Box flexDirection="column">
            <Text bold>{`Delete ${one.name}?`}</Text>
            <Text dimColor wrap="wrap">
              {`dsk forgets ${one.name} (${one.model} · ${one.base_url.replace(/^https?:\/\//, '')}) and takes it off the route. ${keyGoes} This cannot be undone.`}
            </Text>
            <Text> </Text>
            {/* Cancel first: where the ring lands before it is moved, and under a stray Enter. */}
            {item('delete-cancel', 'Cancel', ['Cancel, keep it'], () => keepIt($), { isStart: true })}
            {item('delete-confirm', `Delete ${one.name}`, [<Text color="error">{`Delete ${one.name}`}</Text>], () => deleteIt($, one))}
            <Text> </Text>
            {note}
            <Text dimColor wrap="wrap">Enter to select · Esc to go back</Text>
          </Box>
        )
      }
    }

    if (now.mode === 'provider' || now.mode === 'delete') {
      const one = now.list.find(it => it.name === now.editing)

      if (one === undefined) {
        return (
          <Box flexDirection="column">
            <Text color="warning" wrap="wrap">{`There is no provider named ${now.editing} any more.`}</Text>
            {item('act-back', 'Back', ['Back to the list'], () => toList($), { hotkey: 'b', isStart: true })}
          </Box>
        )
      }

      const last = used.length
      const at = one.position ?? 0
      const canMove = one.enabled && last > 1
      const start = startOn(one, last)
      // An action that would change nothing stays in its place, dim, so the ring keeps its row from press to press.
      const act = (key: string, hotkey: string, text: string, onPress: () => unknown, why = '') =>
        item(key, text, why === '' ? [text] : [text, <Text dimColor>{`  ${why}`}</Text>], onPress, {
          hotkey,
          isStart: key === start,
          isDim: why !== '',
        })
      // One Text a line: parts side by side in a Box squeeze each other in a narrow pane.
      const fact = (label: string, value: string, color?: Color) => (
        <Text wrap="truncate-end">
          <Text dimColor>{`  ${label.padEnd(9)}`}</Text>
          <Text color={color}>{value}</Text>
        </Text>
      )
      const route = used.map(it => it.name).join(' → ')
      const state: { mark: string; color: Color; text: string } = one.enabled
        ? {
            mark: one.key ? '●' : '▲',
            color: one.key ? 'success' : 'warning',
            text:
              last < 2
                ? 'does the work, the only provider on the route'
                : now.isFastest
                  ? `on the route, your ${ordinal(at)} of ${last}; the speed test decides who is tried first`
                  : `on the route, tried ${ordinal(at)} of ${last}`,
          }
        : one.official
          ? { mark: '◇', color: 'claude', text: 'web search only, it does no work' }
          : { mark: '○', color: 'inactive', text: 'disabled' }
      // The rows of this view: its name, state and facts, the route, the actions, what dsk said, and the keys.
      const need =
        1 + tall(state.text) + 1 + 3 + (typeof one.seconds === 'number' ? 1 : 0) +
        (canMove ? tall(`Route ${route}`) + (now.isFastest ? 2 : 0) : 0) +
        1 + (canMove ? 7 : 4) + 1 + (now.note === '' ? 0 : now.note.split('\n').reduce((sum, line) => sum + tall(line), 0)) + 2

      return (
        <Box flexDirection="column">
          <Text bold>{one.name}</Text>
          <Text wrap="wrap">
            <Text color={state.color}>{`${state.mark} `}</Text>
            <Text dimColor>{state.text}</Text>
          </Text>
          <Text> </Text>
          {fact('Model', one.model)}
          {fact('API URL', one.base_url)}
          {fact('API key', one.key ? `set, in ${one.key_env}` : `missing: ${one.key_env} is not set, Edit sets it`, one.key ? undefined : 'warning')}
          {typeof one.seconds === 'number' && fact('Speed', `${one.seconds.toFixed(2)}s at the last speed test`)}
          {canMove && (
            <Text wrap="wrap">
              <Text dimColor>{`  ${'Route'.padEnd(9)}`}</Text>
              {used.flatMap((it, index) => [
                ...(index === 0 ? [] : [<Text dimColor> → </Text>]),
                <Text color={it.name === one.name ? 'suggestion' : undefined} bold={it.name === one.name} dimColor={it.name !== one.name}>
                  {it.name}
                </Text>,
              ])}
            </Text>
          )}
          {canMove && now.isFastest && (
            <Text dimColor wrap="wrap">
              {'  A place given here makes your priority count again, in place of the speed test.'}
            </Text>
          )}
          <Text> </Text>
          {canMove && act('act-first', 'f', 'Try first', () => moveTo($, one, 1, last), at === 1 ? 'it is first' : '')}
          {canMove && act('act-up', 'u', 'Move up', () => moveTo($, one, at - 1, last), at === 1 ? 'it is first' : '')}
          {canMove && act('act-down', 'd', 'Move down', () => moveTo($, one, at + 1, last), at === last ? 'it is last' : '')}
          {act('act-edit', 'e', 'Edit name, URL, model or key', () => openForm($, one))}
          {act(
            'act-toggle',
            one.enabled ? 'x' : 'n',
            one.official
              ? one.enabled
                ? 'Use for web search only'
                : 'Use for work as well'
              : one.enabled
                ? 'Disable'
                : 'Enable',
            () => toggle($, one),
          )}
          {item(
            'act-delete',
            'Delete',
            one.builtin === 'dsk' || one.builtin === 'plugin'
              ? ['Delete', <Text dimColor>{`  ${one.builtin === 'dsk' ? 'built into dsk' : "the plugin's"}, only disabled`}</Text>]
              : ['Delete'],
            () => askDelete($, one),
            { isDim: one.builtin === 'dsk' || one.builtin === 'plugin' },
          )}
          {item('act-back', 'Back', ['Back to the list'], () => toList($), { hotkey: 'b' })}
          <Text> </Text>
          {note}
          <Text dimColor wrap="wrap">{`Enter to select · ${moves(need)} · Esc to go back`}</Text>
        </Box>
      )
    }

    const shownOn = await read($, isOn)
    const hands = await read($, delegates)
    const searchOnly = now.list.filter(one => !one.enabled && one.official)
    const off = now.list.filter(one => !one.enabled && !one.official)
    const wide = Math.min(18, Math.max(8, ...now.list.map(one => one.name.length)))
    // Where the ring starts when the pane takes the keys: the provider last open, else the first one. Not the
    // rows above them, where a stray Enter would turn something off.
    const start = now.list.some(one => one.name === now.editing)
      ? `row-${now.editing}`
      : now.list[0] === undefined
        ? 'provider-add'
        : `row-${now.list[0].name}`
    // A provider's row: its place, which is also the key that opens it, its name, and where its work goes.
    const row = (one: Provider) => {
      const hotkey = one.enabled && (one.position ?? 10) <= 9 ? String(one.position) : undefined
      const mark = hotkey !== undefined ? '' : one.enabled ? `${one.position}.`.padEnd(3) : one.official ? '◇  ' : '○  '
      // What a provider off the route is for, said on its row: a heading over each group would cost the list rows.
      const tag = one.enabled ? '' : one.official ? 'web search only · ' : 'disabled · '
      const speed = now.isFastest && one.enabled && typeof one.seconds === 'number' ? ` · ${one.seconds.toFixed(2)}s` : ''
      const lack = one.key ? '' : ' · no key'
      const room = columns - 2 - 3 - wide - 2 - tag.length - speed.length - lack.length
      const where = `${one.model} · ${one.base_url.replace(/^https?:\/\//, '')}`

      return item(
        `row-${one.name}`,
        one.name,
        [
          `${mark}${cut(one.name, wide).padEnd(wide)}  `,
          <Text dimColor>{`${tag}${cut(where, Math.max(8, room))}${speed}`}</Text>,
          ...(lack === '' ? [] : [<Text color="warning">{lack}</Text>]),
        ],
        () => openProvider($, one),
        { ...(hotkey === undefined ? {} : { hotkey }), isStart: `row-${one.name}` === start },
      )
    }
    // A setting's row: its name, what it is set to, and what that means; Enter changes it.
    const setting = (key: string, name: string, value: string, color: Color | undefined, means: string, onPress: () => unknown) =>
      item(
        key,
        name,
        [
          name.padEnd(13),
          <Text color={color}>{value}</Text>,
          <Text dimColor>{cut(`  ${means}`, Math.max(8, columns - 2 - 13 - value.length))}</Text>,
        ],
        onPress,
      )
    const open = used.length === 0 ? '' : used.length === 1 ? ' · 1 to open it' : ` · 1–${Math.min(9, used.length)} to open a provider`

    const about =
      used.length === 0
        ? 'No provider is enabled: open one to enable it, or add one.'
        : now.isFastest && used.length > 1
          ? 'The fastest in the speed test is tried first; the next takes over when one fails. Giving a provider a place makes your priority count again.'
          : 'The first that answers does the work; the next takes over when one fails.'
    const search = 'Web search (--web) is off: it needs a DeepSeek API key (DEEPSEEK_API_KEY).'
    const keys = `Enter to select${open} · Esc to close`
    // The rows of the list: its title, the settings, the providers under their line, what dsk said, and the keys.
    const need =
      1 + 3 + 1 + 1 + tall(about) + now.list.length + 1 + 1 + (now.search ? 0 : tall(search)) +
      (now.note === '' ? 0 : now.note.split('\n').reduce((sum, line) => sum + tall(line), 0)) + tall(`${keys} · Tab to move · ↑/↓ to scroll`)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{`dsk${shownVersion === '' ? '' : ` ${shownVersion}`}`}</Text>
          <Text dimColor> · settings</Text>
        </Box>
        {setting(
          'dsk-delegate',
          'Delegation',
          hands ? '● on' : '○ off',
          hands ? 'success' : 'inactive',
          hands ? 'Claude hands the hands-on work to dsk' : 'Claude does the work itself, a dsk run is refused',
          () => delegate($, !hands),
        )}
        {setting(
          'dsk-power',
          'Job display',
          shownOn ? '● on' : '○ off',
          shownOn ? 'success' : 'inactive',
          shownOn ? 'running jobs show above the prompt, /dsk lists them' : 'nothing is read or drawn',
          () => power($, !shownOn),
        )}
        {setting(
          'route-order',
          'Route order',
          now.isFastest ? 'fastest first' : 'your priority',
          now.isFastest ? 'warning' : undefined,
          now.isFastest ? 'the speed test decides who is tried first' : 'providers are tried as numbered below',
          () => orderBy($, now.isFastest ? 'listed' : 'fastest'),
        )}
        <Text> </Text>
        <Text bold>Providers</Text>
        <Text dimColor wrap="wrap">
          {about}
        </Text>
        {used.map(row)}
        {searchOnly.map(row)}
        {off.map(row)}
        {item('provider-add', 'Add a provider', ['+  Add a provider'], () => openForm($), { isStart: start === 'provider-add' })}
        <Text> </Text>
        {!now.search && (
          <Text color="warning" wrap="wrap">
            {search}
          </Text>
        )}
        {note}
        <Text dimColor wrap="wrap">{`Enter to select · ${moves(need)}${open} · Esc to close`}</Text>
      </Box>
    )
  })

  // Escape, or the close mark, in a provider's view or the form goes back to the list; from the list it closes.
  on('ui.close', { id: SETUP }, async ($, e, next) => {
    const now = await read($, providers)

    if (e.origin.kind !== 'person' || now.mode === 'list') {
      return next(e)
    }

    try {
      // Escape gave the keys back to the prompt before it asked to close: the list asks for them again.
      await toList($, true)
    } catch {
      // Rather closed than a pane that no key closes.
      return next(e)
    }

    return { value: undefined }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const word = (e.args ?? '').trim().toLowerCase()

    if (word === 'enable' || word === 'disable') {
      await delegate($, word === 'enable')
      await power($, word === 'enable')

      return {
        text:
          word === 'enable'
            ? `dsk is enabled, here and in the sessions you start after this one. Claude hands work to dsk again, running jobs show above the prompt, /${COMMAND} lists them all, /${COMMAND} disable turns it off, /${COMMAND} config configures it.`
            : `dsk is disabled, here and in the sessions you start after this one. Nothing is delegated to dsk: Claude does the work itself, and a dsk run is refused. Jobs that are running finish, and dsk show, accept and reject --drop still work. /${COMMAND} enable turns it on again.`,
      }
    }

    if (word === 'update') {
      return { text: await upgrade($) }
    }

    if (word === 'config') {
      return configure($)
    }

    // A word it does not take: what it does take, whether dsk is on or off.
    if (word !== '') {
      return {
        text: `Usage: /${COMMAND} lists the jobs, /${COMMAND} enable turns delegation and the job display on, /${COMMAND} disable turns both off, /${COMMAND} update updates dsk, /${COMMAND} config configures it.`,
      }
    }

    if (!isLoaded) {
      return {
        text: `dsk's job display is off${isDelegating ? '' : ', and so is delegation'}. /${COMMAND} enable turns dsk on; /${COMMAND} config has a row for each.`,
      }
    }

    await poll($)
    await update($, view, () => null)
    await $.ui.open({ id: PANE, title: 'dsk jobs' })
    const now = await read($, board)
    const ours = now.jobs.filter(job => isMine(job, me, cwd))
    const sum = totals(ours)
    const cached = sum.cached === null ? '' : ` (${percent(sum.cached)} cached)`
    const cost = sum.cost > 0 ? ` · ${money(sum.cost)}${sum.isPriced ? '' : '+'}` : ''

    return {
      text:
        ours.length === 0
          ? '0 sessions running'
          : `${sum.running} running · ${sum.waiting} waiting · ↑ ${kilo(sum.in)}${cached} · ↓ ${kilo(sum.out)}${cost} in the last day`,
    }
  })

  // The typeahead lists commands by name, so /dsk alone would not show what it
  // takes: these rows do, and complete a word begun after it.
  on('prompt.autocomplete', async ($, e, next) => {
    const rest = await next(e)
    const token = e.token.toLowerCase()
    const name = `/${COMMAND}`
    const before = e.text.slice(0, e.start).trim().toLowerCase()
    let mine: { text: string; description: string }[] = []

    if (e.start === 0 && token.length >= 3 && name.startsWith(token)) {
      mine = WORDS.map(({ word, description }) => ({ text: `${name} ${word}`, description }))
    } else if (e.start > 0 && before === name) {
      // A word typed in full needs no row: taking it would change nothing.
      mine = WORDS.filter(({ word }) => word.startsWith(token) && word !== token).map(({ word, description }) => ({
        text: word,
        description,
      }))
    }

    return mine.length === 0 ? rest : { suggestions: [...mine, ...rest.suggestions] }
  })

  // Note when each dsk call began, so its row can find the job it started, and
  // read dsk more often while one is in flight.
  // Off, the skill that says to delegate says not to, to whoever opens it.
  on('skill.prompt', async ($, e, next) => (isDelegating || e.pluginName !== 'dsk' ? next(e) : { text: OFF_SKILL }))

  // Off, the prompt says so too, last: the list of skills still names dsk's as the one to use by default. A thread
  // under way keeps the prompt it started with; there the answer to /dsk disable and the refusal below do the telling.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return isDelegating
      ? composed
      : { sections: [...composed.sections, { id: 'dsk:off', text: OFF_PROMPT, scope: 'session' as const }] }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Off, no round of work starts: the call is refused with words that say what to do in its place.
    if (!isDelegating && startsRound(e.command)) {
      return { deny: OFF_CALL }
    }

    if (!isLoaded || callOf(e.command) === undefined) {
      return next(e)
    }

    const id = e.tool_use_id

    if (id !== undefined) {
      const now = await $.clock.now()
      await update($, calls, all => ({
        ...Object.fromEntries(Object.entries(all).slice(-199)),
        [id]: now,
      }))
    }

    inFlight += 1
    grace = GRACE_PERIODS

    try {
      return await next(e)
    } finally {
      inFlight -= 1
      grace = GRACE_PERIODS
      void poll($)
    }
  })

  // A dsk call's row: the brief in place of the whole command line, and under it
  // the job's progress while the call runs or its run goes on in the background.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const input = e.props.input
    const command =
      isRecord(input) && typeof input.command === 'string' ? input.command : ''
    const call = e.props.tool === 'Bash' ? callOf(command) : undefined
    const isRun = call !== undefined && RUNS.includes(call.verb)

    // ctrl+o shows the command as it was run.
    if (call === undefined || !isRun || !isRecord(input) || e.props.isExpanded === true) {
      return next(e)
    }

    if (!(await read($, isOn))) {
      return next(e)
    }

    const now = await read($, board)
    const startedAt = (await read($, calls))[e.props.tool_use_id]
    const job = jobFor(call, command, e.props.output, startedAt, now)
    const about = call.verb === 'run' ? (job?.brief ?? call.said) : call.said
    const target = call.verb === 'run' ? '' : ` ${call.id ?? ''}`
    const title = `dsk ${call.verb}${target}${about === '' ? '' : `: ${cut(about, 72)}`}`
    const row = await next({
      ...e,
      props: { ...e.props, input: { ...input, command: title } },
    })
    const output = e.props.output
    const isLive =
      e.props.isRunning ||
      (isRecord(output) && typeof output.backgroundTaskId === 'string')

    if (job === undefined || !isLive) {
      return row
    }

    const { Box, Text } = $.ui.resolve(e)
    const took =
      job.status === 'running' ? ` · ${elapsed(now.at / 1000 - job.created)}` : ''
    // In the phone app a framed row is a card, drawn without a tap.
    const frame = e.surface === 'mobile' ? { borderStyle: 'round' } : {}

    return (
      <Box flexDirection="column" {...frame}>
        {row}
        <Text wrap="truncate-end">
          <Text dimColor>{'  ⎿  '}</Text>
          {detail(Text, job, now.at, ` · ${job.id}${took}`)}
        </Text>
      </Box>
    )
  })

  // What a dsk call printed: its report as a card, a review packet's or a
  // `dsk show --diff`'s diff as Claude Code draws its own edits.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const text = e.props.tool === 'Bash' ? textOf(e.props.output) : ''
    const report = REPORT.test(text) ? reportOf(text) : undefined
    const isDiff = report === undefined && text.startsWith('diff --git ')

    // ctrl+o shows what was printed, as it was printed.
    if ((report === undefined && !isDiff) || e.props.isExpanded === true) {
      return next(e)
    }

    // A bare diff is drawn only when a dsk call printed it.
    const isOurs = report !== undefined || (await read($, calls))[e.props.tool_use_id] !== undefined

    if (!isOurs || !(await read($, isOn))) {
      return next(e)
    }

    const kit = $.ui.resolve(e)
    const { Box } = kit

    return report === undefined ? (
      <Box flexDirection="column" paddingLeft={5}>
        {diffRows(kit, text, CARD_LINES)}
      </Box>
    ) : (
      card(kit, report)
    )
  })

  // Above the prompt, as Claude Code draws its running subagents: a line for the
  // whole, then a branch per job of this session that runs now.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await read($, isOn))) {
      return next(e)
    }

    const now = await read($, board)
    const mine = now.jobs.filter(job => isMine(job, now.me, now.cwd))
    const live = mine.filter(job => job.status === 'running')

    if (e.props.hasSurvey || live.length === 0) {
      return next(e)
    }

    const kit = $.ui.resolve(e)
    const { Box, Text } = kit
    const tick = await read($, frame)
    const sum = totals(live)
    const waiting = mine.filter(job => WAITING.includes(job.status)).length
    const room = Math.max(1, Math.min(BAND_JOBS, Math.floor((e.props.maxRows - 2) / 2)))
    const shown = live.slice(0, room)
    const more = live.length - shown.length
    const oldest = Math.min(...live.map(job => job.created))

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="claude">{`${markAt(tick)} `}</Text>
          <Text bold>dsk</Text>
          {` · ${live.length} worker${live.length === 1 ? '' : 's'}`}
          <Text dimColor>
            {` (${elapsed(now.at / 1000 - oldest)} · ↑ ${kilo(sum.in)} · ↓ ${kilo(sum.out)} · `}
          </Text>
          <Text color={cacheTone(sum.cached)}>{cachedShare(sum.cached)}</Text>
          <Text dimColor>)</Text>
        </Text>
        {shown.map((job, index) =>
          branch(
            kit,
            job,
            index === shown.length - 1,
            e.props.bodyColumns,
            '',
            [detail(Text, job, now.at, doing(job))],
            undefined,
          ),
        )}
        {more > 0 && <Text dimColor>{`  … and ${more} more running · /${COMMAND}`}</Text>}
        {waiting > 0 && (
          <Text wrap="truncate-end">
            <Text color="warning">{'  ⏺ '}</Text>
            <Text dimColor>{`${waiting} waiting for you · /${COMMAND}`}</Text>
          </Text>
        )}
      </Box>
    )
  })

  // The pane: this session's jobs from the last day as trees and what runs
  // elsewhere, or one job's diff or turns once its button was pressed.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const { Box, Text, Button } = kit
    const now = await read($, board)
    const shown = await read($, view)

    if (!(await read($, isOn)) || now.at === 0) {
      return (
        <Text dimColor>
          {now.at === 0
            ? 'No reading from `dsk status --json` yet. Is dsk on PATH and up to date?'
            : `dsk's job display is off. /${COMMAND} enable turns dsk on.`}
        </Text>
      )
    }

    if (shown !== null) {
      const job = now.jobs.find(one => one.id === shown.id)

      return (
        <Box flexDirection="column">
          <Box>
            <Button
              key="back"
              label="back"
              hotkey="b"
              onPress={() => update($, view, () => null)}
            />
            <Text bold>{` ${shown.kind === 'diff' ? 'diff' : 'turns'} · ${shown.id}`}</Text>
            <Text dimColor wrap="truncate-end">
              {job === undefined ? '' : ` · ${job.brief}`}
            </Text>
          </Box>
          {shown.text.trim() === '' && <Text dimColor>dsk has nothing to show for it.</Text>}
          {shown.text.startsWith('dsk · error') ? (
            <Text color="error">{shown.text.trim()}</Text>
          ) : shown.kind === 'diff' ? (
            diffRows(kit, shown.text, VIEW_LINES)
          ) : (
            logRows(kit, shown.text.trim())
          )}
        </Box>
      )
    }

    const mine = now.jobs.filter(job => isMine(job, now.me, now.cwd))
    const running = mine.filter(job => job.status === 'running')
    const elsewhere = now.jobs.filter(
      job => job.status === 'running' && !mine.includes(job),
    )
    const waiting = mine.filter(job => WAITING.includes(job.status))
    const finished = mine.filter(
      job => job.status !== 'running' && !WAITING.includes(job.status),
    )
    const sum = totals(mine)
    const tick = running.length > 0 ? await read($, frame) : 0
    const columns = e.props.bodyColumns
    const cost = (job: Job) => (job.cost === null ? '' : ` · ${money(job.cost)}`)
    // Its diff, when it changed files, and its turns: each opens in this pane.
    const buttons = (job: Job) => (
      <Box>
        {job.changed > 0 && (
          <Button
            key={`diff-${job.id}`}
            label="diff"
            onPress={() => show($, job.id, 'diff')}
          />
        )}
        {job.changed > 0 && <Text> </Text>}
        <Button key={`log-${job.id}`} label="turns" onPress={() => show($, job.id, 'log')} />
      </Box>
    )
    // A running job: where it runs and for how long, its figures, then what it does.
    const live = (job: Job, where: string) => ({
      about: ` · ${job.profile} · ${elapsed(now.at / 1000 - job.created)}${where}`,
      under: [
        detail(Text, job, now.at, cost(job)),
        ...(doing(job) === '' ? [] : [<Text dimColor>{doing(job).slice(3)}</Text>]),
      ],
      actions: where === '' ? buttons(job) : undefined,
    })
    // A stopped job: its figures, then the question or why it stopped.
    const stopped = (job: Job) => ({
      about: '',
      under: [
        detail(Text, job, now.at, cost(job)),
        ...(job.note === '' ? [] : [<Text dimColor>{job.note}</Text>]),
      ],
      actions: buttons(job),
    })
    const spent =
      sum.cost > 0 ? ` · ${money(sum.cost)}${sum.isPriced ? '' : '+'}` : ''

    return (
      <Box flexDirection="column">
        {mine.length === 0 ? (
          // Nothing of this session in the last day: one line, no figures or bars.
          <Text wrap="truncate-end">
            <Text color="claude">{'✻ '}</Text>
            <Text bold>dsk</Text>
            {' · 0 sessions running'}
          </Text>
        ) : (
          <Text wrap="truncate-end">
            <Text color="claude">{`${running.length > 0 ? markAt(tick) : '✻'} `}</Text>
            <Text bold>dsk</Text>
            {` · ${running.length} running`}
            <Text color="warning">{'   ⏺ '}</Text>
            {`${waiting.length} waiting`}
            <Text color="success">{'   ✔ '}</Text>
            {`${finished.length} finished`}
          </Text>
        )}
        {mine.length > 0 &&
          figures(Text, sum.in, sum.out, sum.cached, `${spent} · this session, last day`)}
        {running.length > 0 &&
          section(kit, 'Running', running, columns, job => live(job, ''))}
        {elsewhere.length > 0 &&
          section(kit, 'Other sessions', elsewhere, columns, job =>
            live(job, ` · in ${job.root.split('/').at(-1) ?? job.root}`),
          )}
        {waiting.length > 0 &&
          section(kit, 'Waiting for you', waiting, columns, stopped)}
        {finished.length > 0 &&
          section(kit, 'Finished', finished.slice(0, FINISHED_ROWS), columns, stopped)}
        {finished.length > FINISHED_ROWS && (
          <Text dimColor>{`  … and ${finished.length - FINISHED_ROWS} more`}</Text>
        )}
      </Box>
    )
  })
}
