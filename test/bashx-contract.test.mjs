// Host-side contract test for @zimzaza4/dsh-bash-win, run against the source
// with the host packages stubbed. Covers the shipped shell-tool alignment:
// parameter surface, result schema shape, render text, promoted/background
// semantics, config switches, abort semantics, workdir and sandbox facts.
//
//   node test/bashx-contract.test.mjs
import { register } from 'node:module'
import assert from 'node:assert/strict'

register('./stubs/register.mjs', import.meta.url)
const plugin = await import('../lib/index.js')
const { TOOL_ABORTED } = await import('./stubs/tools.mjs')
const { HarnessError } = await import('./stubs/llm.mjs')

let passed = 0
function check(label, fn) {
  fn()
  passed += 1
  console.log('ok   ' + label)
}
async function checkAsync(label, fn) {
  await fn()
  passed += 1
  console.log('ok   ' + label)
}

// ---------------------------------------------------------------- fixtures --
function reader(text) {
  return { readFrom: (from) => ({ text: text.slice(from), nextOffset: text.length, lossy: false }) }
}
function handleOf(next) {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const handle = {
    collected: { stdout: reader(next.stdout ?? ''), stderr: reader(next.stderr ?? '') },
    done,
    terminate: () => {
      settle({ exitCode: null, signal: 'SIGTERM' })
    },
  }
  if (next.settle) queueMicrotask(() => settle({ exitCode: next.exitCode ?? 0, signal: next.signal ?? null }))
  return handle
}
function makeSubprocess() {
  const state = { next: {}, spawned: [] }
  return {
    state,
    spawn(spec) {
      state.spawned.push(spec)
      return handleOf(state.next)
    },
  }
}
function makeJobs() {
  const state = { started: [], waitPlan: [], readChunks: [], removals: [], kills: [], controller: null }
  return {
    state,
    start(spec) {
      state.started.push(spec)
      state.controller = spec.run()
      return 'job-1'
    },
    async wait() {
      const step = state.waitPlan.shift()
      return typeof step === 'function' ? step(state) : (step ?? { status: 'completed' })
    },
    read() { return { chunks: state.readChunks } },
    kill(id, owner, reason) { state.kills.push(reason); return true },
    remove(id) { state.removals.push(id); return true },
  }
}
const idleTimer = { timeout: () => () => {} }
function makeCtx(services = {}) {
  const map = {
    fs: { lstat: async (path) => (/bash\.exe$|wsl\.exe$/i.test(path) ? { path } : undefined) },
    subprocess: makeSubprocess(),
    jobs: undefined,
    timer: idleTimer,
    ...services,
  }
  const registrations = []
  const sections = []
  const ctx = {
    registrations,
    sections,
    get: (name) => map[name],
    logger: { warn: () => {} },
    tools: { register: (definition) => { registrations.push(definition); return () => {} } },
    systemPrompt: {
      getSectionOrder: (name) => ({ TOOL_BASH: 1000, TOOL_PWSH: 1010 }[name] ?? 2000),
      section: (section) => { sections.push(section); return () => {} },
    },
  }
  return ctx
}
function execOf(overrides = {}) {
  return {
    agent: { id: 'sess-1', session: { header: { cwd: 'C:\\work' } } },
    callId: 'call-1',
    rootCallId: 'root-1',
    signal: { aborted: false },
    ...overrides,
  }
}
function install(config, services) {
  const ctx = makeCtx(services)
  plugin.apply(ctx, config ?? {})
  const byName = Object.fromEntries(ctx.registrations.map((t) => [t.name, t]))
  return { ctx, git: byName.git_bash, wsl: byName.wsl_bash, sections: ctx.sections }
}

// ------------------------------------------------------- registration surface --
const { git, wsl, sections } = install()

