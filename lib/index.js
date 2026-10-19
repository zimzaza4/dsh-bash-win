import { defineTool } from '@deepseek-ai/dsh-tools'
import { approveEscalation, validateEscalationArgs, sandboxDenialMarker, escalationHintMarker } from '@deepseek-ai/dsh-sandbox'
import z from '@deepseek-ai/schemastery'

const name = '@zimzaza4/dsh-bash-win'
const inject = ['tools']

/**
 * Plugin config: explicit program paths and default WSL distro.
 * Empty strings fall back to environment variables, then auto-detection.
 */
const Config = z.object({
  bashPath: z.string().default(''),
  wslPath: z.string().default(''),
  wslDistro: z.string().default('')
})

const BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
]
const WSL_CANDIDATES = [
  'C:\\Windows\\System32\\wsl.exe',
  'C:\\Windows\\Sysnative\\wsl.exe'
]

/** How long a stop-settlement wait may take before the record is left behind. */
const JOB_STOP_GRACE_MS = 30000
/** Wait slice used by a call that asked for no timeout: it keeps waiting, but the registry needs a finite bound. */
const JOB_POLL_MS = 24 * 60 * 60 * 1000

function readAll(reader) {
  if (reader === undefined) return { text: '', truncated: false, spillPath: undefined }
  const read = reader.readFrom(0)
  return { text: read.text, truncated: read.lossy, spillPath: read.spillPath }
}

function sessionCwd(exec) {
  if (exec.agent !== undefined && typeof exec.agent.session.header.cwd === 'string' && exec.agent.session.header.cwd.length > 0) {
    return exec.agent.session.header.cwd
  }
  return typeof process !== 'undefined' && process.cwd ? process.cwd() : 'C:\\'
}

async function findExecutable(fsService, candidates) {
  if (fsService === undefined) return candidates[0]
  for (const candidate of candidates) {
    try {
      const info = await fsService.lstat(candidate)
      if (info !== undefined) return candidate
    } catch (e) {
      // keep probing
    }
  }
  return undefined
}

/** Convert a Windows path (C:\a\b) to a WSL path (/mnt/c/a/b); pass through Linux paths. */
function toWslPath(p) {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(String(p))
  if (drive !== null) {
    const rest = drive[2].replace(/\\/g, '/')
    return '/mnt/' + drive[1].toLowerCase() + (rest.length > 0 ? '/' + rest : '')
  }
  return String(p).replace(/\\/g, '/')
}

/**
 * Build the bwrap sandbox argv for a WSL command (read-only system +
 * writable workspace). Every argument is a separate argv element: a single
 * joined string is mangled by wsl.exe's Windows→Linux argument serialization
 * (quotes/spaces), silently dropping bind options.
 */
function buildBwrapArgv(command, wslWorkspace) {
  const b64 = Buffer.from(String(command), 'utf8').toString('base64')
  // Single-quoted inner: wsl.exe's Windows→Linux argument serialization mangles
  // double quotes, which broke commands containing quotes/$() under eval.
  const inner = "eval '$(echo " + b64 + " | base64 -d)'"
  return [
    'bwrap', '--die-with-parent', '--new-session',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    '--ro-bind', '/etc', '/etc',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', '/mnt/c', '/mnt/c',
    '--bind', wslWorkspace, wslWorkspace,
    '--', 'bash', '-c', inner
  ]
}

/** The effective foreground timeout of one call (0 when none was given). */
function timeoutOf(args) {
  return typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.floor(args.timeoutMs) : 0
}

/** Read one settled handle's collected streams into the canonical result fields. */
function collectHandle(handle, outcome, args, exec, timedOut) {
  const out = readAll(handle.collected.stdout)
  const err = readAll(handle.collected.stderr)
  return {
    exitCode: outcome.exitCode === null ? -1 : outcome.exitCode,
    signal: outcome.signal === null ? '' : String(outcome.signal),
    timedOut: timedOut,
    aborted: exec.signal.aborted === true && !timedOut,
    timeoutMs: timeoutOf(args),
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    stdoutSpillPath: out.spillPath === undefined ? '' : out.spillPath,
    stderrSpillPath: err.spillPath === undefined ? '' : err.spillPath,
    stopped: ''
  }
}

