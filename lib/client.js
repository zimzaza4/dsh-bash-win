window.__ModuleLoader__.load({
	id: '@zimzaza4/dsh-bash-win',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require('react');

		const css = ".bashx-card{display:flex;flex-direction:column}.bashx-root{display:flex;align-items:center;min-width:0;height:24px;position:relative;overflow:hidden;cursor:pointer}.bashx-root[data-state=running]:after{content:\"\";background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent) 55%,transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite bashx-sweep;position:absolute;top:0;bottom:0;left:0}@keyframes bashx-sweep{0%{left:-300px}90%,to{left:100%}}.bashx-leading{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;justify-content:center;align-items:center;margin-right:6px;position:relative}.bashx-title{white-space:nowrap;flex:none;color:var(--dsw-alias-label-primary)}.bashx-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}.bashx-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:auto;font-size:14px;line-height:24px;overflow:hidden}.bashx-chevron{color:var(--dsw-alias-label-secondary);flex:none;display:inline-flex;margin-left:4px}.bashx-bodyWrap{flex-direction:column;display:flex}.bashx-terminal{border:1px solid var(--dsw-alias-border-l1);margin:4px 0 4px 4px;border-radius:12px;background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);line-height:18px;max-height:224px;overflow:auto;padding:12px 16px}.bashx-termHead{display:flex;gap:8px;align-items:baseline}.bashx-termPrompt{color:var(--dsw-alias-label-caption);flex:none}.bashx-termCommand{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}.bashx-termOutput{margin-top:8px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}.bashx-termStatus{margin-top:8px;color:var(--dsw-alias-label-tertiary)}";
		const tagId = '@zimzaza4/dsh-bash-win/toolview.css';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = '@zimzaza4/dsh-bash-win';
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const TITLES = {
			git_bash: 'Git Bash',
			wsl_bash: 'WSL Bash'
		};

		function terminalIcon() {
			return react.createElement('svg', {
				viewBox: '0 0 16 16',
				width: 14,
				height: 14,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.2,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': true
			},
				react.createElement('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
				react.createElement('path', { d: 'M4.5 6.5 L7 9 L4.5 11.5' }),
				react.createElement('path', { d: 'M8.5 11.5 H11.5' })
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
				style: open ? { transform: 'rotate(90deg)' } : undefined
			},
				react.createElement('path', { d: 'M6 4 L10 8 L6 12' })
			);
		}

		function TerminalRow(props) {
			const block = props.block;
			const sessionCwd = typeof props.cwd === 'string' && props.cwd.length > 0 ? props.cwd : undefined;
			const isRecord = block !== null && typeof block === 'object' && !Array.isArray(block);
			const callView = isRecord && block.callView !== null && typeof block.callView === 'object' && block.callView.card === 'terminal' ? block.callView : null;
			const settled = isRecord && 'kind' in block;
			const resultView = settled && block.resultView !== null && typeof block.resultView === 'object' && block.resultView.card === 'terminal' ? block.resultView : null;

			// Fallback: derive the command from the call arguments when no
			// terminal call/result view is available (historical/replay blocks,
			// Code-mode sub-calls). Tries every plausible field shape.
			let fallbackCommand = null;
			if (isRecord) {
				const candidates = [];
				if (settled) {
					if (block.call && typeof block.call === 'object') candidates.push(block.call.arguments);
					if (block.data && typeof block.data === 'object') candidates.push(block.data.arguments, block.data.call && block.data.call.arguments);
				} else {
					candidates.push(block.arguments);
					if (block.data && typeof block.data === 'object') candidates.push(block.data.arguments);
				}
				for (const raw of candidates) {
					if (typeof raw === 'string' && raw.length > 0) {
						try {
							const parsed = JSON.parse(raw);
							if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string' && parsed.command.length > 0) { fallbackCommand = parsed.command; break; }
							if (typeof parsed === 'string' && parsed.length > 0) { fallbackCommand = parsed; break; }
						} catch (e) { /* try next */ }
					} else if (raw && typeof raw === 'object' && typeof raw.command === 'string' && raw.command.length > 0) {
						fallbackCommand = raw.command;
						break;
					}
				}
			}
			const outputTextOf = (b) => {
				if (!b || !Array.isArray(b.content)) return '';
				const parts = [];
				for (const item of b.content) {
					if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
				}
				return parts.join('\n');
			};

			let terminal = null;
			if (resultView !== null) {
				terminal = {
					running: false,
					description: callView !== null && typeof callView.description === 'string' ? callView.description : undefined,
					command: typeof resultView.title === 'string' && resultView.title.length > 0 ? resultView.title : (callView !== null && typeof callView.title === 'string' ? callView.title : ''),
					cwd: callView !== null && typeof callView.cwd === 'string' && callView.cwd.length > 0 ? callView.cwd : sessionCwd,
					output: typeof resultView.output === 'string' ? resultView.output : '',
					exitCode: typeof resultView.exitCode === 'number' ? resultView.exitCode : undefined,
					signal: typeof resultView.signal === 'string' && resultView.signal.length > 0 ? resultView.signal : undefined
				};
			} else if (callView !== null && !settled) {
				terminal = {
					running: true,
					description: typeof callView.description === 'string' ? callView.description : undefined,
					command: typeof callView.title === 'string' ? callView.title : '',
					cwd: typeof callView.cwd === 'string' && callView.cwd.length > 0 ? callView.cwd : sessionCwd,
					output: '',
					exitCode: undefined,
					signal: undefined
				};
			} else {
				// Ultimate fallback: every block renders an expandable card.
				// Command may be unknown (parse failed); output still shows.
				terminal = {
					running: !settled,
					description: undefined,
					command: fallbackCommand !== null ? fallbackCommand : (TITLES[props.toolName] || 'Bash'),
					cwd: sessionCwd,
					output: outputTextOf(block),
					exitCode: undefined,
					signal: undefined
				};
			}

			const running = terminal !== null && terminal.running;
			const failed = settled && block.error !== undefined;
			const state = running ? 'running' : failed ? 'error' : 'ok';
			const [expanded, setExpanded] = react.useState(false);
			const expandable = terminal !== null;
			const open = expanded && expandable;
			const summary = terminal !== null && typeof terminal.description === 'string' && terminal.description.length > 0 ? terminal.description : (terminal !== null ? terminal.command : '');
			const title = TITLES[props.toolName] || 'Bash';
			const toggle = () => setExpanded((v) => !v);
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
					onClick: expandable ? toggle : undefined,
					onKeyDown: onKeyDown
				},
					react.createElement('span', { className: 'bashx-leading' }, terminalIcon()),
					react.createElement('span', { className: 'bashx-title' }, title),
					react.createElement('span', { className: 'bashx-sep', 'aria-hidden': true }),
					react.createElement('span', { className: 'bashx-summary' }, summary),
					react.createElement('span', { className: 'bashx-chevron' }, chevronIcon(open))
				),
				open && terminal !== null ? react.createElement('div', { className: 'bashx-bodyWrap' },
					react.createElement('div', { className: 'bashx-terminal' },
						react.createElement('div', { className: 'bashx-termHead' },
							react.createElement('span', { className: 'bashx-termPrompt' }, terminal.cwd !== undefined && terminal.cwd.length > 0 ? terminal.cwd + ' $' : '$'),
							react.createElement('span', { className: 'bashx-termCommand' }, terminal.command)
						),
						terminal.output.length > 0 ? react.createElement('pre', { className: 'bashx-termOutput' }, terminal.output) : null,
						!terminal.running ? react.createElement('div', { className: 'bashx-termStatus' },
							terminal.exitCode !== undefined ? (terminal.exitCode === 0 ? 'exit code: 0' : 'exit code: ' + String(terminal.exitCode)) : (terminal.signal !== undefined ? terminal.signal : '')
						) : null
					)
				) : null
			);
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
