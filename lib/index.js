import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { approveEscalation, validateEscalationArgs, sandboxDenialMarker, escalationHintMarker } from '@deepseek-ai/dsh-sandbox'
import z from '@deepseek-ai/schemastery'
import { isAbsolute, join } from 'node:path'

const name = '@zimzaza4/dsh-bash-win'
const inject = ['tools', 'systemPrompt']

/**
 * Plugin config: explicit program paths, default WSL distro, and the two
 * shipped shell-tool switches (`enableRunInBackground`, `promoteOnTimeout`,
 * both defaulting to true) so a deployment can turn the background surface off
 * exactly like `dsh-tool-bash` / `dsh-tool-pwsh` do.
 */
const Config = z.object({
  bashPath: z.string().default(''),
  wslPath: z.string().default(''),
  wslDistro: z.string().default(''),
  enableRunInBackground: z.boolean().default(true),
  promoteOnTimeout: z.boolean().default(true),
  autoApproveReadOnly: z.boolean().default(true),
  allowCommands: z.array(z.string()).default([]),
  denyCommands: z.array(z.string()).default([]),
  approvalCache: z.boolean().default(true)
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
/**
 * Foreground deadline defaults, mirroring `@deepseek-ai/dsh-bash-local`
 * (`timeoutMs` 120s, `maxTimeoutMs` 600s). An omitted timeout therefore hands
 * a still-running command to a background job after two minutes instead of
 * blocking the turn forever, exactly like the shipped bash tool.
 */
const DEFAULT_TIMEOUT_MS = 120000
const MAX_TIMEOUT_MS = 600000

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

/**
 * Resolve one call's working directory the way the shipped shell tools do: an
 * omitted value means the session's own directory, and a relative path is
 * resolved against it rather than against the host process's cwd.
 */
function resolveWorkdir(modelWorkdir, sessionDirectory) {
  if (typeof modelWorkdir !== 'string' || modelWorkdir.length === 0) return sessionDirectory
  return isAbsolute(modelWorkdir) ? modelWorkdir : join(sessionDirectory, modelWorkdir)
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

/**
 * The effective foreground timeout of one call, with the shipped executor's
 * numbers: an omitted value means 120s, anything longer is capped at 600s, and
 * a non-positive or non-finite value is a caller error rather than "no
 * timeout". `run_in_background` never applies this (no timeout there).
 */
function timeoutOf(args) {
  if (args.timeoutMs === undefined) return DEFAULT_TIMEOUT_MS
  if (typeof args.timeoutMs !== 'number' || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('invalid timeoutMs: expected a positive number, got ' + JSON.stringify(args.timeoutMs))
  }
  return Math.min(Math.floor(args.timeoutMs), MAX_TIMEOUT_MS)
}

/** One collected stream in the shipped shape: text, truncation flag, optional spill path. */
function collected(reader) {
  const read = readAll(reader)
  return read.spillPath === undefined
    ? { text: read.text, truncated: read.truncated }
    : { text: read.text, truncated: read.truncated, spillPath: read.spillPath }
}

/**
 * Read one settled handle's collected streams into the shipped foreground
 * shape (`kind`/`cwd`/nested streams), the value `dsh-tool-bash` and
 * `dsh-tool-pwsh` publish.
 */
function collectHandle(handle, outcome, args, exec, timedOut, cwd) {
  return {
    kind: 'foreground',
    cwd,
    exitCode: outcome.exitCode === null ? null : outcome.exitCode,
    signal: outcome.signal === null ? null : String(outcome.signal),
    timedOut,
    aborted: exec.signal.aborted === true && !timedOut,
    timeoutMs: timeoutOf(args),
    stdout: collected(handle.collected.stdout),
    stderr: collected(handle.collected.stderr)
  }
}

/** One call's empty foreground result (used when a job timed out before its process existed). */
function emptyResultOf(args, exec, timedOut, cwd) {
  return {
    kind: 'foreground',
    cwd,
    exitCode: null,
    signal: null,
    timedOut,
    aborted: false,
    timeoutMs: timeoutOf(args),
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false }
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
  return collectHandle(handle, outcome, args, exec, timedOut, spec.cwd)
}

/**
 * The result schema, mirrored from `dsh-tool-bash` / `dsh-tool-pwsh`: one
 * discriminated union over `kind`, with the foreground branch nesting its two
 * streams and its sandbox facts exactly as the shipped shell tools publish them.
 */
function baseOutputSchema() {
  const stream = (description) => ({
    type: 'object',
    additionalProperties: false,
    required: true,
    description,
    properties: {
      text: { type: 'string', required: true },
      truncated: { type: 'boolean', required: true },
      spillPath: { type: 'string' }
    }
  })
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
          cwd: { type: 'string', required: true }
        }
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'promoted' },
          cwd: { type: 'string', required: true },
          jobId: { type: 'string', required: true },
          timeoutMs: { type: 'number', required: true },
          output: { type: 'string', required: true }
        }
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'foreground' },
          cwd: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean', required: true },
          aborted: { type: 'boolean', required: true },
          stopped: { type: 'string' },
          timeoutMs: { type: 'number', required: true },
          stdout: stream('Captured stdout.'),
          stderr: stream('Captured stderr.'),
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string', required: true },
              denied: { type: 'boolean', required: true },
              enforcement: { type: 'string' },
              runnerFailed: { type: 'boolean' }
            }
          }
        }
      }
    ]
  }
}

