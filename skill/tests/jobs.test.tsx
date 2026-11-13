import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { Job } from '../types'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// Started 60 seconds before the clock's time, in its third turn of twelve; its
// log last moved 30 seconds ago.
const RUNNING: Job = {
  id: 'ed3f',
  status: 'running',
  phase: 'script',
  profile: 'coralbricks',
  turn: 2,
  max_turns: 12,
  turns: 2,
  in: 5300,
  out: 2900,
  cached: 0.6,
  act: 'sh python3 -m unittest',
  doing: '',
  failover: '',
  cost: null,
  note: '',
  changed: 0,
  brief: 'Write apps/todo/ with tests',
  owner: 'me',
  root: '/repo',
  worktree: true,
  created: 100,
  active: 130,
}
const REVIEW: Job = {
  ...RUNNING,
  id: 'b498',
  status: 'review',
  phase: '',
  turn: 4,
  turns: 4,
  cached: 0.84,
  act: '',
  changed: 2,
  brief: 'Write apps/tictactoe/',
  active: 190,
}
const BAND = {
  plugin: 'dsk',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const
const PANE = {
  plugin: 'dsk',
  component: 'Pane',
  requestId: 'dsk-jobs',
  props: {
    title: 'dsk jobs',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const
const DIFF = [
  'diff --git a/apps/todo/todo.py b/apps/todo/todo.py',
  'index 1111111..2222222 100644',
  '--- a/apps/todo/todo.py',
  '+++ b/apps/todo/todo.py',
  '@@ -1,3 +1,4 @@',
  ' import json',
  '-import os',
  '+import sys',
  '+import argparse',
  ' ',
  'diff --git a/apps/todo/test_todo.py b/apps/todo/test_todo.py',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/apps/todo/test_todo.py',
  '@@ -0,0 +1,3 @@',
  '+import unittest',
  '+',
  '+import todo',
].join('\n')
const LOG = [
  '-- new series: start on coralbricks',
  't1   in    1265 hit       0 miss    1265 out    166 | read tests/test_dsk.py',
  '-- new series: failover on thirdparty',
  't2   in    2697 hit    2428 miss     269 out    163 | sh python3 -m unittest → 0',
].join('\n')
const REPORT = [
  'dsk 1c41 · review · coralbricks · 3 turns · in 6.6k (66% cached) · out 1.2k',
  'summary: Added tests/test_durations.py with 11 tests; all pass.',
  'checks:  python3 -m unittest discover -s tests → 0; ruff check . → 1',
  'scope:   reverted __pycache__/durations.pyc (copies in /state/1c41/reverted)',
  'changed: tests/test_durations.py (+73), durations.py (+4 -2), logo.png (binary)',
  'next:    dsk show 1c41 --review | dsk accept 1c41 | dsk reject 1c41 "defects"',
].join('\n')

type Start = { on?: boolean }

/**
 * Starts a session whose dsk answers `jobs`, with the display loaded unless
 * `on` is false, and lets the first reading land.
 */
const start = async ($: Engine, on: On, jobs: readonly Job[], options: Start = {}) => {
  const clock = mock.clock(on, { now: 160_000 })
  const ran: string[][] = []
  const world: { jobs: readonly Job[]; show?: string } = { jobs }
  const lines: (string | undefined)[] = []
  const toasts: string[] = []
  const closed: string[] = []
  const kept: Record<string, unknown> = options.on === false ? {} : { on: true }

  // What the plugin keeps across sessions: its `on` or `off`.
  on('store.get', (_, e) => ({ value: kept[e.key] }))
  on('store.set', (_, e) => {
    kept[e.key] = e.value

    return { value: undefined }
  })
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  on('command.register', () => ({ value: { command: 'dsk-jobs' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    lines.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'me' }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    const [, verb, , flag] = e.argv
    const stdout =
      verb === 'status'
        ? JSON.stringify({ jobs: world.jobs })
        : (world.show ?? (flag === '--diff' ? DIFF : LOG))
    // dsk exits 1 when it cannot show a job, with why on standard output.
    const exitCode = verb !== 'status' && world.show !== undefined ? 1 : 0

    return {
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  // The engine's own drawing: a tool row is its command, a result its first line.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    if (e.component === 'ToolUse') {
      return <Text>{`Bash(${(e.props.input as { command: string }).command})`}</Text>
    }

    return <Text>{e.component === 'ToolResult' ? 'raw result' : 'engine'}</Text>
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  return { clock, ran, world, lines, toasts, closed, kept }
}

const toolRow = (id: string, command: string, more: Record<string, unknown> = {}) =>
  ({
    plugin: 'dsk',
    component: 'ToolUse',
    requestId: id,
    surface: 'terminal',
    props: {
      tool_use_id: id,
      tool: 'Bash',
      input: { command },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...more,
    },
  }) as const

const result = (id: string, stdout: string, more: Record<string, unknown> = {}) =>
  ({
    plugin: 'dsk',
    component: 'ToolResult',
    requestId: id,
    surface: 'terminal',
    props: {
      tool_use_id: id,
      tool: 'Bash',
      output: { stdout, stderr: '', interrupted: false },
      isErrored: false,
      ...more,
    },
  }) as const

/**
 * Every whole row a drawing holds, top to bottom. A row's parts are Texts of
 * their own, found right after it and held in it: they are left out, and so is
 * the row the test's engine draws.
 */
const rowsOf = async (ui: { findAll: (query: { type: string }) => Promise<{ text: string }[]> }) => {
  const rows: string[] = []

  for (const { text } of await ui.findAll({ type: 'Text' })) {
    if (text !== 'engine' && !(rows.at(-1) ?? '').includes(text)) {
      rows.push(text)
    }
  }

  return rows
}

/** Runs `/dsk-jobs` as the person typing it does. */
const typed = ($: Engine, args: string) =>
  $.command.run({
    command: 'dsk-jobs',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

test('the display stays unloaded until /dsk-jobs on, and the choice is kept', async ($, on) => {
  const { ran, lines, closed, kept } = await start($, on, [RUNNING], { on: false })

  // Unloaded: dsk is not read, and every site is the engine's own.
  expect(ran).toEqual([])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine')
  await band.unmount()
  const row = await $.ui.mount(toolRow('t1', 'dsk run "Write apps/todo/ with tests"', { isRunning: true }))
  expect((await row.find({ type: 'Text' }))?.text).toBe('Bash(dsk run "Write apps/todo/ with tests")')
  await row.unmount()
  expect((await typed($, ''))?.text).toBe(
    'The dsk display is not loaded. /dsk-jobs on loads it.',
  )

  expect((await typed($, 'on'))?.text).toMatch(/^dsk display loaded/)
  expect(ran[0]?.slice(-2)).toEqual(['status', '--json'])
  expect(ran[0]?.[0]).toMatch(/\/scripts\/dsk\.py$/)
  expect(kept).toEqual({ on: true })
  const loaded = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await loaded.find({ type: 'Text', text: /^. dsk · / }))?.text).toMatch(/dsk · 1 worker/)
  await loaded.unmount()
  expect(lines.at(-1)).toBe('✻ dsk 1 running · ↑ 5.3k · ↓ 2.9k · 60% cached')

  expect((await typed($, 'off'))?.text).toMatch(/^dsk display unloaded/)
  expect(kept).toEqual({ on: false })
  expect(lines.at(-1)).toBeUndefined()
  expect(closed).toEqual(['dsk-jobs'])
  const unloaded = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await unloaded.find({ type: 'Text' }))?.text).toBe('engine')
  await unloaded.unmount()
})

test('the band draws a running job as a branch, on every surface', async ($, on) => {
  await start($, on, [RUNNING, REVIEW])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await rowsOf(ui)).toEqual([
      // The whole: the mark, how many run, how long, the tokens and the cached share.
      '· dsk · 1 worker (1m00s · ↑ 5.3k · ↓ 2.9k · 60% cached)',
      // The job: what it is for and its id, then what it does, three turns of twelve as a bar.
      '  └─ Write apps/todo/ with tests · ed3f',
      '     ⎿  Working… ██       3/12 · ↑ 5.3k · ↓ 2.9k · 60% cached · sh python3 -m unittest',
      '  ⏺ 1 waiting for you · /dsk-jobs',
    ])
    await ui.unmount()
  }
})

test('a job says what it runs now, when it is quiet, and where it failed over from', async ($, on) => {
  const jobs = [
    { ...RUNNING, id: 'a001', doing: 'pytest -q', brief: 'Job one' },
    { ...RUNNING, id: 'a002', phase: 'model', act: '', active: 90, brief: 'Job two' },
    { ...RUNNING, id: 'a003', phase: 'checks', act: '', failover: 'coralbricks 429', profile: 'thirdparty', brief: 'Job three' },
    ...['a004', 'a005', 'a006'].map(id => ({ ...RUNNING, id, act: '', brief: `Job ${id}` })),
  ]

  await start($, on, jobs)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect(await rowsOf(ui)).toEqual([
    '· dsk · 6 workers (1m00s · ↑ 31.8k · ↓ 17.4k · 60% cached)',
    '  ├─ Job one · a001',
    '  │  ⎿  Working… ██       3/12 · ↑ 5.3k · ↓ 2.9k · 60% cached · ▸ pytest -q',
    '  ├─ Job two · a002',
    '  │  ⎿  Thinking… ██       3/12 · ↑ 5.3k · ↓ 2.9k · 60% cached · quiet 1m10s',
    '  ├─ Job three · a003 · ↯ coralbricks 429 → thirdparty',
    '  │  ⎿  Checking… ██       3/12 · ↑ 5.3k · ↓ 2.9k · 60% cached',
    '  └─ Job a004 · a004',
    '     ⎿  Working… ██       3/12 · ↑ 5.3k · ↓ 2.9k · 60% cached',
    '  … and 2 more running · /dsk-jobs',
  ])
  await ui.unmount()
})

test('no band while nothing of this session runs', async ($, on) => {
  await start($, on, [REVIEW, { ...RUNNING, owner: 'another-session' }])

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the pane draws the jobs as trees with their cost, on every surface', async ($, on) => {
  await start($, on, [
    { ...RUNNING, cost: 0.0031 },
    { ...REVIEW, status: 'question', note: 'Which port?', cost: 0.0004 },
    { ...RUNNING, id: '88a0', owner: 'another-session', root: '/Users/x/aiharness', act: '' },
    { ...REVIEW, id: 'dd70', status: 'accepted', brief: 'Write apps/wordfreq/', cost: 0.02 },
  ])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await rowsOf(ui)).toEqual([
      '· dsk · 1 running   ⏺ 1 waiting   ✔ 1 finished',
      // 76% of ten cells: seven full, and five eighths of the eighth.
      '↑ 15.9k  ↓ 8.7k  cache ███████▋   76% · $0.02 · this session, last day',
      'Running',
      '  └─ Write apps/todo/ with tests · ed3f · coralbricks · 1m00s',
      '     ⎿  Working… ██       3/12 · ↑ 5.3k · ↓ 2.9k · 60% cached · $0.0031',
      '     ⎿  sh python3 -m unittest',
      'Other sessions',
      '  └─ Write apps/todo/ with tests · 88a0 · coralbricks · 1m00s · in aiharness',
      '     ⎿  Working… ██       3/12 · ↑ 5.3k · ↓ 2.9k · 60% cached',
      'Waiting for you',
      '  └─ Write apps/tictactoe/ · b498',
      '     ⎿  ⏺ asks a question · 4 turns · 1m30s · ↑ 5.3k · ↓ 2.9k · 84% cached · $0.0004',
      '     ⎿  Which port?',
      'Finished',
      '  └─ Write apps/wordfreq/ · dd70',
      '     ⎿  ✔ accepted · 4 turns · 1m30s · ↑ 5.3k · ↓ 2.9k · 84% cached · $0.02',
    ])
    // A job that changed files has its diff a press away; every job of ours has its turns.
    expect((await ui.findAll({ type: 'Button' })).map(button => button.text)).toEqual([
      'turns',
      'diff',
      'turns',
      'diff',
      'turns',
    ])
    await ui.unmount()
  }
})

