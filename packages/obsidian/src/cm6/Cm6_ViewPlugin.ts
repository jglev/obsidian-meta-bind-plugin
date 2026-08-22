import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range, RangeSet } from '@codemirror/state';
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view';
import { Decoration, ViewPlugin } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { summary } from 'itertools-ts/es';
import type { InlineFieldType } from 'meta-bind-core/src/config/APIConfigs';
import type { MB_WidgetSpec } from 'meta-bind-obsidian/src/cm6/Cm6_Util';
import { Cm6_Util, MB_WidgetType } from 'meta-bind-obsidian/src/cm6/Cm6_Util';
import type { ObsMetaBind } from 'meta-bind-obsidian/src/ObsMB';
import type { TFile } from 'obsidian';
import { Component, editorLivePreviewField } from 'obsidian';

interface NodeData {
	content: string;
	widgetType: InlineFieldType | undefined;
	// If the node is truly an inline code block, meaning it starts and ends with a backtick.
	trulyInline: boolean;
}

interface RenderNodeData {
	content: string;
	widgetType: InlineFieldType;
	// If the node is truly an inline code block, meaning it starts and ends with a backtick.
	trulyInline: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMarkdownRenderChildWidgetEditorPlugin(mb: ObsMetaBind): ViewPlugin<any> {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			/**
			 * Component for unloading the widgets if the view plugin is destroyed.
			 */
			component: Component;

			constructor(view: EditorView) {
				this.component = new Component();
				this.component.load();
				this.decorations = this.renderWidgets(view) ?? Decoration.none;

				view.dom.addEventListener('click', e => this.handleClick(e));
			}

			handleClick(e: MouseEvent): void {
				if (e.target instanceof HTMLElement) {
					let parent: HTMLElement | null = e.target;

					// check if the click was inside an input field
					while (parent !== null) {
						if (parent.classList.contains('mb-input')) {
							e.stopPropagation();
							// Uncommenting this will fix #403
							// but it will break date and time inputs
							// e.preventDefault();
							break;
						}

						parent = parent.parentElement;
					}
				}
			}

			isLivePreview(state: EditorState): boolean {
				// @ts-ignore some strange private field not being assignable
				return state.field(editorLivePreviewField);
			}

			/**
			 * Triggered by codemirror when the view updates.
			 * Depending on the update type, the decorations are either updated or recreated.
			 *
			 * @param update
			 */
			update(update: ViewUpdate): void {
				this.decorations = this.decorations.map(update.changes);

				// Rebuilding replace decorations while an IME composition is active can
				// interrupt the composition and corrupt text at soft-wrap boundaries.
				// Keep mapping the existing decorations, but wait until composition ends
				// before reconciling widgets with the syntax tree.
				if (update.view.compositionStarted) {
					return;
				}

				const renderContextChanged =
					this.isLivePreview(update.state) !== this.isLivePreview(update.startState) ||
					Cm6_Util.getCurrentFileFromState(update.state)?.path !==
						Cm6_Util.getCurrentFileFromState(update.startState)?.path;
				if (!update.docChanged && !update.viewportChanged && !update.selectionSet && !renderContextChanged) {
					return;
				}

				this.updateWidgets(update.view);
			}

			/**
			 * Updates all the widgets by traversing the syntax tree.
			 *
			 * @param view
			 */
			updateWidgets(view: EditorView): void {
				const visibleRanges = view.visibleRanges;
				const tree = syntaxTree(view.state);
				const reusableFieldWidgets = new Map<string, Range<Decoration>>();
				this.decorations.between(0, view.state.doc.length, (from, to, decoration) => {
					const spec = decoration.spec as MB_WidgetSpec;
					if (
						spec.mb_widgetType === MB_WidgetType.FIELD &&
						spec.mb_content !== undefined &&
						spec.mb_filePath !== undefined
					) {
						reusableFieldWidgets.set(
							JSON.stringify([from, to, spec.mb_content, spec.mb_filePath]),
							decoration.range(from, to),
						);
					}
				});

				const widgets: Range<Decoration>[] = [];
				const currentFile = Cm6_Util.getCurrentFile(view);
				for (const { from, to } of visibleRanges) {
					tree.iterate({
						from,
						to,
						enter: nodeRef => {
							const node = nodeRef.node;
							const renderInfo = this.getRenderInfo(view, node);

							if (!renderInfo.data?.widgetType) {
								return;
							}

							// safe cast because the widget type was checked above
							const renderData: RenderNodeData = renderInfo.data as RenderNodeData;
							let widget: Range<Decoration> | Range<Decoration>[] | undefined;

							if (currentFile && renderInfo.shouldRender) {
								const key = JSON.stringify([
									node.from - 1,
									node.to + 1,
									renderData.content,
									currentFile.path,
								]);
								const reusableWidget = reusableFieldWidgets.get(key);
								widget =
									reusableWidget ??
									this.renderWidget(node, MB_WidgetType.FIELD, renderData, currentFile);
							} else if (currentFile && renderInfo.shouldHighlight) {
								widget = this.renderWidget(node, MB_WidgetType.HIGHLIGHT, renderData, currentFile);
							}

							if (Array.isArray(widget)) {
								widgets.push(...widget);
							} else if (widget) {
								widgets.push(widget);
							}
						},
					});
				}

				this.decorations = this.decorations.update({
					filter: (decFrom, decTo, decoration) => {
						const spec = decoration.spec as MB_WidgetSpec;
						if (!spec.mb_widgetType) {
							return true;
						}

						const inVisibleRange = summary.anyMatch(visibleRanges, range =>
							Cm6_Util.checkRangeOverlap(decFrom, decTo, range.from, range.to),
						);
						if (!inVisibleRange) {
							spec.mb_unload?.();
						}

						return false;
					},
					add: widgets,
					sort: true,
				});
			}

			/**
			 * Checks whether to render a widget at a given node and the type of the widget to render.
			 *
			 * @param view
			 * @param node
			 */
			getRenderInfo(
				view: EditorView,
				node: SyntaxNode,
			): {
				shouldRender: boolean;
				shouldHighlight: boolean;
				data: NodeData | undefined;
			} {
				// get the node props
				// const propsString: string | undefined = node.type.prop<string>(tokenClassNodeProp);
				// workaround until bun installs https://github.com/lishid/cm-language/ correctly
				const props: Set<string> = new Set<string>(node.type.name?.split('_'));

				// node is inline code
				if (props.has('inline-code') && !props.has('formatting')) {
					// check for selection or cursor overlap
					const data = this.readNode(view, node.from, node.to);
					// if the node is not truly inline, we do not render it
					// this can happen for proper code blocks in callouts in LP mode. Idk why, but we have to work around it
					if (!data.trulyInline) {
						return { shouldRender: false, shouldHighlight: false, data: undefined };
					}

					const hasSelectionOverlap = Cm6_Util.checkSelectionOverlap(
						view.state.selection,
						node.from - 1,
						node.to + 1,
					);
					const isLivePreview = this.isLivePreview(view.state);
					// if we are in live preview mode, we only render the widget if there is no selection overlap
					// otherwise the user has it's cursor within the bounds of the code for the field and we do syntax highlighting
					// if we are not in live preview, so in source mode, we always do syntax highlighting
					const shouldRenderField = !hasSelectionOverlap && isLivePreview;

					return {
						shouldRender: shouldRenderField,
						// we need to also check that the user has highlighting enabled in the settings
						shouldHighlight: !shouldRenderField && mb.getSettings().enableSyntaxHighlighting,
						data: data,
					};
				}
				return { shouldRender: false, shouldHighlight: false, data: undefined };
			}

			/**
			 * Reads the content of an editor range and checks if it is a declaration if so also returning the widget type.
			 *
			 * @param view
			 * @param from
			 * @param to
			 */
			readNode(view: EditorView, from: number, to: number): NodeData {
				let trulyInline = false;
				try {
					const extendedContent = Cm6_Util.getContent(view.state, from - 1, to + 1);
					trulyInline = extendedContent.startsWith('`') && extendedContent.endsWith('`');
				} catch (_) {
					// we failed to read one more character before and after the node, so we assume it is not truly inline
				}
				const content = Cm6_Util.getContent(view.state, from, to);

				return {
					content: content,
					widgetType: mb.api.isInlineFieldDeclarationAndGetType(content),
					trulyInline: trulyInline,
				};
			}

			/**
			 * Creates the initial widget decorations for the visible ranges.
			 *
			 * @param view
			 */
			renderWidgets(view: EditorView): RangeSet<Decoration> | undefined {
				const currentFile = Cm6_Util.getCurrentFile(view);
				if (!currentFile) {
					return undefined;
				}

				const widgets: Range<Decoration>[] = [];

				for (const range of view.visibleRanges) {
					syntaxTree(view.state).iterate({
						from: range.from,
						to: range.to,
						enter: nodeRef => {
							const node = nodeRef.node;

							const renderInfo = this.getRenderInfo(view, node);

							if (!renderInfo.data?.widgetType) {
								return;
							}

							// safe cast because we checked for widgetType above
							const renderData: RenderNodeData = renderInfo.data as RenderNodeData;

							let widget: Range<Decoration> | Range<Decoration>[] | undefined = undefined;

							if (renderInfo.shouldRender) {
								widget = this.renderWidget(node, MB_WidgetType.FIELD, renderData, currentFile);
							} else if (renderInfo.shouldHighlight) {
								widget = this.renderWidget(node, MB_WidgetType.HIGHLIGHT, renderData, currentFile);
							}

							if (widget) {
								if (Array.isArray(widget)) {
									widgets.push(...widget);
								} else {
									widgets.push(widget);
								}
							}
						},
					});
				}

				return Decoration.set(widgets, true);
			}

			/**
			 * Creates decorations for a single inline field node.
			 * Note that this should only be called on a node that was determined to be truly inline.
			 *
			 * @param node
			 * @param type
			 * @param data
			 * @param currentFile
			 */
			renderWidget(
				node: SyntaxNode,
				type: MB_WidgetType,
				data: RenderNodeData,
				currentFile: TFile,
			): Range<Decoration> | Range<Decoration>[] {
				if (type === MB_WidgetType.FIELD) {
					const widget = mb.api.constructMDRCWidget(
						data.widgetType,
						data.content,
						currentFile.path,
						this.component,
					);

					return Decoration.replace({
						widget: widget,
						mb_widgetType: MB_WidgetType.FIELD,
						mb_unload: () => widget.unloadRenderChild(),
						mb_content: data.content,
						mb_filePath: currentFile.path,
					}).range(node.from - 1, node.to + 1); // since we know that the it's truly inline, we can safely use -1 and +1
				} else {
					const highlight = mb.syntaxHighlighting.highlight(data.content, data.widgetType, false);

					return highlight.getHighlights().map(h => {
						return Decoration.mark({
							class: `mb-highlight-${h.tokenClass}`,
							mb_widgetType: MB_WidgetType.HIGHLIGHT,
						}).range(node.from + h.range.from, node.from + h.range.to);
					});
				}
			}

			/**
			 * Triggered by codemirror when the view plugin is destroyed.
			 * Unloads all widgets.
			 */
			destroy(): void {
				this.component.unload();
			}
		},
		{
			decorations: v => v.decorations,
		},
	);
}