/**
 * Append the shipped truncation notice (with the full-output spill path) to one
 * stream's text, matching `dsh-tool-bash`'s renderer.
 */
function streamText(text, truncated, spillPath) {
  if (!truncated) return text
  return text + '\n[output truncated; full output: ' + (spillPath || '(unavailable)') + ']'
}

/**
 * The model-facing text, in the shipped shell tools' own shape: stdout, then a
 * marked stderr section, then the status markers. Non-zero exits are reported
 * rather than errored, a zero exit prints no marker at all, and an empty body
 * reads `(no output)` — the same contract `dsh-tool-bash` and `dsh-tool-pwsh`
 * render, so the model reads one format whichever shell it picks.
 */
function renderText(args, value) {
  if (value.kind === 'background') {
    return [{ type: 'text', text: 'started background job ' + String(value.jobId) }]
  }
  if (value.kind === 'promoted') {
    const body = String(value.output)
    const head = body.length > 0 ? (body.endsWith('\n') ? body : body + '\n') : ''
    return [{
      type: 'text',
      text: head + '[still running after ' + String(value.timeoutMs) + 'ms; moved to background job ' + String(value.jobId) + ']'
    }]
  }
  const out = streamText(value.stdout.text, value.stdout.truncated === true, value.stdout.spillPath)
  const err = streamText(value.stderr.text, value.stderr.truncated === true, value.stderr.spillPath)
  let body = out
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += '[stderr]\n' + err
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  // Sandbox facts render the same markers the shipped shell tools emit: a
  // denial marker, plus the escalation hint when this backend offers the lever.
  if (value.sandbox?.denied === true) {
    markers.push(sandboxDenialMarker(value.sandbox.mode))
    if (value.sandbox.enforcement === 'bwrap') markers.push(escalationHintMarker('command'))
  }
  if (value.timedOut) markers.push('[timed out after ' + String(value.timeoutMs) + 'ms]')
  if (typeof value.stopped === 'string' && value.stopped.length > 0) markers.push('[stopped: ' + value.stopped + ']')
  else if (value.aborted && !value.timedOut) markers.push('[stopped: tool call aborted]')
  if (value.signal !== null) markers.push('[killed by signal: ' + String(value.signal) + ']')
  else if (value.exitCode !== 0) markers.push('[exit code: ' + String(value.exitCode) + ']')
  if (markers.length === 0) return [{ type: 'text', text: body }]
  if (!body.endsWith('\n')) body += '\n'
  return [{ type: 'text', text: body + markers.join('\n') }]
}

/**
 * The card/UI view of one result. The shipped shell tools only publish `cwd`
 * here and let the card parse the text, but this plugin's own terminal card
 * reads the fields directly, so it keeps publishing the flat view it consumes.
 */