check('both tools register', () => assert.deepEqual([git.name, wsl.name], ['git_bash', 'wsl_bash']))
check('git_bash parameter surface matches the shipped shell tools', () => {
  assert.deepEqual(
    Object.keys(git.parameters),
    ['description', 'command', 'timeoutMs', 'workdir', 'run_in_background', 'require_approval'],
  )
  assert.equal(git.parameters.sandbox, undefined, 'git_bash no longer exposes a sandbox lever')
})
check('wsl_bash keeps its WSL-only levers', () => {
  assert.deepEqual(
    Object.keys(wsl.parameters),
    ['description', 'command', 'timeoutMs', 'workdir', 'run_in_background', 'distro', 'sandbox', 'sandbox_permissions', 'justification'],
  )
})
check('result schema is the shipped foreground/promoted/background union', () => {
  assert.equal(git.output.schema.oneOf.length, 3)
  const foreground = git.output.schema.oneOf[2].properties
  assert.equal(foreground.stdout.type, 'object')
  assert.equal(foreground.stderr.type, 'object')
  assert.equal(foreground.sandbox.properties.mode.required, true)
})
check('prompt sections take the shipped bash/pwsh slots, in order', () => {
  assert.deepEqual(sections.map((s) => s.name), ['tool:git_bash', 'tool:wsl_bash'])
  assert.equal(sections[0].order, 1000)
  assert.equal(sections[1].order, 1010)
  assert.match(sections[0].text, /\[exit code: N\]/)
  assert.match(sections[0].text, /moves to a background job/)
})

// ------------------------------------------------------------ foreground path --
async function runForeground(args, services, config) {
  const subprocess = makeSubprocess()
  const env = install(config, { subprocess, ...services })
  subprocess.state.next = { stdout: 'hello\n', exitCode: 0, settle: true }
  const value = await env.git.execute.call(env.git, { command: 'echo hi', description: 'Say hi', ...args }, execOf())
  return { value, subprocess, env }
}

await checkAsync('a clean foreground success publishes the shipped nested shape', async () => {
  const { value } = await runForeground(undefined, {})
  assert.equal(value.kind, 'foreground')
  assert.equal(value.cwd, 'C:\\work')
  assert.equal(value.exitCode, 0)
  assert.equal(value.signal, null)
  assert.deepEqual(value.stdout, { text: 'hello\n', truncated: false })
  assert.deepEqual(value.stderr, { text: '', truncated: false })
  assert.equal(value.timeoutMs, 120000)
  assert.equal(git.output.render({}, value)[0].text, 'hello\n')
})

await checkAsync('a relative workdir resolves against the session cwd', async () => {
  const { value, subprocess } = await runForeground({ workdir: 'sub/dir' }, {})
  assert.equal(subprocess.state.spawned[0].cwd, 'C:\\work\\sub\\dir')
  assert.equal(value.cwd, 'C:\\work\\sub\\dir')
})

await checkAsync('timeouts are validated, defaulted and capped like the executor', async () => {
  const { value: capped } = await runForeground({ timeoutMs: 900000 }, {})
  assert.equal(capped.timeoutMs, 600000)
  const subprocess = makeSubprocess()
  const env = install(undefined, { subprocess })
  await assert.rejects(
    () => env.git.execute.call(env.git, { command: 'x', description: 'd', timeoutMs: 0 }, execOf()),
    /invalid timeoutMs/,
  )
})

await checkAsync('non-zero exit and stderr render as the shipped marker contract', async () => {
  const subprocess = makeSubprocess()
  const env = install(undefined, { subprocess })
  subprocess.state.next = { stdout: 'out\n', stderr: 'err\n', exitCode: 2, settle: true }
  const value = await env.git.execute.call(env.git, { command: 'x', description: 'd' }, execOf())
  assert.equal(env.git.output.render({}, value)[0].text, 'out\n[stderr]\nerr\n[exit code: 2]')
  const meta = env.git.output.presentationMeta({}, value)
  assert.equal(meta.exitCode, 2)
  const card = env.git.presentResult({}, { meta, content: [] })
  assert.equal(card.card, 'terminal')
  assert.equal(card.exitCode, 2)
})

await checkAsync('a zero exit draws no card pill', async () => {
  const subprocess = makeSubprocess()
  const env = install(undefined, { subprocess })
  subprocess.state.next = { stdout: 'ok', exitCode: 0, settle: true }
  const value = await env.git.execute.call(env.git, { command: 'x', description: 'd' }, execOf())
  const card = env.git.presentResult({}, { meta: env.git.output.presentationMeta({}, value), content: [] })
  assert.equal(card.exitCode, undefined)
  assert.equal(card.output, 'ok')
})

