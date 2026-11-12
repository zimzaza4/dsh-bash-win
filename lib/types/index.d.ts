import type { Context } from '@deepseek-ai/cordis';

/** Plugin config: program paths, default WSL distro, and the shipped shell-tool switches. */
export interface BashxConfig {
  /** Explicit Git Bash path (empty = env DSH_BASHX_BASH_PATH, then auto-detect). */
  bashPath?: string;
  /** Explicit wsl.exe path (empty = env DSH_BASHX_WSL_PATH, then auto-detect). */
  wslPath?: string;
  /** Default WSL distribution (empty = env DSH_BASHX_WSL_DISTRO, then Ubuntu). */
  wslDistro?: string;
  /** Advertise `run_in_background` and let foreground calls promote to jobs (default true). */
  enableRunInBackground?: boolean;
  /** Hand a timed-out foreground command to a background job instead of killing it (default true). */
  promoteOnTimeout?: boolean;
}

/** Cordis plugin id. */
export declare const name: string;
/** Hard dependencies. */
export declare const inject: readonly ['tools', 'systemPrompt'];
/**
 * Plugin apply: registers the git_bash (Git Bash) and wsl_bash (WSL2) model
 * tools plus their prompt guidance sections into the host.
 * @param ctx - the plugin context.
 * @param config - optional plugin config (program paths, default distro, background switches).
 * @returns a disposer that unregisters every tool and prompt section.
 */
export declare function apply(ctx: Context, config?: BashxConfig): () => void;