function presentMeta(args, value) {
  if (value.kind === 'background') {
    return { background: true, jobId: value.jobId }
  }
  if (value.kind === 'promoted') {
    return { promoted: true, jobId: value.jobId, timeoutMs: value.timeoutMs, stdout: String(value.output) }
  }
  return {
    exitCode: value.exitCode === null ? -1 : value.exitCode,
    signal: value.signal === null ? '' : value.signal,
    timedOut: value.timedOut,
    aborted: value.aborted,
    timeoutMs: value.timeoutMs,
    stdout: value.stdout.text,
    stderr: value.stderr.text,
    stdoutTruncated: value.stdout.truncated,
    stdoutSpillPath: value.stdout.spillPath ?? '',
    stderrTruncated: value.stderr.truncated,
    stderrSpillPath: value.stderr.spillPath ?? '',
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
  if (meta.background === true || meta.promoted === true) {
    // Acknowledgements have no terminal status of their own: the shipped shell
    // tools draw them as a plain fenced console block.
    const block = Array.isArray(result.content) && result.content.length === 1 ? result.content[0] : undefined
    if (block === undefined || block.type !== 'text') return undefined
    return {
      card: 'generic',
      content: [{ type: 'text', text: '```console\n' + String(block.text).replace(/\n+$/, '') + '\n```' }]
    }
  }
  const m = meta
  const lines = []
  const err = typeof m.stderr === 'string' ? m.stderr : ''
  const out = typeof m.stdout === 'string' ? m.stdout : ''
  if (out.length > 0) lines.push(out)
  if (err.length > 0) lines.push('[stderr]\n' + err)
  if (typeof m.stopped === 'string' && m.stopped.length > 0) lines.push('[stopped: ' + m.stopped + ']')
  if (m.timedOut) lines.push('[timed out after ' + String(m.timeoutMs) + 'ms]')
  else if (m.aborted) lines.push('[stopped: tool call aborted]')
  if (m.stdoutTruncated) lines.push('[output truncated; full output: ' + (m.stdoutSpillPath || '(unavailable)') + ']')
  if (m.stderrTruncated) lines.push('[output truncated; full output: ' + (m.stderrSpillPath || '(unavailable)') + ']')
  const view = { card: 'terminal' }
  if (lines.length > 0) view.output = lines.join('\n')
  // The shipped cards show a pill only for a real non-zero exit or a signal.
  const cleanExit = !m.timedOut && !m.aborted
  if (cleanExit && typeof m.signal === 'string' && m.signal.length > 0) view.signal = m.signal
  else if (cleanExit && typeof m.exitCode === 'number' && m.exitCode > 0) view.exitCode = m.exitCode
  return view
}

/** The structured abort the shipped shell tools throw when the caller cancels. */
function toolAborted() {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

/** Resolve the calling session's sandbox policy (falls back to deployment policy). */
function resolveSandboxPolicy(ctx, exec) {
  const sandboxPolicyService = ctx.get('sandboxPolicy')
  if (sandboxPolicyService === undefined) return undefined
  return exec.agent !== undefined
    ? sandboxPolicyService.resolve({ session: exec.agent.session })
    : sandboxPolicyService.resolve()
}

/**
 * Localized approval headline, mirroring the shipped escalation vocabulary: the
 * card renders `displayReason` as its headline and the correlated tool call's
 * `command` as the detail body, so the text must never repeat the command.
 * The English `reason` is the audit string; every locale maps the same fact.
 */
function approvalDisplayReason(restrictedMode, displayName, dangerous = false) {
  const base = restrictedMode === undefined
    ? {
        en: `Allow ${displayName} to run with full access`,
        zh: `允许 ${displayName} 以完整权限运行`,
        ja: `${displayName} のフルアクセス実行を許可`,
        es: `Permitir ${displayName} con acceso completo`,
        fr: `Autoriser ${displayName} avec un accès complet`,
        de: `${displayName} mit Vollzugriff ausführen`,
        ru: `Разрешить ${displayName} с полным доступом`,
        pt: `Permitir ${displayName} com acesso total`
      }
    : {
        en: `Allow ${displayName} to run outside the file sandbox (session: ${restrictedMode})`,
        zh: `允许 ${displayName} 在文件沙箱之外运行（会话：${restrictedMode}）`,
        ja: `ファイルサンドボックス外での ${displayName} の実行を許可（セッション: ${restrictedMode}）`,
        es: `Permitir ${displayName} fuera del sandbox de archivos (sesión: ${restrictedMode})`,
        fr: `Autoriser ${displayName} hors du bac à sable de fichiers (session : ${restrictedMode})`,
        de: `${displayName} außerhalb der Datei-Sandbox ausführen (Sitzung: ${restrictedMode})`,
        ru: `Разрешить ${displayName} вне файловой песочницы (сеанс: ${restrictedMode})`,
        pt: `Permitir ${displayName} fora do sandbox de arquivos (sessão: ${restrictedMode})`
      }
  if (!dangerous) return base
  const marks = {
    en: 'DANGEROUS command: ',
    zh: '危险命令：',
    ja: '危険なコマンド: ',
    es: 'Comando PELIGROSO: ',
    fr: 'Commande DANGEREUSE : ',
    de: 'GEFÄHRLICHER Befehl: ',
    ru: 'ОПАСНАЯ команда: ',
    pt: 'Comando PERIGOSO: '
  }
  return Object.fromEntries(Object.entries(base).map(([locale, text]) => [locale, (marks[locale] ?? '') + text]))
}

// ─── git_bash static approval policy ────────────────────────────────────────
// Git Bash cannot be file-sandboxed on Windows, so a confined (read-only or
// workspace-write) session needs an approval gate. Asking about every command is
// pure noise — most shell commands only read. This layer classifies the command
// line with static rules (never a model) into three verdicts:
//   allow  — a chain of known read-only segments, no redirection/command
//            substitution, so nothing on this line can mutate the filesystem;
//   danger — a known destructive command, which must be seen by a human;
//   ask    — everything else (writes, unknown programs, shell constructs the
//            parser cannot verify). Fail-closed: the gate only opens for what it
//            positively recognises as read-only.
// This reduces approval noise; it is not a sandbox and never claims to be one.

/**
 * Programs whose invocation cannot mutate files. The inventory mirrors the
 * command families codex's shell parser recognises as read/list/search work
 * (`shell-command/src/parse_command.rs`): ls/eza/exa/tree/du, rg/fd/find/grep/
 * ag/ack/pt, cat/bat/nl. Pagers (less/more) and preprocessors (rga) are left
 * out on purpose: they can execute external programs.
 */
const READ_ONLY_PROGRAMS = new Set([
  'pwd', 'ls', 'dir', 'eza', 'exa', 'tree', 'cat', 'bat', 'batcat', 'nl',
  'head', 'tail', 'wc', 'stat', 'file', 'readlink', 'realpath', 'basename',
  'dirname', 'du', 'df', 'which', 'where', 'whoami', 'uname', 'printenv',
  'grep', 'egrep', 'fgrep', 'ag', 'ack', 'pt', 'fd', 'id', 'groups', 'ps',
  'type', 'echo', 'printf'
])

/** Programs with `--version`-style invocations that only print a version. */
const VERSION_PROGRAMS = new Set([
  'node', 'npm', 'pnpm', 'python', 'python3', 'java', 'javac', 'go', 'cargo',
  'rustc', 'dotnet', 'git'
])

/** Destructive programs that must always reach a human before running. */
const DANGEROUS_PROGRAMS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'format', 'format-volume',
  'diskpart', 'bcdedit', 'shutdown', 'reboot', 'poweroff', 'mkfs', 'dd',
  'attrib', 'icacls', 'takeown', 'cacls', 'reg', 'sc', 'net', 'schtasks', 'taskkill'
])