// ------------------------------------------------------- jobs: promote/stop --
await checkAsync('a timed-out foreground call promotes to a job with the output so far', async () => {
  const subprocess = makeSubprocess()
  const jobs = makeJobs()
  const env = install(undefined, { subprocess, jobs })
  subprocess.state.next = { stdout: 'tick 1\n', settle: true }
  jobs.state.waitPlan.push({ status: 'running' })
  jobs.state.readChunks = [{ channel: 'stdout', text: 'tick 1\n' }]
  const value = await env.git.execute.call(env.git, { command: 'npm run build', description: 'Build', timeoutMs: 5000 }, execOf())
  assert.equal(value.kind, 'promoted')
  assert.equal(value.jobId, 'job-1')
  assert.equal(value.timeoutMs, 5000)
  assert.equal(value.output, 'tick 1\n')
  assert.equal(env.git.output.render({}, value)[0].text, 'tick 1\n[still running after 5000ms; moved to background job job-1]')
  assert.equal(jobs.state.started[0].kind, 'bash')
  assert.deepEqual(jobs.state.started[0].toolCall, { callId: 'call-1', rootCallId: 'root-1' })
})

await checkAsync('a settled job reports its exit and removes the record', async () => {
  const subprocess = makeSubprocess()
  const jobs = makeJobs()
  const env = install(undefined, { subprocess, jobs })
  subprocess.state.next = { stdout: 'done\n', exitCode: 0, settle: true }
  jobs.state.waitPlan.push({ status: 'completed' })
  const value = await env.git.execute.call(env.git, { command: 'x', description: 'd' }, execOf())
  assert.equal(value.exitCode, 0)
  assert.deepEqual(jobs.state.removals, ['job-1'])
})

await checkAsync('a human stop reaches the model as [stopped: reason]', async () => {
  const subprocess = makeSubprocess()
  const jobs = makeJobs()
  const env = install(undefined, { subprocess, jobs })
  subprocess.state.next = { stdout: 'partial', settle: false }
  jobs.state.waitPlan.push((state) => {
    state.controller.cancel('cancelled by the user')
    return { status: 'killed' }
  })
  const value = await env.git.execute.call(env.git, { command: 'x', description: 'd' }, execOf())
  assert.equal(value.stopped, 'cancelled by the user')
  assert.match(env.git.output.render({}, value)[0].text, /\[stopped: cancelled by the user\]/)
})

await checkAsync('run_in_background returns the job id and the ack card', async () => {
  const subprocess = makeSubprocess()
  const jobs = makeJobs()
  const env = install(undefined, { subprocess, jobs })
  subprocess.state.next = { stdout: '', settle: true }
  const value = await env.git.execute.call(env.git, { command: 'npm run dev', description: 'Start', run_in_background: true }, execOf())
  assert.deepEqual(value, { kind: 'background', jobId: 'job-1', cwd: 'C:\\work' })
  assert.equal(env.git.output.render({}, value)[0].text, 'started background job job-1')
  const card = env.git.presentResult({}, { meta: env.git.output.presentationMeta({}, value), content: env.git.output.render({}, value) })
  assert.equal(card.card, 'generic')
  assert.match(card.content[0].text, /^```console\nstarted background job job-1\n```$/)
})

// ------------------------------------------------------------- config, abort --
await checkAsync('enableRunInBackground: false hides and rejects the background surface', async () => {
  const subprocess = makeSubprocess()
  const env = install({ enableRunInBackground: false }, { subprocess, jobs: makeJobs() })
  assert.equal(env.git.parameters.run_in_background, undefined)
  assert.match(env.git.parameters.timeoutMs.description, /killed on expiry/)
  await assert.rejects(
    () => env.git.execute.call(env.git, { command: 'x', description: 'd', run_in_background: true }, execOf()),
    /disabled for this deployment/,
  )
})