test('a press in the pane shows a job diff or its turns, and back returns', async ($, on) => {
  const { ran, world } = await start($, on, [RUNNING, REVIEW])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'diff-b498' })
  expect(ran.at(-1)?.slice(1)).toEqual(['show', 'b498', '--diff'])
  expect(await rowsOf(ui)).toEqual([
    ' diff · b498',
    ' · Write apps/tictactoe/',
    'apps/todo/todo.py +2 -1',
    'apps/todo/test_todo.py +3',
  ])
  // Each file's lines are a diff the surface colours itself: whole hunks, counted anew.
  expect((await ui.findAll({ type: 'Code' })).map(code => code.text)).toEqual([
    '--- a/apps/todo/todo.py\n+++ b/apps/todo/todo.py\n@@ -1,3 +1,4 @@\n import json\n-import os\n+import sys\n+import argparse\n ',
    '--- a/apps/todo/test_todo.py\n+++ b/apps/todo/test_todo.py\n@@ -0,0 +1,3 @@\n+import unittest\n+\n+import todo',
  ])

  await ui.press({ key: 'back' })
  expect((await ui.find({ type: 'Text', text: /finished$/ }))?.text).toBe(
    '· dsk · 1 running   ⏺ 1 waiting   ✔ 0 finished',
  )

  // What dsk says when it cannot show a job is shown in its place.
  world.show = "dsk · error: [Errno 2] No such file or directory: '/gone'"
  await ui.press({ key: 'diff-b498' })
  expect(await rowsOf(ui)).toEqual([
    ' diff · b498',
    ' · Write apps/tictactoe/',
    "dsk · error: [Errno 2] No such file or directory: '/gone'",
  ])
  world.show = undefined
  await ui.press({ key: 'back' })

  await ui.press({ key: 'log-ed3f' })
  expect(ran.at(-1)?.slice(1)).toEqual(['show', 'ed3f', '--log'])
  expect(await rowsOf(ui)).toEqual([
    ' turns · ed3f',
    ' · Write apps/todo/ with tests',
    '↯ start on coralbricks',
    // Each turn: its cache level as a bar, the tokens in and out, what it did.
    't1           0%   ↑ 1.3k  ↓ 0.2k  read tests/test_dsk.py',
    '↯ failover on thirdparty',
    't2  ███████▎ 90%  ↑ 2.7k  ↓ 0.2k  sh python3 -m unittest → 0',
  ])
  await ui.unmount()
})