/** GUI launchers that hand a URL to the shell (codex's ShellExecute rule). */
const URL_LAUNCHERS = new Set(['start', 'explorer', 'mshta', 'rundll32', 'open', 'xdg-open'])


/** Destructive git subcommands (a read-only form is handled before this set). */
const DANGEROUS_GIT_SUBCOMMANDS = new Set([
  'reset', 'clean', 'push', 'checkout', 'switch', 'restore', 'rebase', 'tag',
  'branch', 'stash', 'gc', 'prune', 'update-ref', 'filter-branch'
])

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'grep',
  'describe', 'cat-file', 'rev-list', 'shortlog'
])

const GIT_BRANCH_READ_FLAGS = new Set([
  '-a', '-r', '-v', '-vv', '--list', '--show-current', '--no-color',
  '--verbose', '--all', '--remotes'
])

/** Flags that turn a read-only tool into a writer or an executor. */
const FIND_WRITE_FLAGS = new Set([
  '-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprint0',
  '-fprintf', '-fls'
])

function baseName(token) {
  return String(token).replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase()
}

function hasFlag(args, names) {
  return args.some((arg) => names.some((name) => arg === name || arg.startsWith(name + '=')))
}

function isVersionInvocation(name, args) {
  return VERSION_PROGRAMS.has(name) && args.length > 0
    && args.every((arg) => /^(?:--?version|-v|-V|version)$/.test(arg))
}

function isReadOnlyGit(args) {
  const sub = args[0]
  if (sub === undefined) return false
  if (sub === 'version' || sub === '--version') return args.length === 1
  if (sub === 'branch') return args.slice(1).every((flag) => GIT_BRANCH_READ_FLAGS.has(flag))
  if (sub === 'remote') return args.slice(1).every((flag) => flag === '-v' || flag === '--verbose')
  if (sub === 'stash') return args[1] === 'list' && args.length === 2
  if (!GIT_READ_SUBCOMMANDS.has(sub)) return false
  // `--output` writes the rendered output to a file; `--open-files-in-pager`
  // can spawn an arbitrary pager.
  return !hasFlag(args.slice(1), ['--output', '-o', '--open-files-in-pager', '--ext-diff'])
}

