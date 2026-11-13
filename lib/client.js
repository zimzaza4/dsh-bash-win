window.__ModuleLoader__.load({
	id: '@zimzaza4/dsh-bash-win',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require('react');

		const css = ".bashx-card{display:flex;flex-direction:column}.bashx-root{display:flex;align-items:center;min-width:0;height:calc(24px + var(--dsh-content-font-delta,0px));position:relative;overflow:hidden;cursor:pointer;color:var(--dsw-alias-label-tertiary)}.bashx-root[data-state=running]:after{content:\"\";background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent) 55%,transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite bashx-sweep;position:absolute;top:0;bottom:0;left:0}@keyframes bashx-sweep{0%{left:-300px}90%,to{left:100%}}.bashx-leading{width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));color:inherit;flex:none;display:inline-flex;justify-content:center;align-items:center;margin-right:6px;position:relative}.bashx-leading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}.bashx-title{white-space:nowrap;flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit}.bashx-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.bashx-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:1 1 auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));overflow:hidden}.bashx-summary[data-error]{color:var(--dsw-alias-state-error-primary)}.bashx-dot{position:relative;display:inline-block;flex:none;width:10px;height:10px;color:var(--dsw-alias-state-idle-primary)}.bashx-dot:after{content:\"\";position:absolute;inset:20%;border-radius:50%;background:currentColor}.bashx-dot[data-state=done]{color:var(--dsw-alias-state-success-primary)}.bashx-dot[data-state=error]{color:var(--dsw-alias-state-error-primary)}.bashx-exit{display:inline-flex;align-items:center;gap:5px;flex:none;margin-left:8px;padding:0 8px;height:18px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:999px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:nowrap}.bashx-exitDot{width:4px;height:4px;border-radius:50%;background:currentColor;flex:none}.bashx-bodyWrap{flex-direction:column;display:flex}.bashx-terminal{margin:4px 0 4px 4px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);line-height:18px;overflow:hidden}.bashx-termHead{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);min-height:26px}.bashx-termLabel{flex:none;color:var(--dsw-alias-label-tertiary)}.bashx-termCwd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,\"Cascadia Mono\",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary)}.bashx-copy{flex:none;margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;padding:2px 6px;border-radius:6px;cursor:pointer}.bashx-copy:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}.bashx-termBody{padding:8px 12px;max-height:224px;overflow:auto}.bashx-termLine{display:flex;gap:8px;align-items:baseline;min-width:0}.bashx-termPrompt{color:var(--dsw-alias-label-caption);flex:none;user-select:none}.bashx-termCommand{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;min-width:0}.bashx-termOutput{margin-top:6px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}.bashx-termStatus{margin-top:8px;color:var(--dsw-alias-state-warn-label);white-space:pre-wrap;word-break:break-word}";
		const tagId = '@zimzaza4/dsh-bash-win/toolview.css';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = '@zimzaza4/dsh-bash-win';
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const TITLES = { git_bash: 'Git Bash', wsl_bash: 'WSL Bash' };

		/**
		 * The terminal glyph: a screen frame with the classic `>_` prompt.
		 *
		 * Sized and centred to sit beside the shipped 16px tool icons instead of a
		 * size of its own. The frame spans x 1..15 and y 2..14, so its centre is
		 * (8, 8) and the prompt is placed around that point — the earlier 14px box
		 * drew the frame at y 2.5..13.5 but the prompt at y 6.5..11.5, i.e. one pixel
		 * low and visibly off-centre next to the other rows.
		 */
		function terminalIcon() {
			return react.createElement('svg', {
				viewBox: '0 0 16 16',
				width: 16,
				height: 16,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.5,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true
			},
				react.createElement('rect', { x: 1, y: 2, width: 14, height: 12, rx: 2 }),
				react.createElement('path', { d: 'M4.5 5.5 L7 8 L4.5 10.5' }),
				react.createElement('path', { d: 'M8.5 10.5 H11.5' })
			);
		}

		function chevronIcon(open) {
			return react.createElement('svg', {
				viewBox: '0 0 16 16',
				width: 14,
				height: 14,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.4,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true,
				style: open ? { transform: 'rotate(-90deg)' } : undefined
			},
				react.createElement('path', { d: 'M6 4 L10 8 L6 12' })
			);
		}

		/** Parse a JSON object payload; {} on malformed or still-streaming input. */
		function parseArgsObject(raw) {
			if (typeof raw !== 'string' || raw.length === 0) return {};
			try {
				const value = JSON.parse(raw);
				if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
			} catch (e) { /* partial or malformed */ }
			return {};
		}

		/**
		 * Read one string field out of a possibly truncated argument prefix.
		 *
		 * The preparing phase exposes only the raw, still-streaming argument text, so
		 * the whole payload cannot be parsed. The full payload is tried first; the
		 * tolerant field scan is the fallback that keeps the live command visible
		 * while the model is still writing it.
		 */
		function partialString(raw, key) {
			const whole = parseArgsObject(raw);
			if (typeof whole[key] === 'string') return whole[key];
			if (typeof raw !== 'string' || raw.length === 0) return '';
			const match = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(raw);
			if (match === null || typeof match[1] !== 'string') return '';
			try { return JSON.parse('"' + match[1] + '"'); } catch (e) { return match[1]; }
		}

		/** Concatenate the text parts of one Tool result payload. */
		function contentTextOf(block) {
			if (block === null || typeof block !== 'object' || !Array.isArray(block.content)) return '';
			const parts = [];
			for (const item of block.content) {
				if (item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
			}
			return parts.join('\n');
		}

		/** Drop the `$ <command>` echo the Host renderer prepends; the card head owns it. */
		function stripCommandEcho(text, command) {
			if (command.length === 0) return text;
			const echo = '$ ' + command;
			if (text === echo) return '';
			return text.startsWith(echo + '\n') ? text.slice(echo.length + 1) : text;
		}

		/** Remove a trailing exit-status marker line from the body. */
		function withoutStatusMarker(text) {
			return text.replace(/\n\[(?:exit code: -?\d+|killed by signal: [^\]\n]+)\]$/, '');
		}

		/**
		 * Split the renderer's exit-status marker off the result body.
		 *
		 * The card renders the status on its own line, so the consumed marker is
		 * removed rather than shown twice. Truncation and sandbox notices trail the
		 * marker, so the persisted presentation meta is the fallback that still
		 * resolves the status when the marker is not the final line.
		 */
		function splitTerminalStatus(rawText, block, command) {
			const text = stripCommandEcho(rawText, command);
			const meta = block.meta !== null && typeof block.meta === 'object' && !Array.isArray(block.meta) ? block.meta : null;
			// Promoted: this call stopped waiting and the command keeps running as a
			// job, so there is no exit status to show — only where it was handed over.
			// The renderer's own hand-over notice is consumed here, because the card
			// states it on the status line.
			if (meta !== null && meta.promoted === true) {
				const body = text.replace(/\[still running after \d+ms; moved to background job [^\]\n]+\][\s\S]*$/, '').replace(/\n$/, '');
				return { body: body, background: typeof meta.jobId === 'string' && meta.jobId.length > 0 ? meta.jobId : '' };
			}
			const stopped = meta !== null && typeof meta.stopped === 'string' && meta.stopped.length > 0 ? meta.stopped : undefined;
			const withStopped = (value) => (stopped === undefined ? value : Object.assign({}, value, { stopped: stopped }));
			if (meta !== null && meta.background === true) return { body: text };
			if (meta !== null && typeof meta.signal === 'string' && meta.signal.length > 0) {
				return withStopped({ body: withoutStatusMarker(text), signal: meta.signal });
			}
			if (meta !== null && (meta.timedOut === true || meta.aborted === true)) return withStopped({ body: withoutStatusMarker(text) });
			if (meta !== null && typeof meta.exitCode === 'number') {
				return withStopped({ body: withoutStatusMarker(text), exitCode: meta.exitCode });
			}
			const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text);
			if (signal !== null) return { body: text.slice(0, signal.index), signal: signal[1] };
			const exit = /\n\[exit code: (-?\d+)\]$/.exec(text);
			if (exit !== null) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) };
			return { body: text, exitCode: 0 };
		}

		/**
		 * Argument-streaming phase: no dispatched arguments exist yet, so the row
		 * subscribes to the partial argument prefix and shows the command as it is
		 * written. Non-expandable, matching the shipped preparing rows.
		 */
		function PreparingRow(props) {
			// The slot injects this Hook and its presence is fixed for the mounted
			// cell, so the guarded call cannot change hook order between renders.
			const raw = typeof props.useToolCallArgumentsPartial === 'function' ? props.useToolCallArgumentsPartial() : '';
			const command = partialString(raw, 'command');
			const description = partialString(raw, 'description');
			const summary = description.length > 0 ? description : command.length > 0 ? command : 'preparing\u2026';
			return react.createElement('div', { className: 'bashx-card' },
				react.createElement('div', {
					className: 'bashx-root',
					'data-state': 'running',
					title: command.length > 0 ? command : undefined
				},
					react.createElement('span', { className: 'bashx-leading' }, terminalIcon()),
					react.createElement('span', { className: 'bashx-title' }, TITLES[props.toolName] || 'Bash'),
					react.createElement('span', { className: 'bashx-sep', 'aria-hidden': true }),
					react.createElement('span', { className: 'bashx-summary' }, summary)
				)
			);
		}

		/**
		 * Running and settled card.
		 *
		 * The command is read from the arguments the client actually receives —
		 * `block.argsRaw` while running and `block.call.argsRaw` once the result
		 * froze — instead of from the Host-only `presentCall`/`presentResult`
		 * views, which never reach the Web Client. That is what makes the command
		 * visible while the process is still running.
		 */
		function StartedRow(props) {
			const block = props.block;
			const toolName = props.toolName;
			const isRecord = block !== null && typeof block === 'object' && !Array.isArray(block);
			const settled = isRecord && 'kind' in block;
			const settledCall = settled && block.call !== null && typeof block.call === 'object' ? block.call : null;
			const argsRaw = settled
				? settledCall !== null && typeof settledCall.argsRaw === 'string' ? settledCall.argsRaw : ''
				: isRecord && typeof block.argsRaw === 'string' ? block.argsRaw : '';
			const args = parseArgsObject(argsRaw);
			const command = typeof args.command === 'string' ? args.command : '';
			const description = typeof args.description === 'string' ? args.description : '';
			const sessionCwd = typeof props.cwd === 'string' && props.cwd.length > 0 ? props.cwd : undefined;
			const cwd = typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : sessionCwd;
			const status = settled ? splitTerminalStatus(contentTextOf(block), block, command) : null;
			const output = status !== null && typeof status.body === 'string' ? status.body : '';
			const failed = settled && (block.error !== undefined || block.isError === true);
			const state = !settled ? 'running' : failed ? 'error' : 'ok';
			const title = TITLES[toolName] || 'Bash';
			const summary = description.length > 0 ? description : command.length > 0 ? command : title;
			const stopped = status !== null && typeof status.stopped === 'string' && status.stopped.length > 0;
			const exitLabel = status === null || stopped
				? null
				: typeof status.signal === 'string' && status.signal.length > 0
					? '信号 ' + status.signal
					: typeof status.exitCode === 'number' && status.exitCode !== 0
						? '退出码 ' + String(status.exitCode)
						: null;
			const statusText = status === null
				? ''
				: typeof status.background === 'string' && status.background.length > 0
					? 'moved to background: ' + status.background
					: typeof status.stopped === 'string' && status.stopped.length > 0
						? 'stopped: ' + status.stopped
						: '';
			const cwdLabel = (function () {
				if (cwd === undefined || cwd.length === 0) return '';
				const slash = String.fromCharCode(47);
				const backslash = String.fromCharCode(92);
				let endIndex = cwd.length;
				while (endIndex > 0 && (cwd[endIndex - 1] === slash || cwd[endIndex - 1] === backslash)) endIndex -= 1;
				let beginIndex = endIndex;
				while (beginIndex > 0 && cwd[beginIndex - 1] !== slash && cwd[beginIndex - 1] !== backslash) beginIndex -= 1;
				const label = cwd.slice(beginIndex, endIndex);
				return label.length > 0 ? label : cwd;
			})();
			const tooltip = description.length > 0 && command.length > 0
				? description + String.fromCharCode(10) + command
				: command.length > 0 ? command : description;
			const [expanded, setExpanded] = react.useState(false);
			const [copied, setCopied] = react.useState(false);
			const expandable = settled || command.length > 0;
			const open = expanded && expandable;
			const toggle = () => setExpanded((value) => !value);
			const copyCommand = (event) => {
				event.stopPropagation();
				if (command.length === 0) return;
				const done = () => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				};
				try {
					if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
						navigator.clipboard.writeText(command).then(done, () => {});
						return;
					}
					const area = document.createElement('textarea');
					area.value = command;
					area.style.position = 'fixed';
					area.style.opacity = '0';
					document.body.appendChild(area);
					area.select();
					document.execCommand('copy');
					document.body.removeChild(area);
					done();
				} catch (e) { /* clipboard unavailable */ }
			};
			const onKeyDown = (event) => {
				if (!expandable) return;
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					toggle();
				}
			};
			return react.createElement('div', { className: 'bashx-card' },
				react.createElement('div', {
					className: 'bashx-root',
					'data-state': state,
					'data-expandable': expandable || undefined,
					role: expandable ? 'button' : undefined,
					tabIndex: expandable ? 0 : undefined,
					'aria-expanded': expandable ? open : undefined,
					title: tooltip.length > 0 ? tooltip : undefined,
					onClick: expandable ? toggle : undefined,
					onKeyDown: onKeyDown
				},
					react.createElement('span', { className: 'bashx-leading' }, open ? chevronIcon(true) : terminalIcon()),
					react.createElement('span', { className: 'bashx-title' }, title),
					react.createElement('span', { className: 'bashx-sep', 'aria-hidden': true }),
					react.createElement('span', { className: 'bashx-summary', 'data-error': failed && exitLabel === null ? true : undefined }, summary),
					exitLabel !== null ? react.createElement('span', { className: 'bashx-exit' },
						react.createElement('span', { className: 'bashx-exitDot', 'aria-hidden': true }),
						exitLabel
					) : null
				),
				open ? react.createElement('div', { className: 'bashx-bodyWrap' },
					react.createElement('div', { className: 'bashx-terminal' },
						react.createElement('div', { className: 'bashx-termHead' },
							react.createElement('span', {
								className: 'bashx-dot',
								'data-state': state === 'error' ? 'error' : state === 'running' ? 'ongoing' : 'done',
								'aria-hidden': true
							}),
							cwdLabel.length > 0 ? react.createElement('span', { className: 'bashx-termLabel' }, cwdLabel) : null,
							cwd !== undefined && cwd.length > 0 ? react.createElement('span', { className: 'bashx-termCwd' }, "cd '" + cwd + "'") : null,
							command.length > 0 ? react.createElement('button', { className: 'bashx-copy', type: 'button', onClick: copyCommand }, copied ? '已复制' : '复制') : null
						),
						react.createElement('div', { className: 'bashx-termBody' },
							react.createElement('div', { className: 'bashx-termLine' },
								react.createElement('span', { className: 'bashx-termPrompt' }, '$'),
								react.createElement('span', { className: 'bashx-termCommand' }, command)
							),
							output.length > 0 ? react.createElement('pre', { className: 'bashx-termOutput' }, output) : null,
							statusText.length > 0 ? react.createElement('div', { className: 'bashx-termStatus' }, statusText) : null
						)
					)
				) : null
			);
		}

		/** Stage dispatch: preparation streams arguments, start/result carry them. */
		function TerminalRow(props) {
			return props.phase === 'preparing' ? react.createElement(PreparingRow, props) : react.createElement(StartedRow, props);
		}

		const inject = ['slots'];

		function apply(ctx) {
			const slots = ctx.get('slots');
			if (slots === undefined) return;
			for (const key of ['git_bash', 'wsl_bash']) {
				slots.inject('tool.call.toolview', () => slots.register(
					{ name: 'tool.call.toolview', key: key },
					TerminalRow
				));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