test('a dsk run row names the brief and shows its job while it runs', async ($, on) => {
  await start($, on, [RUNNING])

  const command =
    "cd /repo && dsk run --worktree --allow 'apps/todo/**' --owner me \"Write apps/todo/  with tests\""
  const row = toolRow('toolu_1', command, { isRunning: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row, surface })

    expect(await rowsOf(ui)).toEqual([
      'Bash(dsk run: Write apps/todo/ with tests)',
      '  ⎿  Working… ██       3/12 · ↑ 5.3k · ↓ 2.9k · 60% cached · ed3f · 1m00s',
    ])
    // In the phone app the row is framed, which makes it a card drawn without a tap.
    expect((await ui.findAll({ type: 'Box' })).some(box => box.props.borderStyle === 'round')).toBe(
      surface === 'mobile',
    )
    await ui.unmount()
  }

  // ctrl+o shows the command as it was run, and a finished call has its own result under it.
  const whole = await $.ui.mount(toolRow('toolu_1', command, { isRunning: true, isExpanded: true }))

  expect((await whole.find({ type: 'Text' }))?.text).toBe(`Bash(${command})`)
  await whole.unmount()

  const done = await $.ui.mount(
    toolRow('toolu_1', command, {
      output: { stdout: 'dsk ed3f · review · coralbricks · 3 turns', stderr: '' },
    }),
  )

  expect(await done.find({ type: 'Text', text: /⎿/ })).toBeUndefined()
  await done.unmount()
})