/** One call's empty canonical result (used when a job timed out before its process existed). */
function emptyResultOf(args, exec, timedOut) {
  return {
    exitCode: -1,
    signal: '',
    timedOut: timedOut,
    aborted: false,
    timeoutMs: timeoutOf(args),
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutSpillPath: '',
    stderrSpillPath: '',
    stopped: ''
  }
}

/** One consuming ring read rendered like the shipped shell tools: stdout, then one `[stderr]` section. */
function ringDelta(chunks) {
  const out = chunks.filter((chunk) => chunk.channel !== 'stderr').map((chunk) => chunk.text).join('')
  const err = chunks.filter((chunk) => chunk.channel === 'stderr').map((chunk) => chunk.text).join('')
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : ''
  return out + (err.length > 0 ? separator + '[stderr]\n' + err : '')
}

async function spawnAndCollect(ctx, spec, args, exec) {
  const subprocessService = ctx.get('subprocess')
  const handle = subprocessService.spawn(spec)
  const timerService = ctx.get('timer')
  let timedOut = false
  let timerDisposer
  const timeoutMs = timeoutOf(args)
  if (timerService !== undefined && timeoutMs > 0) {
    timerDisposer = timerService.timeout(() => {
      timedOut = true
      handle.terminate()
    }, timeoutMs)
  }
  let outcome
  try {
    outcome = await handle.done
  } finally {
    if (timerDisposer !== undefined) timerDisposer()
  }
  return collectHandle(handle, outcome, args, exec, timedOut)
}

function baseOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', description: 'foreground, background, or promoted (the call stopped waiting and handed the still-running job over).' },
      jobId: { type: 'string', description: 'Job id when kind is background or promoted.' },
      exitCode: { type: 'integer', description: 'Process exit code; -1 when killed by a signal.' },
      signal: { type: 'string', description: 'Terminating signal name, empty string on normal exit.' },
      timedOut: { type: 'boolean', description: 'True when the timeout cut the command short.' },
      aborted: { type: 'boolean', description: 'True when the caller cancelled the command.' },
      timeoutMs: { type: 'integer', description: 'The effective timeout applied (0 when none).' },
      stdout: { type: 'string', description: 'Captured stdout text.' },
      stderr: { type: 'string', description: 'Captured stderr text.' },
      stdoutTruncated: { type: 'boolean', description: 'True when stdout was truncated.' },
      stderrTruncated: { type: 'boolean', description: 'True when stderr was truncated.' },
      stdoutSpillPath: { type: 'string', description: 'Full stdout spill file path when truncated, else empty.' },
      stderrSpillPath: { type: 'string', description: 'Full stderr spill file path when truncated, else empty.' },
      stopped: { type: 'string', description: 'Kill reason a human recorded when stopping the job from the Web UI; empty otherwise.' },
      backend: { type: 'string', description: 'Execution backend used: wsl | bash.' },
      sandboxMode: { type: 'string', description: 'Sandbox mode applied (bash-sandbox backend).' },
      sandboxEnforcement: { type: 'string', description: 'Sandbox enforcement level when confined, else empty.' }
    }
  }
}