await checkAsync('promoteOnTimeout: false keeps the foreground and kills on expiry', async () => {
  const subprocess = makeSubprocess()
  const jobs = makeJobs()
  const firingTimer = { timeout(fn) { queueMicrotask(fn); return () => {} } }
  const env = install({ promoteOnTimeout: false }, { subprocess, jobs, timer: firingTimer })
  subprocess.state.next = { stdout: 'slow', settle: false }
  const value = await env.git.execute.call(env.git, { command: 'x', description: 'd', timeoutMs: 1000 }, execOf())
  assert.equal(jobs.state.started.length, 0, 'no job is registered when promotion is off')
  assert.equal(value.timedOut, true)
  const text = env.git.output.render({}, value)[0].text
  assert.match(text, /\[timed out after 1000ms\]/)
  assert.match(text, /\[killed by signal: SIGTERM\]/)
})

await checkAsync('a cancelled call throws the structured abort', async () => {
  const env = install(undefined, { jobs: makeJobs(), subprocess: makeSubprocess() })
  const error = await env.git.execute.call(env.git, { command: 'x', description: 'd', run_in_background: true }, execOf({ signal: { aborted: true } }))
    .then(() => null, (thrown) => thrown)
  assert.ok(error instanceof HarnessError, 'throws HarnessError')
  assert.equal(error.code, TOOL_ABORTED)
  assert.equal(error.name, 'AbortError')
})

// ------------------------------------------ workspace approval gate (git_bash) --
function policyOf(mode) {
  return { resolve: () => ({ mode, workspaceRoot: 'C:\\work' }) }
}

await checkAsync('a workspace-write session gates git_bash behind approval', async () => {
  const subprocess = makeSubprocess()
  const requests = []
  const approval = { request: async (req) => { requests.push(req); return 'allowed-once' } }
  const env = install(undefined, { subprocess, approval, sandboxPolicy: policyOf('workspace-write') })
  subprocess.state.next = { stdout: 'ok\n', exitCode: 0, settle: true }
  const value = await env.git.execute.call(env.git, { command: 'rm x', description: 'Remove x' }, execOf())
  assert.equal(requests.length, 1, 'exactly one approval request')
  assert.match(requests[0].reason, /not file-sandboxed/)
  assert.match(requests[0].reason, /workspace-write/)
  assert.equal(requests[0].reason.includes('rm x'), false, 'the audit reason does not repeat the command')
  assert.equal(requests[0].reason.includes('git_bash'), false, 'audit reason uses the product name')
  assert.match(requests[0].displayReason.en, /Allow Git Bash /)
  assert.match(requests[0].displayReason.en, /outside the file sandbox/)
  assert.match(requests[0].displayReason.zh, /允许 Git Bash /)
  assert.match(requests[0].displayReason.zh, /文件沙箱之外/)
  assert.match(requests[0].displayReason.zh, /workspace-write/)
  assert.equal(subprocess.state.spawned.length, 1, 'runs after approval')
  assert.equal(value.exitCode, 0)
})

await checkAsync('a rejected approval means nothing runs', async () => {
  const subprocess = makeSubprocess()
  const approval = { request: async () => 'rejected' }
  const env = install(undefined, { subprocess, approval, sandboxPolicy: policyOf('read-only') })
  await assert.rejects(
    () => env.git.execute.call(env.git, { command: 'x', description: 'd' }, execOf()),
    /command not executed \(rejected by user\)/,
  )
  assert.equal(subprocess.state.spawned.length, 0, 'no process was spawned')
})

await checkAsync('a danger-full-access session runs without asking', async () => {
  const subprocess = makeSubprocess()
  const requests = []
  const approval = { request: async (req) => { requests.push(req); return 'allowed-once' } }
  const env = install(undefined, { subprocess, approval, sandboxPolicy: policyOf('danger-full-access') })
  subprocess.state.next = { stdout: 'ok', exitCode: 0, settle: true }
  await env.git.execute.call(env.git, { command: 'x', description: 'd' }, execOf())
  assert.equal(requests.length, 0, 'no approval request in full-access mode')
  assert.equal(subprocess.state.spawned.length, 1)
})

await checkAsync('a restricted session without an approval service fails closed', async () => {
  const subprocess = makeSubprocess()
  const env = install(undefined, { subprocess, sandboxPolicy: policyOf('workspace-write') })
  await assert.rejects(
    () => env.git.execute.call(env.git, { command: 'x', description: 'd' }, execOf()),
    /approval required/,
  )
  assert.equal(subprocess.state.spawned.length, 0)
})