/** Classify one already-tokenized command segment. */
function classifySegment(tokens) {
  const name = baseName(tokens[0])
  const args = tokens.slice(1)
  if (isVersionInvocation(name, args)) return { kind: 'allow', reason: '' }
  if (name === 'git') {
    if (isReadOnlyGit(args)) return { kind: 'allow', reason: '' }
    const sub = args[0]
    if (DANGEROUS_GIT_SUBCOMMANDS.has(sub)) return { kind: 'danger', reason: 'dangerous git subcommand: git ' + sub }
    return { kind: 'ask', reason: 'git ' + String(sub ?? '') + ' is not read-only' }
  }
  if (name === 'rg') {
    if (hasFlag(args, ['--pre'])) return { kind: 'ask', reason: 'rg --pre executes a program per file' }
    return { kind: 'allow', reason: '' }
  }
  if (name === 'fd') {
    return args.some((arg) => arg === '-x' || arg === '-X' || arg === '--exec' || arg === '--exec-batch' || arg.startsWith('--exec='))
      ? { kind: 'ask', reason: 'fd with an exec flag runs a program' }
      : { kind: 'allow', reason: '' }
  }
  if (name === 'tree') {
    return args.some((arg) => arg === '-o' || arg === '--output' || arg.startsWith('--output='))
      ? { kind: 'ask', reason: 'tree with -o writes a file' }
      : { kind: 'allow', reason: '' }
  }
  if (name === 'find') {
    return args.some((arg) => FIND_WRITE_FLAGS.has(arg))
      ? { kind: 'ask', reason: 'find with a write or exec flag' }
      : { kind: 'allow', reason: '' }
  }
  if (name === 'sort') {
    const writes = args.some((arg) => arg === '-o' || /^-o./.test(arg) || arg === '--output' || arg.startsWith('--output='))
    return writes ? { kind: 'ask', reason: 'sort with -o writes a file' } : { kind: 'allow', reason: '' }
  }
  if (URL_LAUNCHERS.has(name) && args.some((arg) => /^https?:\/\//i.test(arg))) {
    return { kind: 'danger', reason: 'launches a URL through a GUI launcher' }
  }
  if (DANGEROUS_PROGRAMS.has(name)) return { kind: 'danger', reason: 'dangerous command: ' + name }
  if (READ_ONLY_PROGRAMS.has(name)) return { kind: 'allow', reason: '' }
  return { kind: 'ask', reason: 'not a known read-only command: ' + name }
}

/**
 * Split one shell command line into segments, or return null when it uses
 * constructs whose effect cannot be verified statically (command substitution,
 * redirections, background execution, odd quoting). Null always means `ask`.
 */
function splitShellSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote !== null) {
      if (char === quote) { quote = null; continue }
      // Double quotes still perform command substitution; single quotes are literal.
      if (quote === '"' && (char === '$' || char === '`')) return null
      if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[index + 1]
        index += 1
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '$' || char === '`') return null
    if (char === '>' || char === '<') return null
    if (char === '\\' && index + 1 < command.length) {
      current += command[index + 1]
      index += 1
      continue
    }
    if (char === '&' || char === '|' || char === ';' || char === '\n') {
      const pair = command.slice(index, index + 2)
      if (pair === '&&' || pair === '||') {
        segments.push(current)
        current = ''
        index += 1
        continue
      }
      if (char === '|' || char === ';' || char === '\n') {
        segments.push(current)
        current = ''
        continue
      }
      return null
    }
    current += char
  }
  if (quote !== null) return null
  segments.push(current)
  return segments
}

function parsePrefixRules(entries) {
  const rules = []
  for (const entry of entries ?? []) {
    const argv = String(entry).trim().split(/\s+/).filter(Boolean)
    if (argv.length > 0) rules.push(argv)
  }
  return rules
}

function matchesPrefix(argv, prefix) {
  if (prefix.length === 0 || prefix.length > argv.length) return false
  if (baseName(argv[0]) !== baseName(prefix[0])) return false
  for (let index = 1; index < prefix.length; index += 1) {
    if (argv[index] !== prefix[index]) return false
  }
  return true
}

/**
 * Classify one full command line for the confined-session approval gate.
 * @param command - the shell command line the model asked to run.
 * @param policy - parsed explicit prefix rules ({ allow, deny }).
 * @returns the verdict and a short English reason for the audit log.
 */
function classifyCommand(command, policy) {
  const text = String(command).trim()
  if (text.length === 0) return { verdict: 'ask', reason: 'empty command' }
  const segments = splitShellSegments(text)
  if (segments === null) return { verdict: 'ask', reason: 'command uses shell features the policy cannot verify' }
  let askReason = ''
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return { verdict: 'ask', reason: 'environment assignments are not classified' }
    if (policy.deny.some((prefix) => matchesPrefix(tokens, prefix))) {
      return { verdict: 'deny', reason: 'matched explicit deny rule: ' + tokens.join(' ') }
    }
    if (policy.allow.some((prefix) => matchesPrefix(tokens, prefix))) continue
    const segmentVerdict = classifySegment(tokens)
    if (segmentVerdict.kind === 'danger') return { verdict: 'danger', reason: segmentVerdict.reason }
    if (segmentVerdict.kind === 'ask') askReason = askReason.length > 0 ? askReason : segmentVerdict.reason
  }
  if (askReason.length > 0) return { verdict: 'ask', reason: askReason }
  return { verdict: 'allow', reason: '' }
}

/** Session-scoped approvals of an exactly repeated command line. */
const approvedCommands = new Map()

function approvalSignature(cwd, command) {
  return String(cwd) + '\u0000' + String(command)
}

function wasApprovedThisSession(sessionId, signature) {
  return sessionId.length > 0 && approvedCommands.get(sessionId)?.has(signature) === true
}

