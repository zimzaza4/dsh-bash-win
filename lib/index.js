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

async function spawnAndCollect(ctx, spec, args, exec) {
  const subprocessService = ctx.get('subprocess')
  const handle = subprocessService.spawn(spec)
  const timerService = ctx.get('timer')
  let timedOut = false
  let timerDisposer
  if (timerService !== undefined && typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0) {
    timerDisposer = timerService.timeout(() => {
      timedOut = true
      handle.terminate()
    }, Math.floor(args.timeoutMs))
  }
  let outcome
  try {
    outcome = await handle.done
  } finally {
    if (timerDisposer !== undefined) timerDisposer()
  }
  const out = readAll(handle.collected.stdout)
  const err = readAll(handle.collected.stderr)
  return {
    exitCode: outcome.exitCode === null ? -1 : outcome.exitCode,
    signal: outcome.signal === null ? '' : String(outcome.signal),
    timedOut: timedOut,
    aborted: exec.signal.aborted === true && !timedOut,
    timeoutMs: typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.floor(args.timeoutMs) : 0,
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    stdoutSpillPath: out.spillPath === undefined ? '' : out.spillPath,
    stderrSpillPath: err.spillPath === undefined ? '' : err.spillPath
  }
}

function baseOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', description: 'foreground or background.' },
      jobId: { type: 'string', description: 'Background job id when kind is background.' },
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
  const parts = []
  parts.push('$ ' + String(args.command))
  const err = String(value.stderr)
  const out = String(value.stdout)
  if (err.length > 0) parts.push(err)
  if (out.length > 0) parts.push(out)
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
    stderrSpillPath: value.stderrSpillPath
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
  if (meta.background === true) return undefined
  const m = meta
  const lines = []
  const err = typeof m.stderr === 'string' ? m.stderr : ''
  const out = typeof m.stdout === 'string' ? m.stdout : ''
  if (err.length > 0) lines.push(err)
  if (out.length > 0) lines.push(out)
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
    command: { type: 'string', description: 'The bash command to execute.', required: true },
    description: { type: 'string', description: 'Short description of what this command does, shown in the UI (5-10 words).', required: true },
    workdir: { type: 'string', description: 'Working directory (Windows or Linux path depending on backend). Defaults to the session workspace.' },
    timeoutMs: { type: 'number', description: 'Foreground timeout in milliseconds; the process tree is terminated when it expires. Background jobs have no timeout.' },
    run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' }
  }
  if (backend === 'wsl') {
    parameters.distro = { type: 'string', description: 'WSL distribution name. Defaults to Ubuntu.' }
    parameters.sandbox = { type: 'boolean', description: 'Run the command inside a bwrap sandbox in WSL: read-only system directories, writable workspace and /tmp. Requires bubblewrap (bwrap) installed in the distro.' }
    parameters.sandbox_permissions = { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'Request a wider sandbox mode for this call. Only valid together with justification; asks the user for approval before executing (requires approval policy ask). danger-full-access runs the command without the bwrap sandbox.' }
    parameters.justification = { type: 'string', description: 'One-sentence reason for the sandbox_permissions request, shown to the user. Must accompany sandbox_permissions.' }
  } else if (backend === 'local') {
    parameters.sandbox = { type: 'boolean', description: 'Run the command through the process sandbox (honors the session sandbox policy). Note: on Windows the ACL restricted-token runner cannot start Git Bash (Cygwin), so a confined run reports a runner failure — use wsl_bash with sandbox: true for an effective sandbox.' }
    parameters.require_approval = { type: 'boolean', description: 'Ask the user to approve this command BEFORE execution (approval mode). Requires the session approval policy "ask"; under "never" every ask is rejected automatically.' }
  }
  return defineTool({
    name: toolName,
    description: description + ' Set run_in_background: true for long-running commands: the call returns a job id immediately; read its output with job_output and stop it with job_kill.',
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
        return {
          kind: 'background',
          jobId: jobs.start({
            kind: 'bash',
            label: String(args.command),
            ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
            run: () => {
              const handle = subprocessService.spawn(Object.assign({}, spec, { signal: undefined }))
              let stdoutOffset = 0
              let stderrOffset = 0
              let cancelled = false
              return {
                cancel: () => {
                  cancelled = true
                  handle.terminate()
                },
                done: handle.done.then((outcome) => {
                  if (cancelled) {
                    return { status: 'killed', detail: outcome.signal !== null ? 'signal: ' + String(outcome.signal) : 'killed before exit' }
                  }
                  if (outcome.signal !== null) {
                    return { status: 'killed', detail: 'signal: ' + String(outcome.signal) }
                  }
                  return { status: 'completed', detail: 'exit code: ' + (outcome.exitCode === null ? 0 : outcome.exitCode) }
                }),
                readOutput: () => {
                  const parts = []
                  const stdoutReader = handle.collected.stdout
                  const stderrReader = handle.collected.stderr
                  if (stdoutReader !== undefined) {
                    const read = stdoutReader.readFrom(stdoutOffset)
                    stdoutOffset = read.nextOffset
                    if (read.text.length > 0) parts.push(read.text)
                  }
                  if (stderrReader !== undefined) {
                    const read = stderrReader.readFrom(stderrOffset)
                    stderrOffset = read.nextOffset
                    if (read.text.length > 0) parts.push(read.text)
                  }
                  return parts.join('\n')
                }
              }
            }
          })
        }
      }

      const result = await spawnAndCollect(ctx, Object.assign({}, spec, { signal: exec.signal }), args, exec)
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
  })
}

function apply(ctx, config) {
  const opts = {
    bashPath: (config?.bashPath ?? '') || process.env.DSH_BASHX_BASH_PATH || '',
    wslPath: (config?.wslPath ?? '') || process.env.DSH_BASHX_WSL_PATH || '',
    wslDistro: (config?.wslDistro ?? '') || process.env.DSH_BASHX_WSL_DISTRO || ''
  }
  const disposers = []
  disposers.push(ctx.tools.register(buildTool(ctx, 'git_bash', 'Execute a Git Bash (bash) command directly on the host by spawning bash.exe through the subprocess seam. This bypasses the Windows ACL restricted-token sandbox (under which Cygwin/MSYS2 programs cannot start), so commands run with full user privileges and are NOT file-sandboxed. Each call runs in a fresh bash process: no state persists between calls — pass workdir instead of using cd. Non-zero exits are reported in the result.', 'local', opts)))
  disposers.push(ctx.tools.register(buildTool(ctx, 'wsl_bash', 'Execute a bash command inside WSL2 (a real Linux environment via wsl.exe). Spawns "wsl.exe -d <distro> -- bash -lc <command>". Windows paths like C:\\... are passed through --cd (WSL converts them to /mnt/c/...). Each call runs in a fresh shell; no state persists between calls. The command runs as the WSL default user with full Linux privileges and is NOT file-sandboxed.', 'wsl', opts)))
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