await checkAsync('an explicit require_approval still asks in full-access mode', async () => {
  const subprocess = makeSubprocess()
  const requests = []
  const approval = { request: async (req) => { requests.push(req); return 'allowed-once' } }
  const env = install(undefined, { subprocess, approval, sandboxPolicy: policyOf('danger-full-access') })
  subprocess.state.next = { stdout: 'ok', exitCode: 0, settle: true }
  await env.git.execute.call(env.git, { command: 'x', description: 'd', require_approval: true }, execOf())
  assert.equal(requests.length, 1)
})

// ------------------------------------ static read-only classification (gate) --
let sessionCounter = 0
async function runCommand(command, config, options = {}) {
  const subprocess = makeSubprocess()
  const requests = []
  const approval = options.omitApproval === true
    ? undefined
    : { request: async (req) => { requests.push(req); return options.outcome ?? 'allowed-once' } }
  const env = install(config, { subprocess, approval, sandboxPolicy: policyOf('workspace-write') })
  subprocess.state.next = { stdout: 'ok\n', exitCode: 0, settle: true }
  let error
  try {
    await env.git.execute.call(env.git, { command, description: 'd' }, options.exec ?? execOf({
      agent: {
        id: 'sess-' + (++sessionCounter),
        session: { id: 'sess-' + sessionCounter, header: { cwd: 'C:\\work' } },
      },
    }))
  } catch (thrown) {
    error = thrown
  }
  return { requests, spawned: subprocess.state.spawned, error }
}

await checkAsync('read-only command lines run without asking', async () => {
  const commands = [
    'pwd', 'ls -la', 'git status', 'git diff --stat', 'git log --oneline -5',
    'rg -n "pattern" src', 'cat package.json', 'echo hi', 'node --version', 'git branch --show-current',
    // codex read/list/search families
    'eza --long', 'tree -L 2', 'fd package.json', 'bat README.md', 'nl README.md',
    'ag TODO src', 'ack pattern src', 'pt pattern src', 'git ls-files', 'git grep -n pattern',
  ]
  for (const command of commands) {
    const { requests, spawned, error } = await runCommand(command)
    assert.equal(error, undefined, command + ' should run')
    assert.equal(requests.length, 0, command + ' must not ask')
    assert.equal(spawned.length, 1, command + ' should spawn')
  }
})

await checkAsync('writes and unknown programs keep the approval gate', async () => {
  const commands = [
    'git commit -m x', 'git add .', 'touch a', 'mkdir x', 'npm install',
    'echo hi > out.txt', 'rm -rf dist', 'python -c "print(1)"', 'cat a | tee b',
    'sed -i s/a/b/ f', 'git diff --output=patch.diff',
    // codex exec-capable forms must stay behind the gate
    'fd . -x rm', 'tree -o out.txt', 'less README.md', 'rga pattern', 'awk BEGIN{system("id")}',
    'xargs rm', 'start https://example.com',
  ]
  for (const command of commands) {
    const { requests, spawned } = await runCommand(command)
    assert.equal(requests.length, 1, command + ' should ask')
    assert.equal(spawned.length, 1, command + ' runs after approval')
  }
})

await checkAsync('a dangerous command is labelled and keeps the gate', async () => {
  const { requests } = await runCommand('rm -rf dist')
  assert.equal(requests.length, 1)
  assert.match(requests[0].reason, /dangerous command: rm/)
  assert.match(requests[0].displayReason.en, /^DANGEROUS command: Allow Git Bash /)
  assert.match(requests[0].displayReason.zh, /^危险命令：允许 Git Bash /)
})

await checkAsync('shell constructs the policy cannot verify ask first', async () => {
  for (const command of ['echo $(rm x)', 'echo `whoami`', 'cat a && cat b > out', 'cmd1 &', 'echo "unbalanced']) {
    const { requests } = await runCommand(command)
    assert.equal(requests.length, 1, command + ' should ask')
  }
})

await checkAsync('chains are classified segment by segment', async () => {
  assert.equal((await runCommand('git status && git log')).requests.length, 0, 'read-only chain allowed')
  const chained = await runCommand('git status && rm x')
  assert.equal(chained.requests.length, 1, 'a dangerous segment closes the gate')
  assert.match(chained.requests[0].reason, /dangerous command: rm/)
})