function renderText(args, value) {
  if (value.kind === 'background') {
    return [{ type: 'text', text: 'started background job ' + String(value.jobId) }]
  }
  if (value.kind === 'promoted') {
    const parts = []
    const delta = String(value.stdout)
    if (delta.length > 0) parts.push(delta)
    parts.push('[still running after ' + String(value.timeoutMs) + 'ms; moved to background job ' + String(value.jobId) + ']')
    parts.push('The command keeps running in the background. You will be notified when it finishes; read newer output with job_output, stop it with job_kill.')
    return [{ type: 'text', text: parts.join('\n') }]
  }
  const parts = []
  parts.push('$ ' + String(args.command))
  const err = String(value.stderr)
  const out = String(value.stdout)
  if (err.length > 0) parts.push(err)
  if (out.length > 0) parts.push(out)
  if (typeof value.stopped === 'string' && value.stopped.length > 0) parts.push('[stopped: ' + value.stopped + ']')
  if (value.timedOut) parts.push('[timed out after ' + String(value.timeoutMs) + ' ms]')
  else if (value.aborted) parts.push('[aborted]')
  else parts.push('[exit code: ' + String(value.exitCode) + ']')
  if (value.stdoutTruncated) parts.push('[stdout truncated — full output: ' + (value.stdoutSpillPath || '(no spill file)') + ']')
  if (value.stderrTruncated) parts.push('[stderr truncated — full output: ' + (value.stderrSpillPath || '(no spill file)') + ']')
  if (typeof value.sandboxMode === 'string' && value.sandboxMode.length > 0) parts.push('[sandbox: ' + value.sandboxMode + (value.sandboxEnforcement ? ' (' + value.sandboxEnforcement + ')' : '') + ']')
  return [{ type: 'text', text: parts.join('\n') }]
}

function presentMeta(args, value) {
  if (value.kind === 'background') {
    return { background: true, jobId: value.jobId }
  }
  if (value.kind === 'promoted') {
    return { promoted: true, jobId: value.jobId, timeoutMs: value.timeoutMs, stdout: String(value.stdout) }
  }
  return {
    exitCode: value.exitCode,
    signal: value.signal,
    timedOut: value.timedOut,
    aborted: value.aborted,
    timeoutMs: value.timeoutMs,
    stdout: value.stdout,
    stderr: value.stderr,
    stdoutTruncated: value.stdoutTruncated,
    stdoutSpillPath: value.stdoutSpillPath,
    stderrTruncated: value.stderrTruncated,
    stderrSpillPath: value.stderrSpillPath,
    stopped: typeof value.stopped === 'string' ? value.stopped : ''
  }
}

function presentCall(args) {
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: String(args.command),
      kind: 'execute',
      rawInput: String(args.command),
      content: [{ type: 'text', text: String(args.description ?? '') }]
    }
  }
  const view = { card: 'terminal', title: String(args.command) }
  if (typeof args.description === 'string' && args.description.length > 0) view.description = args.description
  if (typeof args.workdir === 'string' && args.workdir.length > 0) view.cwd = args.workdir
  return view
}

function presentResult(args, result) {
  const meta = result.meta
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  if (meta.background === true || meta.promoted === true) return undefined
  const m = meta
  const lines = []
  const err = typeof m.stderr === 'string' ? m.stderr : ''
  const out = typeof m.stdout === 'string' ? m.stdout : ''
  if (err.length > 0) lines.push(err)
  if (out.length > 0) lines.push(out)
  if (typeof m.stopped === 'string' && m.stopped.length > 0) lines.push('[stopped: ' + m.stopped + ']')
  if (m.timedOut) lines.push('[timed out after ' + String(m.timeoutMs) + ' ms]')
  else if (m.aborted) lines.push('[aborted]')
  if (m.stdoutTruncated) lines.push('[stdout truncated — full output: ' + (m.stdoutSpillPath || '(no spill file)') + ']')
  if (m.stderrTruncated) lines.push('[stderr truncated — full output: ' + (m.stderrSpillPath || '(no spill file)') + ']')
  const view = { card: 'terminal' }
  if (lines.length > 0) view.output = lines.join('\n')
  const cleanExit = !m.timedOut && !m.aborted
  if (cleanExit && typeof m.exitCode === 'number' && m.exitCode >= 0) view.exitCode = m.exitCode
  else if (cleanExit && typeof m.signal === 'string' && m.signal.length > 0) view.signal = m.signal
  return view
}

