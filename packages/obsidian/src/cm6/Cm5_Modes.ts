import { mapIndexToLineColumn } from '@lemons_dev/parsinom';
import type { Mode, StringStream } from 'codemirror';
import type { InlineFieldType } from 'meta-bind-core/src/config/APIConfigs';
import { SyntaxHighlighting } from 'meta-bind-core/src/parsers/syntaxHighlighting/SyntaxHighlighting';
import type { ObsMetaBind } from 'meta-bind-obsidian/src/ObsMB';

export function registerCm5HLModes(mb: ObsMetaBind): void {
	if (!mb.getSettings().enableSyntaxHighlighting) {
		return;
	}

	window.CodeMirror.defineMode('meta-bind-button', config => window.CodeMirror.getMode(config, 'yaml'));
	window.CodeMirror.defineMode('meta-bind-js-view', config => window.CodeMirror.getMode(config, 'javascript'));

	const codeBlockEndRegexp = /^\s*(```+|~~~+)/;

	interface MBModeState {
		str?: string;
		fieldType?: InlineFieldType;
		highlights?: SyntaxHighlighting;
		line: number;
	}

	window.CodeMirror.defineMode('meta-bind', _config => {
		const mode: Mode<MBModeState> = {
			startState: () => {
				return {
					str: undefined,
					highlights: undefined,
					line: 1,
				};
			},

			token: (stream: StringStream, state: MBModeState) => {
				// the idea is that we get the whole content of the code block at the beginning
				// then parse it and save the generated highlights
				// then the stream parser can simply look up the highlights for the current line and column
				if (state.str === undefined) {
					const lines = [stream.string];
					let i = 1;
					let lookAhead = stream.lookAhead(i);

					while (lookAhead !== undefined && !codeBlockEndRegexp.test(lookAhead)) {
						lines.push(lookAhead);
						i += 1;
						lookAhead = stream.lookAhead(i);

						// fail-safe, if we miss the end of the code block
						if (i > 100) break;
					}

					// Preserve blank lines so parsed highlight offsets stay aligned with
					// the original CodeMirror line numbers.
					state.str = lines.join('\n');

					const fieldType = mb.api.isInlineFieldDeclarationAndGetType(state.str.trim());
					if (fieldType === undefined) {
						state.highlights = new SyntaxHighlighting(state.str, []);
					} else {
						state.fieldType = fieldType;
						state.highlights = mb.syntaxHighlighting.highlight(state.str, state.fieldType, true);
					}

					// console.log(state.str, state.highlights.getHighlights());
				}

				const lineHighlights = state.highlights
					?.getHighlights()
					.map(h => ({
						highlight: h,
						from: state.str ? mapIndexToLineColumn(state.str, h.range.from) : { line: 1, column: 1 },
						to: state.str ? mapIndexToLineColumn(state.str, h.range.to) : { line: 1, column: 1 },
					}))
					.filter(h => h.from.line === state.line);
				const highlight = lineHighlights?.find(h => h.from.column === stream.pos + 1);

				// console.log(state.line, stream.pos, stream.peek(), highlight);

				if (highlight === undefined) {
					stream.next();
					if (stream.eol()) {
						state.line += 1;
					}
					return `line-HyperMD-codeblock`;
				}

				if (
					!stream.eatWhile(() => {
						if (highlight.to.line !== state.line) {
							return !stream.eol();
						}

						return stream.pos + 1 < highlight.to.column;
					})
				) {
					stream.next();
				}
				if (stream.eol()) {
					state.line += 1;
				}
				return `line-HyperMD-codeblock mb-highlight-${highlight.highlight.tokenClass}`;
			},
		};

		return mode;
	});
}
