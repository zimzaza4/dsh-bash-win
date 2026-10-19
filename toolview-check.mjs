// Smoke test for the dsh-bash-win toolview client half.
//
// Loads lib/client.js in a stubbed browser (ModuleLoader + document + react),
// captures the component the plugin registers into `tool.call.toolview`, and
// replays the real Client block shapes: preparing (partial args), start
// (running) and result (settled). Run: node .tmp-toolview-check.mjs
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')

let loaded = null
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {} }),
  head: { appendChild: () => {} }
}
globalThis.document = documentStub
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: () => [true, () => {}]
}
const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

// eslint-disable-next-line no-eval
eval(source)

const captured = {}
const ctx = {
  get: (key) => key === 'slots'
    ? {
        inject: (_name, fn) => fn(),
        register: (spec, component) => { captured[spec.key] = component; return () => {} }
      }
    : undefined
}
loaded.factory(requireStub).apply(ctx)

function walk(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (typeof node.type === 'function') { walk(node.type(node.props), out); return out }
  out.nodes.push({ type: node.type, props: node.props, children: node.children })
  walk(node.children, out)
  return out
}

function render(component, props) {
  const out = walk(component(props), { text: [], nodes: [] })
  const node = (cls) => out.nodes.find((n) => n.props.className === cls)
  const textOf = (cls) => {
    const hit = out.nodes.find((n) => n.props.className === cls)
    return hit === undefined ? '' : walk(hit, { text: [], nodes: [] }).text.join('')
  }
  return { text: out.text.join('\n'), nodes: out.nodes, node, textOf }
}

const ARGS = JSON.stringify({
  command: 'npm run build',
  description: 'Build the web bundle',
  workdir: 'D:\\work\\demo-repo'
})
const CALL = { name: 'git_bash', argsRaw: ARGS }

let failed = 0
function check(label, actual, expected) {
  const ok = expected instanceof RegExp ? expected.test(actual) : actual === expected
  if (!ok) failed++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : `\n      expected: ${expected}\n      actual:   ${JSON.stringify(actual)}`))
}

const gitBash = captured.git_bash
const wslBash = captured.wsl_bash
check('both wire names registered', `${gitBash !== undefined}/${wslBash !== undefined}`, 'true/true')

// 1. preparing: truncated argument stream, command must already be visible.
const preparing = render(gitBash, {
  phase: 'preparing',
  toolName: 'git_bash',
  block: { phase: 'preparing', callId: 'c1', name: 'git_bash', turn: 0, step: 0, time: 0, subCalls: [] },
  useToolCallArgumentsPartial: () => '{"command":"git status --short","desc'
})
check('preparing shows the streamed command', preparing.textOf('bashx-summary'), 'git status --short')

const preparingEscaped = render(gitBash, {
  phase: 'preparing',
  toolName: 'git_bash',
  block: { phase: 'preparing', callId: 'c1', name: 'git_bash', turn: 0, step: 0, time: 0, subCalls: [] },
  useToolCallArgumentsPartial: () => '{"command":"echo \\"hi\\" && ls'
})
check('preparing unescapes quotes', preparingEscaped.textOf('bashx-summary'), 'echo "hi" && ls')

const preparingEmpty = render(gitBash, {
  phase: 'preparing',
  toolName: 'wsl_bash',
  block: { phase: 'preparing', callId: 'c2', name: 'wsl_bash', turn: 0, step: 0, time: 0, subCalls: [] }
})
check('preparing without the hook does not throw', preparingEmpty.textOf('bashx-summary'), 'preparing…')

// 2. start (running): the command must be visible before any result exists.
const running = render(gitBash, {
  phase: 'start',
  toolName: 'git_bash',
  callId: 'c3',
  cwd: 'D:\\work\\demo-repo',
  block: { phase: 'start', callId: 'c3', name: 'git_bash', argsRaw: ARGS, turn: 0, step: 0, time: 0, subCalls: [] }
})
check('running row state', running.node('bashx-root').props['data-state'], 'running')
check('running summary is the command', running.textOf('bashx-summary'), 'npm run build')
check('running expanded head shows the command', running.textOf('bashx-termCommand'), 'npm run build')
check('running shows cwd prompt', running.textOf('bashx-termPrompt'), 'D:\\work\\demo-repo $')
check('running has no output yet', running.nodes.some((n) => n.props.className === 'bashx-termOutput'), false)

