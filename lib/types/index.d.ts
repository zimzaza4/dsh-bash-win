import type { Context } from '@deepseek-ai/cordis';

/** Plugin config: explicit program paths and default WSL distro (empty = auto). */
export interface BashxConfig {
  /** Explicit Git Bash path (empty = env DSH_BASHX_BASH_PATH, then auto-detect). */
  bashPath?: string;
  /** Explicit wsl.exe path (empty = env DSH_BASHX_WSL_PATH, then auto-detect). */
  wslPath?: string;
  /** Default WSL distribution (empty = env DSH_BASHX_WSL_DISTRO, then Ubuntu). */
  wslDistro?: string;
}

/** Cordis plugin id. */
export declare const name: string;
/** Hard dependencies. */
export declare const inject: readonly ['tools'];
/**
 * Plugin apply: registers the git_bash / wsl_bash / bash / bash_sandbox
 * model tools into the host tools registry.
 * @param ctx - the plugin context.
 * @param config - optional plugin config (program paths, default distro).
 * @returns a disposer that unregisters every tool.
 */
export declare function apply(ctx: Context, config?: BashxConfig): () => void;