/** Resolve the calling session's sandbox policy (falls back to deployment policy). */
function resolveSandboxPolicy(ctx, exec) {
  const sandboxPolicyService = ctx.get('sandboxPolicy')
  if (sandboxPolicyService === undefined) return undefined
  return exec.agent !== undefined
    ? sandboxPolicyService.resolve({ session: exec.agent.session })
    : sandboxPolicyService.resolve()
}

/** Confine argv through ctx.sandbox unless the policy mode is danger-full-access. */
function confineArgv(sandboxService, argv, policy) {
  if (policy.mode !== 'danger-full-access' && sandboxService !== undefined) {
    const confined = sandboxService.confine(argv, { mode: policy.mode, workspaceRoot: policy.workspaceRoot })
    return { argv: confined.argv, enforcement: confined.enforcement }
  }
  return { argv: argv, enforcement: '' }
}

function buildTool(ctx, toolName, description, backend, opts) {
  let bashPathLookup = null
  function resolveBashPath() {
    if (bashPathLookup !== null) return bashPathLookup
    bashPathLookup = (async () => {
      if (typeof opts.bashPath === 'string' && opts.bashPath.length > 0) return opts.bashPath
      return findExecutable(ctx.get('fs'), BASH_CANDIDATES)
    })()
    return bashPathLookup
  }
  let wslPathLookup = null
  function resolveWslPath() {
    if (wslPathLookup !== null) return wslPathLookup
    wslPathLookup = (async () => {
      if (typeof opts.wslPath === 'string' && opts.wslPath.length > 0) return opts.wslPath
      return findExecutable(ctx.get('fs'), WSL_CANDIDATES)
    })()
    return wslPathLookup
  }
  const parameters = {
    command: { type: 'string', description: 'Bash command.', required: true },
    description: { type: 'string', description: 'Short UI label (5-10 words).', required: true },
    workdir: { type: 'string', description: 'Working dir; default = session workspace.' },
    timeoutMs: { type: 'number', description: 'Wait ms; on expiry the call returns a job id and keeps running, or the process tree is terminated when no job runtime exists.' },
    run_in_background: { type: 'boolean', description: 'Background: return a job id at once (collect job_output, stop job_kill). No timeout.' }
  }
  if (backend === 'wsl') {
    parameters.distro = { type: 'string', description: 'WSL distro (default Ubuntu).' }
    parameters.sandbox = { type: 'boolean', description: 'bwrap sandbox inside WSL (system dirs read-only; workspace + /tmp writable). Needs bwrap in the distro.' }
    parameters.sandbox_permissions = { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'Wider sandbox for this call; needs justification, asks the user (policy "ask"). danger-full-access skips bwrap.' }
    parameters.justification = { type: 'string', description: 'One-sentence reason shown to the user; required with sandbox_permissions.' }
  } else if (backend === 'local') {
    parameters.sandbox = { type: 'boolean', description: 'Process sandbox (session policy). On Windows the ACL runner cannot start Git Bash, so a confined run fails — use wsl_bash sandbox: true.' }
    parameters.require_approval = { type: 'boolean', description: 'Ask for approval before running; needs policy "ask" (under "never" every ask is rejected).' }
  }
  /**
   * The process's collect readers as registry pull sources.
   *
   * They bind lazily because the process is spawned inside the job's starter,
   * after the registry admitted the job; a read before that spawn yields nothing.
   * Collect-mode readers are offset-based and non-consuming, so the ring and a
   * later full read never consume each other's bytes.
   */
  function outputSources(getHandle) {
    const source = (channel) => ({
      channel: channel,
      read: (fromByte) => {
        const handle = getHandle()
        const reader = handle === undefined ? undefined : handle.collected[channel]
        if (reader === undefined) return { text: '', nextOffset: fromByte, lossy: false }
        const read = reader.readFrom(fromByte)
        return read.spillPath === undefined
          ? { text: read.text, nextOffset: read.nextOffset, lossy: read.lossy }
          : { text: read.text, nextOffset: read.nextOffset, lossy: read.lossy, spillPath: read.spillPath }
      }
    })
    return [source('stdout'), source('stderr')]
  }

  /**
   * Register one invocation as a job — every command is a job from its start,
   * like the shipped shell tools, so the Web client streams its output while it
   * runs and a human can stop it from the job view.
   */
  function startJob(jobs, subprocessService, args, exec, spec) {
    let handle
    let stopped
    return {
      id: jobs.start({
        kind: 'bash',
        label: String(args.command),
        // JobSpec.owner is a SessionId, not an Agent: passing the agent object
        // makes `start` reject with 'no live agent'.
        ...(exec.agent !== undefined ? { owner: exec.agent.id } : {}),
        output: outputSources(() => handle),
        run: () => {
          handle = subprocessService.spawn(Object.assign({}, spec, { signal: undefined }))
          let cancelled = false
          return {
            cancel: (reason) => {
              if (cancelled) return
              cancelled = true
              stopped = reason
              handle.terminate()
            },
            done: handle.done.then(
              (outcome) => {
                if (cancelled) {
                  return { status: 'killed', detail: outcome.signal !== null ? 'signal: ' + String(outcome.signal) : 'killed before exit' }
                }
                if (outcome.signal !== null) return { status: 'killed', detail: 'signal: ' + String(outcome.signal) }
                return { status: 'completed', detail: 'exit code: ' + (outcome.exitCode === null ? 0 : outcome.exitCode) }
              },
              (error) => ({ status: 'failed', detail: error instanceof Error ? error.message : String(error) })
            )
          }
        }
      }),
      process: () => handle,
      stopped: () => stopped
    }
  }

  /**
   * Wait on this call's own job.
   *
   * With a timeout, the call stops waiting when it expires and hands the
   * still-running job over (`kind: 'promoted'`); without one it keeps waiting
   * until settlement, like the previous behaviour. A settlement this call
   * collected itself removes the record again, because the model never saw its
   * id — while a promoted job stays listed for `job_output` / `job_kill`.
   */
  async function waitOnJob(jobs, attached, exec, args, finish) {
    const owner = exec.agent === undefined ? undefined : exec.agent.id
    const timeoutMs = timeoutOf(args)
    const settle = async (reason) => {
      jobs.kill(attached.id, owner, reason)
      const settled = await jobs.wait(attached.id, JOB_STOP_GRACE_MS, owner)
      if (settled.status !== 'running' && settled.status !== 'stopping') jobs.remove(attached.id, owner)
      return settled
    }
    let view
    for (;;) {
      try {
        view = await jobs.wait(attached.id, timeoutMs > 0 ? timeoutMs : JOB_POLL_MS, owner, exec.signal)
      } catch (error) {
        if (exec.signal.aborted === true) {
          await settle('tool call aborted')
          throw new Error(toolName + ': tool call aborted')
        }
        throw error
      }
      if (view.status !== 'running' && view.status !== 'stopping') break
      if (timeoutMs > 0) break
    }
    if (view.status === 'running' || view.status === 'stopping') {
      if (attached.process() === undefined) {
        // Admitted but the process never appeared: report the same empty,
        // timed-out foreground result the shipped tools produce for this case.
        await settle('timed out during preparation')
        return finish(emptyResultOf(args, exec, true))
      }
      const read = jobs.read(attached.id, owner)
      return {
        kind: 'promoted',
        jobId: attached.id,
        timeoutMs: timeoutMs,
        stdout: ringDelta(read.chunks),
        stderr: ''
      }
    }
    jobs.remove(attached.id, owner)
    const handle = attached.process()
    if (handle === undefined) {
      throw new Error(toolName + ': ' + String(view.detail === undefined ? 'job failed before starting' : view.detail))
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error(toolName + ': ' + (error instanceof Error ? error.message : String(error)))
    }
    const result = collectHandle(handle, outcome, args, exec, false)
    const stopped = attached.stopped()
    if (typeof stopped === 'string' && stopped.length > 0) result.stopped = stopped
    return finish(result)
  }

  return defineTool({
    name: toolName,
    description: description + ' Long-running: run_in_background: true → job id; collect with job_output, stop with job_kill.',
    parameters: parameters,
    output: {
      schema: baseOutputSchema(),
      render: renderText,
      presentationMeta: presentMeta
    },
    presentCall: presentCall,
    presentResult: presentResult,
    async execute(args, exec) {
      if (typeof args.command !== 'string' || args.command.trim().length === 0) throw new Error('invalid command: expected a non-empty string')
      const fsService = ctx.get('fs')
      const subprocessService = ctx.get('subprocess')
      if (subprocessService === undefined) throw new Error(toolName + ': subprocess service unavailable')
      const approval = ctx.get('approval')

      // Approval mode (git_bash / bash): ask the user BEFORE anything runs.
      if (args.require_approval === true) {
        if (approval === undefined) throw new Error(toolName + ': require_approval unavailable (approval service not loaded)')
        if (exec.agent === undefined) throw new Error(toolName + ': require_approval needs an agent context')
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: toolName,
          callId: exec.callId,
          reason: 'execute command: ' + String(args.command),
          signal: exec.signal
        })
        if (outcome !== 'allowed-once') {
          const why = outcome === 'rejected' ? 'rejected by user' : outcome === 'cancelled' ? 'approval cancelled' : 'approval unavailable'
          throw new Error(toolName + ': command not executed (' + why + ')')
        }
      }

      // WSL sandbox escalation: resolve a wider mode through the official
      // approval choreography BEFORE executing.
      let wslSandboxMode = args.sandbox === true ? 'workspace-write' : ''
      if (backend === 'wsl' && (args.sandbox_permissions !== undefined || args.justification !== undefined)) {
        validateEscalationArgs(args.sandbox_permissions, args.justification)
        wslSandboxMode = await approveEscalation({
          requestedMode: args.sandbox_permissions,
          justification: args.justification,
          effectiveMode: args.sandbox === true ? 'workspace-write' : 'read-only',
          subject: 'command'
        }, {
          approver: approval === undefined ? undefined : { request: (req) => approval.request(req) },
          agent: exec.agent,
          callId: exec.callId,
          toolName: toolName,
          signal: exec.signal
        })
      }
      const wslBwrap = backend === 'wsl' && (wslSandboxMode === 'workspace-write')
      const cwd = typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : sessionCwd(exec)
      let argv
      let sandboxMode = ''
      let sandboxEnforcement = ''
      if (backend === 'wsl') {
        const wslPath = await resolveWslPath()
        if (wslPath === undefined) throw new Error(toolName + ': wsl.exe not found. Install WSL (wsl --install) or set config wslPath / env DSH_BASHX_WSL_PATH. Do not retry this tool until the environment is fixed; use git_bash instead if available.')
        const distro = typeof args.distro === 'string' && args.distro.length > 0 ? args.distro : (typeof opts.wslDistro === 'string' && opts.wslDistro.length > 0 ? opts.wslDistro : 'Ubuntu')
        if (wslBwrap) {
          argv = [wslPath, '-d', distro, '--cd', cwd, '--'].concat(buildBwrapArgv(args.command, toWslPath(cwd)))
        } else {
          argv = [wslPath, '-d', distro, '--cd', cwd, '--', 'bash', '-lc', args.command]
        }
      } else {
        const bashPath = await resolveBashPath()
        if (bashPath === undefined) throw new Error(toolName + ': Git Bash not found (probed C:\\Program Files\\Git\\bin\\bash.exe and common alternatives). Install Git for Windows, or set config bashPath / env DSH_BASHX_BASH_PATH. Do not retry this tool until the environment is fixed; use wsl_bash instead if available.')
        argv = [bashPath, '-c', args.command]
        if (args.sandbox === true) {
          const policy = resolveSandboxPolicy(ctx, exec)
          if (policy !== undefined) {
            sandboxMode = policy.mode
            const confined = confineArgv(ctx.get('sandbox'), argv, policy)
            argv = confined.argv
            sandboxEnforcement = confined.enforcement
          }
        }
      }
      const spec = {
        argv: argv,
        cwd: cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 262144, spill: { maxBytes: 16777216 } },
          stderr: { maxBytes: 262144, spill: { maxBytes: 16777216 } }
        },
        graceMs: 3000
      }

      if (args.run_in_background === true) {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) throw new Error(toolName + ': run_in_background unavailable (jobs service not loaded)')
        if (exec.signal.aborted === true) throw new Error(toolName + ': tool call aborted')
        return { kind: 'background', jobId: startJob(jobs, subprocessService, args, exec, spec).id }
      }

      // Post-process one settled foreground result exactly as before.
      const finish = (result) => {
        if (backend === 'wsl' && /There is no distribution|no distribution with the supplied name|not installed|is not installed|无法找到/i.test(result.stderr)) {
          result.stderr += '\n[hint: WSL distribution not found. Install one (wsl --install -d Ubuntu) or pass the distro parameter / set wslDistro config. Do not retry until fixed.]'
        }
        if (wslBwrap) {
          sandboxMode = 'workspace-write'
          sandboxEnforcement = 'bwrap'
          // Classify bwrap file-effect denials like the official sandbox family:
          // a Read-only file system / Operation not permitted stderr line marks the
          // run as denied and advertises the same-turn escalation lever.
          if (/Read-only file system|Operation not permitted|Permission denied/i.test(result.stderr)) {
            result.stderr += '\n' + sandboxDenialMarker('workspace-write') + '\n' + escalationHintMarker('command')
          }
        } else if (backend === 'wsl' && wslSandboxMode === 'danger-full-access') {
          sandboxMode = 'danger-full-access'
          sandboxEnforcement = ''
        }
        return Object.assign(result, {
          kind: 'foreground',
          backend: backend === 'wsl' ? 'wsl' : 'bash',
          sandboxMode: sandboxMode,
          sandboxEnforcement: sandboxEnforcement
        })
      }

      // Every command is a job from its start (like the shipped shell tools), so
      // the Web client streams its output while it runs and a human can stop it.
      // This call then only stops waiting; without a registry it falls back to
      // the previous spawn-and-wait path, timeout kill included.
      const jobs = ctx.get('jobs')
      if (jobs !== undefined) {
        let attached
        try {
          attached = startJob(jobs, subprocessService, args, exec, spec)
        } catch (error) {
          if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn(toolName + ': job registration refused, running in the foreground with the timeout kill instead: ' + String(error))
          }
        }
        if (attached !== undefined) return await waitOnJob(jobs, attached, exec, args, finish)
      }
      return finish(await spawnAndCollect(ctx, Object.assign({}, spec, { signal: exec.signal }), args, exec))
    }
  })
}

