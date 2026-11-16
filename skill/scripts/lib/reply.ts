// The worker's reply: the one run_code call it must be, and the AST gate, which stays in Python, in runner.py, since
// it parses the worker's Python; gate() asks it.
import type { ChildProcess } from 'node:child_process'
import { RUNNER, pythonPath } from './base.ts'

/** The script of a reply that is exactly one valid run_code call. null for anything else. */
export function parse(reply: any): string | null {
  const calls = reply !== null && typeof reply === 'object' && Object.hasOwn(reply, 'tool_calls') ? reply.tool_calls : []
  let code: unknown
  try {
    const raw = calls[0].function.arguments
    if (typeof raw !== 'string') return null // json.loads of anything else raised TypeError
    const args = JSON.parse(raw)
    if (args === null || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'code')) return null
    code = args.code
  } catch {
    return null
  }
  return Array.isArray(calls) && calls.length === 1 && calls[0].function.name === 'run_code' && typeof code === 'string'
    ? code : null
}

let gates: { child: ChildProcess; answers: AsyncIterator<string> } | null = null

/**
 * Refuse a script that would act outside the function API: runner.py's gate(). A one-line reason, or null.
 * dsk.py checked each script in its own process; here one `runner.py gates` process serves the whole run, so a turn
 * does not pay for a Python start (32 ms). The script goes over as JSON, so it reaches ast.parse() exactly as
 * json.loads gave it to dsk.py.
 */
export async function gate(script: string): Promise<string | null> {
  if (!gates) {
    // -X utf8: the pipe is UTF-8 whatever the locale says; -I leaves no PYTHON* variable to do it.
    const child = process.getBuiltinModule('node:child_process').spawn(pythonPath(), ['-I', '-X', 'utf8', RUNNER, 'gates'], { stdio: ['pipe', 'pipe', 'inherit'] })
    child.on('error', () => {})  // a failed start shows as the end of its answers, below
    child.stdin!.on('error', () => {})  // and so does a helper that died: writing to it fails with EPIPE
    gates = { child, answers: process.getBuiltinModule('node:readline').createInterface({ input: child.stdout! })[Symbol.asyncIterator]() }
    process.on('exit', () => child.kill())
  }
  const { child, answers } = gates
  // Held only while an answer is due: an idle helper must not keep dsk from exiting.
  child.ref()
  ;(child.stdout as any).ref?.()
  try {
    child.stdin!.write(JSON.stringify(script) + '\n')
    const answer = await answers.next()
    if (answer.done) {
      gates = null
      throw new Error('runner.py gates stopped answering')
    }
    return JSON.parse(answer.value)
  } finally {
    child.unref()
    ;(child.stdout as any).unref?.()
    ;(child.stdin as any).unref?.()
  }
}