test('a run sent to the background keeps its line, and says how it stopped', async ($, on) => {
  const { clock, world } = await start($, on, [RUNNING])
  const row = toolRow('toolu_5', 'dsk run --worktree "Write apps/todo/ with tests"', {
    output: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
  })
  const running = await $.ui.mount(row)

  expect((await running.find({ type: 'Text', text: /^ +⎿/ }))?.text).toMatch(/⎿ {2}Working… ██ /)
  await running.unmount()

  world.jobs = [{ ...RUNNING, status: 'review', phase: '', turn: 4, turns: 4, act: '', active: 190 }]
  await clock.advance(2000)
  const stopped = await $.ui.mount(row)

  expect((await stopped.find({ type: 'Text', text: /^ +⎿/ }))?.text).toBe(
    '  ⎿  ⏺ ready for review · 4 turns · 1m30s · ↑ 5.3k · ↓ 2.9k · 60% cached · ed3f',
  )
  await stopped.unmount()
})

test('a dsk report is drawn as a card, and a packet diff as a diff', async ($, on) => {
  await start($, on, [])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...result('r1', REPORT), surface })

    expect(await rowsOf(ui)).toEqual([
      // How it stopped, its figures as the tree draws them, the provider and the id.
      '  ⎿  ⏺ ready for review · 3 turns · ↑ 6.6k · ↓ 1.2k · 66% cached · coralbricks · 1c41',
      'Added tests/test_durations.py with 11 tests; all pass.',
      // A check that passed, and one that failed with its exit code.
      '✔ python3 -m unittest discover -s tests',
      '✘ ruff check . → 1',
      // Each changed file with its lines added and removed.
      'tests/test_durations.py +73',
      'durations.py +4 -2',
      'logo.png binary',
      'scope: reverted __pycache__/durations.pyc (copies in /state/1c41/reverted)',
      'next: dsk show 1c41 --review | dsk accept 1c41 | dsk reject 1c41 "defects"',
    ])
    await ui.unmount()
  }

  const packet = [
    'dsk b498 · stuck · thirdparty · 9 turns · in 54.3k (80% cached) · out 5.3k',
    'brief:   Write apps/tictactoe/',
    'why:     same reply twice in a row',
    'changed: apps/todo/todo.py (+2 -1), apps/todo/test_todo.py (+3)',
    DIFF,
    '... 186 more diff lines: dsk show b498 --diff',
    'next:    dsk show b498 --diff | dsk accept b498',
  ].join('\n')
  const stuck = await $.ui.mount(result('r2', packet))

  expect(await rowsOf(stuck)).toEqual([
    '  ⎿  ✘ stuck · 9 turns · ↑ 54.3k · ↓ 5.3k · 80% cached · thirdparty · b498',
    // What was asked, why it stopped, then each file of the diff once, with its counts.
    'brief: Write apps/tictactoe/',
    'why: same reply twice in a row',
    'apps/todo/todo.py +2 -1',
    'apps/todo/test_todo.py +3',
    '... 186 more diff lines: dsk show b498 --diff',
    'next: dsk show b498 --diff | dsk accept b498',
  ])
  expect(await stuck.findAll({ type: 'Code' })).toHaveLength(2)
  await stuck.unmount()

  // A line that only closes a session has no figures: its words are kept.
  const accepted = await $.ui.mount(
    result('r3', 'dsk 1c41 · accepted · 1 file already in your working tree'),
  )

  expect(await rowsOf(accepted)).toEqual([
    '  ⎿  ✔ accepted · 1 file already in your working tree · 1c41',
  ])
  await accepted.unmount()
})

