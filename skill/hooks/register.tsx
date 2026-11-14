import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register, RenderNode, Timer } from 'claude-code'

import type { Board, Job } from '../types'

const PANE = 'dsk-jobs'
const COMMAND = 'dsk-jobs'
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
const RUNS = ['run', 'answer', 'reject']
// A Bash command that calls dsk, dsk standing where a command starts: the verb,
// and the session id after it.
const CALL =
  /(?:^|[;&|(\n]|\bdo|\bthen)\s*(?:\S*\/)?dsk(?:\.py)?\s+(run|answer|reject|accept|show|status)\b(?:\s+([0-9a-f]{4})\b)?/
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
  'sources',
  'cache',
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
const view = atom({ plugin: 'dsk', key: 'view' } as const, null, { shape: 'view-1' })

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
        <Text color={tone}>{`${WORD[job.phase] ?? job.phase} `}</Text>
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
  job.doing !== '' ? ` · ▸ ${job.doing}` : job.act !== '' ? ` · ${job.act}` : ''

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
  // A profile whose slots other runs held was skipped before any request: nothing failed, so it is no warning.
  const isBusy = job.failover.endsWith(' full')
  const moved =
    job.failover === ''
      ? ''
      : isBusy
        ? ` · ${job.failover.slice(0, -' full'.length)} busy → ${job.profile}`
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
        {moved !== '' &&
          (isBusy ? <Text dimColor>{moved}</Text> : <Text color="warning">{moved}</Text>)}
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
    <Text dimColor>{`↑ ${kilo(sent)}  ↓ ${kilo(received)}  cache `}</Text>
    {meter(Text, cached ?? 0, 10, cacheTone(cached))}
    <Text color={cacheTone(cached)}>{` ${percent(cached)}`}</Text>
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
  const notes = noted(['why', 'open', 'notes', 'sources', 'cache'])

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
const dsk = async ($: EngineInterface, args: readonly string[]) => {
  for (const program of [`${$.plugin.root}/scripts/dsk.py`, 'dsk']) {
    try {
      const ran = await $.process.run([program, ...args], { timeoutMs: 10_000 })

      return { isOk: ran.exitCode === 0, text: ran.stdout }
    } catch {
      // Not there, or not runnable: try the next.
    }
  }

  return undefined
}

// What the timers and the hooks share. A reload starts these over, and the
// session's start fills them in again.
let me = ''
let cwd = ''
// Whether the display is loaded: what the store holds, read at the start.
let isLoaded = false
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

/** Puts one job's diff or its turns in the pane, in place of the list. */
const show = async ($: EngineInterface, id: string, kind: 'diff' | 'log') => {
  // What dsk says when it cannot show the job (its repository is gone) is shown in its place.
  const text = (await dsk($, ['show', id, `--${kind}`]))?.text ?? ''
  await update($, view, () => ({ id, kind, text: text.slice(0, 200_000) }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    me = await $.session.id()
    cwd = e.cwd
    await $.command.register({
      name: 'dsk-jobs',
      description: 'Load or unload the dsk job display, or open its list of jobs',
      argumentHint: '[on|off]',
      immediate: true,
    })
    // The choice made with `/dsk-jobs on` or `off` holds for the sessions after it.
    // Unloaded is how a session starts, so there is nothing to take down.
    if ((await $.store.get('on')) === true) {
      await load($, true)
    } else {
      await update($, isOn, () => false)
    }

    return next(e)
  })

  on('command.run', { command: 'dsk-jobs' }, async ($, e) => {
    const word = (e.args ?? '').trim().toLowerCase()

    if (word === 'on' || word === 'off') {
      await $.store.set('on', word === 'on')
      await load($, word === 'on')

      return {
        text:
          word === 'on'
            ? `dsk display loaded, here and in the sessions you start after this one. Running jobs show above the prompt, /${COMMAND} lists them all, /${COMMAND} off unloads it.`
            : `dsk display unloaded, here and in the sessions you start after this one. /${COMMAND} on loads it again.`,
      }
    }

    if (word !== '' || !isLoaded) {
      return {
        text: isLoaded
          ? `Usage: /${COMMAND} lists the jobs, /${COMMAND} off unloads the display.`
          : `The dsk display is not loaded. /${COMMAND} on loads it.`,
      }
    }

    await poll($)
    await update($, view, () => null)
    await $.ui.open({ id: PANE, title: 'dsk jobs' })
    const now = await read($, board)
    const sum = totals(now.jobs.filter(job => isMine(job, me, cwd)))
    const cached = sum.cached === null ? '' : ` (${percent(sum.cached)} cached)`
    const cost = sum.cost > 0 ? ` · ${money(sum.cost)}${sum.isPriced ? '' : '+'}` : ''

    return {
      text: `${sum.running} running · ${sum.waiting} waiting · ↑ ${kilo(sum.in)}${cached} · ↓ ${kilo(sum.out)}${cost} in the last day`,
    }
  })

  // Note when each dsk call began, so its row can find the job it started, and
  // read dsk more often while one is in flight.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
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
            : `The dsk display is not loaded. /${COMMAND} on loads it.`}
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
        <Text wrap="truncate-end">
          <Text color="claude">{`${running.length > 0 ? markAt(tick) : '✻'} `}</Text>
          <Text bold>dsk</Text>
          {` · ${running.length} running`}
          <Text color="warning">{'   ⏺ '}</Text>
          {`${waiting.length} waiting`}
          <Text color="success">{'   ✔ '}</Text>
          {`${finished.length} finished`}
        </Text>
        {figures(Text, sum.in, sum.out, sum.cached, `${spent} · this session, last day`)}
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
        {mine.length === 0 && elsewhere.length === 0 && (
          <Text dimColor>No dsk jobs from this session in the last day.</Text>
        )}
      </Box>
    )
  })
}