function rememberApproval(sessionId, signature) {
  if (sessionId.length === 0) return
  let entries = approvedCommands.get(sessionId)
  if (entries === undefined) {
    entries = new Set()
    approvedCommands.set(sessionId, entries)
  }
  entries.add(signature)
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
  // The two shipped shell-tool switches, read once: without a job registry the
  // tool is foreground-only either way, exactly like `dsh-tool-bash`.
  const backgroundEnabled = opts.backgroundEnabled !== false
  const promoteOnTimeout = backgroundEnabled && opts.promoteOnTimeout !== false
  // The common surface mirrors `dsh-tool-bash` / `dsh-tool-pwsh` field for
  // field — same names, same order, same wording — so the model treats every
  // shell the same way. Backend-specific levers are appended below.
  const parameters = {
    description: {
      type: 'string',
      required: true,
      description: 'Clear, concise description of what this command does in active voice, '
        + '5-10 words (shown in the UI). Examples: "git status" → "Show working tree status"; '
        + '"npm install" → "Install package dependencies".'
    },
    command: { type: 'string', required: true, description: 'The bash command to execute.' },
    timeoutMs: {
      type: 'number',
      description: promoteOnTimeout
        ? 'Timeout in milliseconds. Omitted means 120000 and values above 600000 are capped; '
          + 'on expiry the still-running command moves to a background job instead of being killed '
          + '(collect with job_output, stop with job_kill). A non-positive value is rejected.'
        : 'Timeout in milliseconds. Omitted means 120000 and values above 600000 are capped, '
          + 'and the command is killed on expiry. A non-positive value is rejected.'
    },
    workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
    ...(backgroundEnabled ? {
      run_in_background: { type: 'boolean', description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' }
    } : {})
  }
  if (backend === 'wsl') {
    parameters.distro = { type: 'string', description: 'WSL distro (default Ubuntu).' }
    parameters.sandbox = { type: 'boolean', description: 'bwrap sandbox inside WSL (system dirs read-only; workspace + /tmp writable). Needs bwrap in the distro.' }
    parameters.sandbox_permissions = { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'Wider sandbox for this call; needs justification, asks the user (policy "ask"). danger-full-access skips bwrap.' }
    parameters.justification = { type: 'string', description: 'One-sentence reason shown to the user; required with sandbox_permissions.' }
  } else if (backend === 'local') {
    // Git Bash cannot run under the Windows ACL sandbox (the restricted token
    // cannot start Cygwin/MSYS2), so this backend deliberately exposes no
    // `sandbox` lever: confinement lives on wsl_bash, where bwrap can do it.
    parameters.require_approval = { type: 'boolean', description: 'Ask for approval before running; needs policy "ask" (under "never" every ask is rejected). In a read-only or workspace-write session, unsafe or unverifiable commands ask anyway.' }
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
        // Link the job to the tool call that started it, like the shipped shell
        // tools: the roster and the "not running" diagnostics need it.
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId },
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
  async function waitOnJob(jobs, attached, exec, args, finish, cwd) {
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
          throw toolAborted()
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
        return finish(emptyResultOf(args, exec, true, cwd))
      }
      const read = jobs.read(attached.id, owner)
      return {
        kind: 'promoted',
        cwd,
        jobId: attached.id,
        timeoutMs: timeoutMs,
        output: ringDelta(read.chunks)
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
    const result = collectHandle(handle, outcome, args, exec, false, cwd)
    const stopped = attached.stopped()
    if (typeof stopped === 'string' && stopped.length > 0) result.stopped = stopped
    return finish(result)
  }

  return defineTool({
    name: toolName,
    description: description,
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
      if (typeof args.description !== 'string' || args.description.trim().length === 0) throw new Error('invalid description: expected a non-empty string')
      // Validate the deadline before anything spawns: a non-positive timeout is a
      // caller error, not "no timeout", exactly as the shipped shell tools treat it.
      timeoutOf(args)
      const fsService = ctx.get('fs')
      const subprocessService = ctx.get('subprocess')
      if (subprocessService === undefined) throw new Error(toolName + ': subprocess service unavailable')
      const approval = ctx.get('approval')
      // Git Bash runs with full user privileges and cannot be file-sandboxed, so
      // a confined (read-only or workspace-write) session needs an approval gate.
      // A danger-full-access session (完全权限) runs it directly.
      const standingPolicy = backend === 'local' ? resolveSandboxPolicy(ctx, exec) : undefined
      const restrictedSession = standingPolicy !== undefined && standingPolicy.mode !== 'danger-full-access'
      const cwd = resolveWorkdir(args.workdir, sessionCwd(exec))

      // Static classification decides whether this line can run without asking:
      // only a chain that is positively recognised as read-only is auto-approved;
      // writes, unknown programs and unparseable shell constructs keep the gate.
      const rawGate = restrictedSession ? classifyCommand(args.command, opts.policy) : { verdict: 'allow', reason: '' }
      const gate = rawGate.verdict === 'allow' && opts.autoApproveReadOnly === false
        ? { verdict: 'ask', reason: 'read-only auto-approval is disabled' }
        : rawGate
      if (gate.verdict === 'deny') {
        throw new Error(toolName + ': blocked by an explicit deny rule (' + gate.reason + '); adjust allowCommands/denyCommands or use a sandboxed shell')
      }
      const sessionId = exec.agent !== undefined && exec.agent.session !== undefined && typeof exec.agent.session.id === 'string'
        ? exec.agent.session.id
        : ''
      const signature = approvalSignature(cwd, args.command)
      const cached = restrictedSession && opts.approvalCache !== false
        && gate.verdict !== 'allow' && wasApprovedThisSession(sessionId, signature)

      // Approval: the explicit per-call request, or the standing-policy gate.
      // The audit `reason` stays short and self-contained; the card headline is
      // the localized `displayReason`, and the command body comes from the
      // correlated tool call (the approval slot renders it separately).
      if (args.require_approval === true || (restrictedSession && gate.verdict !== 'allow' && !cached)) {
        if (approval === undefined) throw new Error(toolName + ': approval required but the approval service is not loaded')
        if (exec.agent === undefined) throw new Error(toolName + ': approval needs an agent context')
        // Human-facing text uses the product name, not the tool id.
        const displayName = backend === 'wsl' ? 'WSL Bash' : 'Git Bash'
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: toolName,
          callId: exec.callId,
          reason: restrictedSession
            ? displayName + ' requires approval: not file-sandboxed (session: ' + standingPolicy.mode + '); ' + gate.reason
            : displayName + ' requires approval: explicit request',
          displayReason: approvalDisplayReason(
            restrictedSession ? standingPolicy.mode : undefined,
            displayName,
            gate.verdict === 'danger'
          ),
          signal: exec.signal
        })
        if (outcome !== 'allowed-once') {
          const why = outcome === 'rejected' ? 'rejected by user' : outcome === 'cancelled' ? 'approval cancelled' : 'approval unavailable'
          throw new Error(toolName + ': command not executed (' + why + ')')
        }
        if (restrictedSession && opts.approvalCache !== false && gate.verdict !== 'allow') {
          rememberApproval(sessionId, signature)
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
      let argv
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
        // Git Bash runs unconfined on purpose: the Windows ACL runner cannot
        // start Cygwin/MSYS2, so this backend exposes no sandbox lever.
        argv = [bashPath, '-c', args.command]
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
        if (!backgroundEnabled) {
          throw new Error('run_in_background is disabled for this deployment (enableRunInBackground: false)')
        }
        const jobs = ctx.get('jobs')
        if (jobs === undefined) throw new Error(toolName + ': background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        if (exec.signal.aborted === true) throw toolAborted()
        return { kind: 'background', jobId: startJob(jobs, subprocessService, args, exec, spec).id, cwd }
      }

      // Post-process one settled foreground result: WSL diagnostics on stderr,
      // and the sandbox facts the shipped result shape carries.
      const finish = (result) => {
        if (backend === 'wsl' && /There is no distribution|no distribution with the supplied name|not installed|is not installed|无法找到/i.test(result.stderr.text)) {
          result.stderr.text += '\n[hint: WSL distribution not found. Install one (wsl --install -d Ubuntu) or pass the distro parameter / set wslDistro config. Do not retry until fixed.]'
        }
        if (wslBwrap) {
          result.sandbox = {
            mode: 'workspace-write',
            denied: /Read-only file system|Operation not permitted|Permission denied/i.test(result.stderr.text),
            enforcement: 'bwrap'
          }
        } else if (backend === 'wsl' && wslSandboxMode === 'danger-full-access') {
          result.sandbox = { mode: 'danger-full-access', denied: false }
        }
        return result
      }

      // Every command is a job from its start (like the shipped shell tools), so
      // the Web client streams its output while it runs and a human can stop it.
      // This call then only stops waiting; without a registry — or with
      // `promoteOnTimeout: false` — it runs under the deadline kill instead.
      const jobs = ctx.get('jobs')
      if (jobs !== undefined && promoteOnTimeout) {
        let attached
        try {
          attached = startJob(jobs, subprocessService, args, exec, spec)
        } catch (error) {
          if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
            ctx.logger.warn(toolName + ': job registration refused, running in the foreground with the timeout kill instead: ' + String(error))
          }
        }
        if (attached !== undefined) return await waitOnJob(jobs, attached, exec, args, finish, cwd)
      }
      return finish(await spawnAndCollect(ctx, Object.assign({}, spec, { signal: exec.signal }), args, exec))
    }
  })
}