test('a long diff is cut to whole lines that still parse, and says what it left out', async ($, on) => {
  await start($, on, [])
  const long = [
    'diff --git a/big.py b/big.py',
    '--- /dev/null',
    '+++ b/big.py',
    '@@ -0,0 +1,100 @@',
    ...Array.from({ length: 100 }, (_, n) => `+line ${n + 1}`),
  ].join('\n')
  const ui = await $.ui.mount(
    result('r4', ['dsk 1c41 · review · a · 1 turn · in 1.0k · out 0.1k', long].join('\n')),
  )
  const code = (await ui.find({ type: 'Code' }))?.text ?? ''

  // Sixty lines are kept, under a header that counts sixty.
  expect(code.split('\n').slice(0, 4)).toEqual(['--- a/big.py', '+++ b/big.py', '@@ -0,0 +1,60 @@', '+line 1'])
  expect(code.split('\n')).toHaveLength(63)
  expect((await ui.find({ type: 'Text', text: /more diff lines/ }))?.text).toBe('… 40 more diff lines')
  expect((await ui.find({ type: 'Text', text: /^big\.py/ }))?.text).toBe('big.py +100')
  await ui.unmount()
})

test('only a dsk call has its bare diff drawn, and other output is left alone', async ($, on) => {
  await start($, on, [])

  // `git diff` prints the same text, and stays the engine's.
  const other = await $.ui.mount(result('g1', DIFF))
  expect((await other.find({ type: 'Text' }))?.text).toBe('raw result')
  await other.unmount()

  await $.tool.call({ tool: 'Bash', command: 'dsk show b498 --diff', tool_use_id: 'd1' })
  const ours = await $.ui.mount(result('d1', DIFF))
  expect(await rowsOf(ours)).toEqual(['apps/todo/todo.py +2 -1', 'apps/todo/test_todo.py +3'])
  expect(await ours.findAll({ type: 'Code' })).toHaveLength(2)
  await ours.unmount()

  for (const [id, stdout, more] of [
    ['x1', 'total 8\ndrwxr-xr-x  2 me  staff  64 Nov 13 20:04 dsk', {}],
    // Several reports in one output are several jobs: no one card says them all.
    ['x2', `${REPORT}\n${REPORT.replace('1c41', '2d52')}`, {}],
    // ctrl+o shows what was printed, as it was printed.
    ['x3', REPORT, { isExpanded: true }],
  ] as const) {
    const ui = await $.ui.mount(result(id, stdout, more))
    expect((await ui.find({ type: 'Text' }))?.text).toBe('raw result')
    await ui.unmount()
  }
})