// 3. result (settled): command stays visible, echo/marker are consumed, pill appears.
const settled = render(gitBash, {
  phase: 'result',
  toolName: 'git_bash',
  callId: 'c3',
  cwd: 'D:\\work\\demo-repo',
  block: {
    kind: 'tool-result',
    seq: 9,
    time: 0,
    callId: 'c3',
    call: CALL,
    content: [{ type: 'text', text: '$ npm run build\n> dist/index.js  12.4 kB\n[exit code: 3]' }],
    isError: false,
    meta: { exitCode: 3, signal: '', timedOut: false, aborted: false, timeoutMs: 0, stdout: '> dist/index.js  12.4 kB', stderr: '' },
    subCalls: []
  }
})
check('settled summary is the command', settled.textOf('bashx-summary'), 'npm run build')
check('settled head shows the command', settled.textOf('bashx-termCommand'), 'npm run build')
check('settled body drops the $ echo', settled.textOf('bashx-termOutput'), '> dist/index.js  12.4 kB')
check('settled status pill', settled.textOf('bashx-termStatus'), 'exit code: 3')
check('settled exit marker absent from body', /\$ npm run build|\[exit code/.test(settled.textOf('bashx-termOutput')), false)
check('description kept in the body', settled.textOf('bashx-termDesc'), 'Build the web bundle')

// 4. killed by signal: the pill must name the signal, not -1.
const killed = render(gitBash, {
  phase: 'result',
  toolName: 'git_bash',
  callId: 'c4',
  block: {
    kind: 'tool-result',
    seq: 10,
    time: 0,
    callId: 'c4',
    call: CALL,
    content: [{ type: 'text', text: '$ npm run build\npartial output\n[exit code: -1]' }],
    isError: false,
    meta: { exitCode: -1, signal: 'SIGTERM', timedOut: false, aborted: false, timeoutMs: 0, stdout: 'partial output', stderr: '' },
    subCalls: []
  }
})
check('killed pill names the signal', killed.textOf('bashx-termStatus'), 'SIGTERM')
check('killed body drops the -1 marker', killed.textOf('bashx-termOutput'), 'partial output')

// 5. timeout: renderer notice stays in the body, no duplicate pill.
const timedOut = render(gitBash, {
  phase: 'result',
  toolName: 'wsl_bash',
  callId: 'c5',
  block: {
    kind: 'tool-result',
    seq: 11,
    time: 0,
    callId: 'c5',
    call: CALL,
    content: [{ type: 'text', text: '$ npm run build\nslow\n[timed out after 1000 ms]' }],
    isError: false,
    meta: { exitCode: -1, signal: '', timedOut: true, aborted: false, timeoutMs: 1000, stdout: 'slow', stderr: '' },
    subCalls: []
  }
})
check('timeout notice kept in the body', timedOut.textOf('bashx-termOutput'), 'slow\n[timed out after 1000 ms]')
check('timeout shows no status pill', timedOut.nodes.some((n) => n.props.className === 'bashx-termStatus'), false)

// 6. background job: acknowledgement body, no exit pill.
const background = render(gitBash, {
  phase: 'result',
  toolName: 'git_bash',
  callId: 'c6',
  block: {
    kind: 'tool-result',
    seq: 12,
    time: 0,
    callId: 'c6',
    call: { name: 'git_bash', argsRaw: JSON.stringify({ command: 'npm run dev', description: 'Start dev server', run_in_background: true }) },
    content: [{ type: 'text', text: 'started background job job-7' }],
    isError: false,
    meta: { background: true, jobId: 'job-7' },
    subCalls: []
  }
})
check('background summary is the command', background.textOf('bashx-summary'), 'npm run dev')
check('background body kept', background.textOf('bashx-termOutput'), 'started background job job-7')
check('background shows no exit pill', background.nodes.some((n) => n.props.className === 'bashx-termStatus'), false)

// 7. windowless/malformed result must not throw and must fall back to the title.
const malformed = render(gitBash, {
  phase: 'result',
  toolName: 'git_bash',
  callId: 'c7',
  block: { kind: 'tool-result', seq: 13, time: 0, callId: 'c7', call: null, content: [], isError: true, subCalls: [] }
})
check('windowless result falls back to the title', malformed.textOf('bashx-summary'), 'Git Bash')
check('windowless result is marked error', malformed.node('bashx-root').props['data-state'], 'error')

// 8. promoted: the call stopped waiting and the command keeps running as a job.
const promoted = render(gitBash, {
  phase: 'result',
  toolName: 'git_bash',
  callId: 'c8',
  block: {
    kind: 'tool-result',
    seq: 14,
    time: 0,
    callId: 'c8',
    call: CALL,
    content: [{ type: 'text', text: '$ npm run build\ntick 1\ntick 2\n[still running after 3000ms; moved to background job bash-9]' }],
    isError: false,
    meta: { promoted: true, jobId: 'bash-9', timeoutMs: 3000, stdout: 'tick 1\ntick 2' },
    subCalls: []
  }
})
check('promoted summary is the command', promoted.textOf('bashx-summary'), 'npm run build')
check('promoted body is the partial output', promoted.textOf('bashx-termOutput'), 'tick 1\ntick 2')
check('promoted status names the job', promoted.textOf('bashx-termStatus'), 'moved to background: bash-9')
check('promoted shows no exit pill', /exit code/.test(promoted.text), false)

// 9. a human stop recorded by the job view reaches the card.
const humanStopped = render(gitBash, {
  phase: 'result',
  toolName: 'git_bash',
  callId: 'c9',
  block: {
    kind: 'tool-result',
    seq: 15,
    time: 0,
    callId: 'c9',
    call: CALL,
    content: [{ type: 'text', text: '$ npm run build\npartial output\n[exit code: -1]' }],
    isError: false,
    meta: { exitCode: -1, signal: 'SIGTERM', timedOut: false, aborted: false, timeoutMs: 0, stopped: 'cancelled by the user', stdout: 'partial output', stderr: '' },
    subCalls: []
  }
})
check('human stop is shown as a stop, not a signal', humanStopped.textOf('bashx-termStatus'), 'stopped: cancelled by the user')
check('human stop body keeps the partial output', humanStopped.textOf('bashx-termOutput'), 'partial output')

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