await checkAsync('allowCommands adds explicit prefixes without asking', async () => {
  const { requests } = await runCommand('git commit -m x', { allowCommands: ['git commit'] })
  assert.equal(requests.length, 0)
})

await checkAsync('denyCommands blocks before anything runs', async () => {
  const { requests, spawned, error } = await runCommand('git push origin main', { denyCommands: ['git push'] })
  assert.match(String(error && error.message), /blocked by an explicit deny rule/)
  assert.equal(requests.length, 0)
  assert.equal(spawned.length, 0)
})

await checkAsync('an approved command is remembered for the session', async () => {
  const exec = execOf({ agent: { id: 'sess-cache', session: { id: 'sess-cache', header: { cwd: 'C:\\work' } } } })
  const first = await runCommand('touch a', undefined, { exec })
  const second = await runCommand('touch a', undefined, { exec })
  assert.equal(first.requests.length, 1)
  assert.equal(second.requests.length, 0, 'exact repeat needs no second approval')
})

await checkAsync('approvalCache: false asks every time', async () => {
  const exec = execOf({ agent: { id: 'sess-nocache', session: { id: 'sess-nocache', header: { cwd: 'C:\\work' } } } })
  const config = { approvalCache: false }
  await runCommand('touch a', config, { exec })
  const second = await runCommand('touch a', config, { exec })
  assert.equal(second.requests.length, 1)
})

await checkAsync('autoApproveReadOnly: false restores the every-call gate', async () => {
  const { requests } = await runCommand('pwd', { autoApproveReadOnly: false })
  assert.equal(requests.length, 1)
  assert.match(requests[0].reason, /read-only auto-approval is disabled/)
})

await checkAsync('a read-only line runs even without an approval service', async () => {
  const { spawned, error } = await runCommand('git status', undefined, { omitApproval: true })
  assert.equal(error, undefined)
  assert.equal(spawned.length, 1)
})

// ------------------------------------------------------------- wsl sandbox --
await checkAsync('wsl_bash reports sandbox facts and renders the denial markers', async () => {
  const subprocess = makeSubprocess()
  const env = install(undefined, { subprocess })
  subprocess.state.next = { stdout: 'out\n', stderr: 'touch: cannot touch x: Read-only file system\n', exitCode: 1, settle: true }
  const value = await env.wsl.execute.call(env.wsl, { command: 'touch x', description: 'Touch', sandbox: true }, execOf())
  assert.deepEqual(value.sandbox, { mode: 'workspace-write', denied: true, enforcement: 'bwrap' })
  assert.ok(subprocess.state.spawned[0].argv.includes('bwrap'), 'bwrap wraps the argv')
  const text = env.wsl.output.render({}, value)[0].text
  assert.match(text, /\[sandbox: file access denied under workspace-write mode\]/)
  assert.match(text, /\[sandbox: retry with sandbox_permissions\]/)
  assert.match(text, /\[exit code: 1\]/)
})

// ---------------------------------------------------------- render fixtures --
check('truncation, timeout and empty-output text match the shipped wording', () => {
  const render = (value) => git.output.render({}, value)[0].text
  const base = {
    kind: 'foreground', cwd: 'C:\\w', exitCode: 0, signal: null, timedOut: false, aborted: false,
    timeoutMs: 120000, stdout: { text: 'x', truncated: true, spillPath: 'C:\\spill.txt' }, stderr: { text: '', truncated: false },
  }
  assert.equal(render(base), 'x\n[output truncated; full output: C:\\spill.txt]')
  assert.equal(render({ ...base, stdout: { text: '', truncated: false }, timedOut: true, timeoutMs: 500 }), '(no output)\n[timed out after 500ms]')
  assert.equal(render({ ...base, stdout: { text: '', truncated: false }, aborted: true }), '(no output)\n[stopped: tool call aborted]')
  assert.equal(render({ ...base, stdout: { text: '', truncated: false } }), '(no output)')
  assert.equal(render({ ...base, stdout: { text: '', truncated: false }, signal: 'SIGKILL', exitCode: null }), '(no output)\n[killed by signal: SIGKILL]')
})

console.log('\nALL ' + passed + ' CHECKS PASSED')