test('another command is left to the engine, and dsk is read less often when idle', async ($, on) => {
  const { clock, ran } = await start($, on, [REVIEW])

  // What only mentions dsk is no dsk call; what runs it is titled by its own argument.
  const titles: Record<string, string> = {
    'git status': 'git status',
    'grep -n "dsk run" README.md': 'grep -n "dsk run" README.md',
    'git commit -m "Fix dsk reject b498 output"': 'git commit -m "Fix dsk reject b498 output"',
    "dsk run --check 'python3 -m unittest' \"Add tests\"; echo \"exit=$?\"": 'dsk run: Add tests',
    'for i in 1 2; do dsk run --owner me "Compute 17"; done': 'dsk run: Compute 17',
    '. ~/.config/dsk/env && ~/dsk/skill/scripts/dsk.py reject b498 "1. Fix \\"it\\""':
      'dsk reject b498: 1. Fix "it"',
    'cd /repo && dsk answer b498 \'Use port 8080\'': 'dsk answer b498: Use port 8080',
    'dsk reject b498 --drop': 'dsk reject b498',
    // What comes after the dsk command is another command's, not what dsk was told.
    'dsk run --brief task.md; echo "exit=$?"': 'dsk run',
    // Words in quotes or in a here-document are text, however much they look like a call.
    'echo "next; dsk run it"': 'echo "next; dsk run it"',
    "python3 - <<'EOF'\ncases = ['for i in 1 2; do dsk run \"Compute 17\"; done']\nEOF\necho done":
      "python3 - <<'EOF'\ncases = ['for i in 1 2; do dsk run \"Compute 17\"; done']\nEOF\necho done",
    "cat > note.txt <<EOF\ndsk reject b498 \"later\"\nEOF\ndsk answer b498 \"Use 8080\"":
      'dsk answer b498: Use 8080',
    // A call that only reads a session keeps its own row.
    'cd /repo && dsk show b498 --review': 'cd /repo && dsk show b498 --review',
    'dsk accept b498': 'dsk accept b498',
  }

  for (const [command, title] of Object.entries(titles)) {
    const shown = await $.ui.mount(toolRow('toolu_4', command))

    expect((await shown.find({ type: 'Text' }))?.text).toBe(`Bash(${title})`)
    await shown.unmount()
  }

  const before = ran.length
  await clock.advance(16_000)

  expect(ran.length - before).toBe(1)

  // A dsk call in flight is read every period.
  await $.tool.call({ tool: 'Bash', command: 'dsk run "x"', tool_use_id: 'toolu_3' })
  const during = ran.length
  await clock.advance(6_000)

  expect(ran.length - during).toBe(3)
})

test('the status line follows what runs, the mark moves, and a stop is said', async ($, on) => {
  const { clock, world, lines, toasts } = await start($, on, [RUNNING])

  expect(lines).toEqual(['✻ dsk 1 running · ↑ 5.3k · ↓ 2.9k · 60% cached'])

  // Three frames on, the mark is the fourth of Claude Code's own.
  await clock.advance(900)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /^. dsk · / }))?.text).toMatch(/^✶ dsk · 1 worker/)
  await ui.unmount()

  world.jobs = [{ ...RUNNING, status: 'stuck', phase: '', note: 'same reply twice in a row' }]
  await clock.advance(2000)

  expect(toasts).toEqual(['✘ dsk ed3f stuck · same reply twice in a row'])
  expect(lines.at(-1)).toBe('⏺ dsk 1 waiting for you · /dsk-jobs')

  // Dropped, nothing is left to say, and the next idle reading clears the line.
  world.jobs = [{ ...RUNNING, status: 'dropped', phase: '' }]
  await clock.advance(16_000)

  expect(lines.at(-1)).toBeUndefined()
  expect(lines).toHaveLength(3)
})