function apply(ctx, config) {
  const backgroundEnabled = config?.enableRunInBackground !== false
  const promoteOnTimeout = backgroundEnabled && config?.promoteOnTimeout !== false
  const opts = {
    bashPath: (config?.bashPath ?? '') || process.env.DSH_BASHX_BASH_PATH || '',
    wslPath: (config?.wslPath ?? '') || process.env.DSH_BASHX_WSL_PATH || '',
    wslDistro: (config?.wslDistro ?? '') || process.env.DSH_BASHX_WSL_DISTRO || '',
    backgroundEnabled,
    promoteOnTimeout,
    autoApproveReadOnly: config?.autoApproveReadOnly !== false,
    approvalCache: config?.approvalCache !== false,
    policy: {
      allow: parsePrefixRules(config?.allowCommands),
      deny: parsePrefixRules(config?.denyCommands)
    }
  }
  // Descriptions follow `dsh-tool-bash` / `dsh-tool-pwsh` sentence for sentence:
  // fresh shell, pass workdir, truncation + spill path, description before
  // command, delete/move caution, exit-code markers, long-running contract.
  const longRunning = backgroundEnabled
    ? 'Long-running commands: `run_in_background: true` returns a job id (collect with `job_output`, stop with `job_kill`); '
      + (promoteOnTimeout ? 'a foreground call that exceeds its timeout moves to a background job instead of being killed.' : 'a foreground call is killed when its timeout expires.')
    : 'Long-running commands: run them through `wsl_bash` or ask the human; this deployment has background execution disabled.'
  const gitBashDescription = 'Execute a bash command (`bash -c`) through Git Bash on the Windows host and return its stdout/stderr. '
    + 'Each call runs in a fresh shell; pass `workdir` instead of using `cd`. '
    + 'Runs with full user privileges and is NOT file-sandboxed (the Windows ACL runner cannot start Cygwin/MSYS2). '
    + 'In a read-only or workspace-write session, a command line the static policy recognises as read-only runs without asking; writes, known-dangerous commands and shell lines the policy cannot verify ask the user first. A danger-full-access session runs everything directly. '
    + 'Managed `$DSH_*` variables expose current harness environment facts. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + 'Provide `description` before `command` in the arguments. '
    + 'Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. '
    + 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. '
    + longRunning
  const wslBashDescription = 'Execute a bash command inside WSL2 (a real Linux environment) via `wsl.exe -d <distro> -- bash -lc` and return its stdout/stderr. '
    + 'Windows paths pass through `--cd` and become `/mnt/c/...`; pass `workdir` instead of using `cd`. '
    + 'Each call runs in a fresh shell as the distro default user. '
    + 'Managed `$DSH_*` variables expose current harness environment facts. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + 'Provide `description` before `command` in the arguments. '
    + 'Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked. '
    + 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. '
    + longRunning
  const disposers = []
  disposers.push(ctx.tools.register(buildTool(ctx, 'git_bash', gitBashDescription, 'local', opts)))
  disposers.push(ctx.tools.register(buildTool(ctx, 'wsl_bash', wslBashDescription, 'wsl', opts)))
  // The same prompt guidance the shipped shell tools register, so the model
  // reads one marker contract whichever shell it picks. git_bash takes the
  // shipped bash slot (TOOL_BASH) and wsl_bash the shipped pwsh slot
  // (TOOL_PWSH), keeping the pair in the official bash-then-pwsh order.
  if (ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function'
    && typeof ctx.systemPrompt.getSectionOrder === 'function') {
    try {
      const promoteHint = promoteOnTimeout
        ? ' A foreground command that exceeds its timeout moves to a background job (`job_output` reads it, `job_kill` stops it) instead of being killed.'
        : ' A foreground command is killed when its timeout expires.'
      disposers.push(ctx.systemPrompt.section({
        name: 'tool:git_bash',
        order: ctx.systemPrompt.getSectionOrder('TOOL_BASH'),
        text: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. '
          + 'A killed command settles as `[killed by signal: ...]`; treat a bare exit 1 after an interruption as a termination, not a command failure. '
          + 'The git_bash tool is not file-sandboxed: in a read-only or workspace-write session, read-only command lines run without asking while writes, dangerous commands and unverifiable shell lines ask the user, and a rejected approval means nothing ran — do not retry it unchanged.'
          + promoteHint
      }))
      disposers.push(ctx.systemPrompt.section({
        name: 'tool:wsl_bash',
        order: ctx.systemPrompt.getSectionOrder('TOOL_PWSH'),
        text: 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. '
          + 'A killed command settles as `[killed by signal: ...]`.'
          + promoteHint
      }))
    } catch (error) {
      if (ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn(name + ': could not register the shell guidance section: ' + String(error))
      }
    }
  }
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