function apply(ctx, config) {
  const opts = {
    bashPath: (config?.bashPath ?? '') || process.env.DSH_BASHX_BASH_PATH || '',
    wslPath: (config?.wslPath ?? '') || process.env.DSH_BASHX_WSL_PATH || '',
    wslDistro: (config?.wslDistro ?? '') || process.env.DSH_BASHX_WSL_DISTRO || ''
  }
  const disposers = []
  disposers.push(ctx.tools.register(buildTool(ctx, 'git_bash', 'Run a bash (Git Bash) command on the host via bash.exe. Fresh process per call — no state persists, so pass workdir instead of cd. Runs with full user privileges and is NOT file-sandboxed (the Windows ACL sandbox cannot start Cygwin/MSYS2). Non-zero exits appear in the result.', 'local', opts)))
  disposers.push(ctx.tools.register(buildTool(ctx, 'wsl_bash', 'Run bash inside WSL2 (a real Linux environment) via wsl.exe -d <distro> -- bash -lc. Windows paths pass through --cd and become /mnt/c/...; use workdir instead of cd. Fresh shell per call — no state persists. Runs as the distro default user, NOT file-sandboxed.', 'wsl', opts)))
  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch (e) {
        console.error('tool-bashx disposer error', e)
      }
    }
  }
}

export { Config, apply, inject, name }
