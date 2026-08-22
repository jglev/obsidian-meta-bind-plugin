import type { EditorView } from '@codemirror/view';
import { WidgetType } from '@codemirror/view';
import type { InlineFieldType } from 'meta-bind-core/src/config/APIConfigs';
import type { MountableMDRC } from 'meta-bind-obsidian/src/MountableMDRC';
import type { ObsMetaBind } from 'meta-bind-obsidian/src/ObsMB';
import type { Component } from 'obsidian';

export class MarkdownRenderChildWidget extends WidgetType {
	mb: ObsMetaBind;
	type: InlineFieldType;
	content: string;
	filePath: string;
	parentComponent: Component;
	renderChild?: MountableMDRC;

	constructor(type: InlineFieldType, content: string, filePath: string, component: Component, mb: ObsMetaBind) {
		super();
		this.type = type;
		this.content = content;
		this.filePath = filePath;
		this.parentComponent = component;
		this.mb = mb;
	}

	eq(other: MarkdownRenderChildWidget): boolean {
		return other.type === this.type && other.content === this.content && other.filePath === this.filePath;
	}

	public toDOM(_: EditorView): HTMLElement {
		const span = createSpan();
		span.addClass('cm-inline-code');
		span.addClass('mb-inline-widget-rendered');

		const mountable = this.mb.api.createInlineFieldOfTypeFromString(
			this.type,
			this.content,
			this.filePath,
			undefined,
		);

		this.renderChild = this.mb.api.wrapInMDRC(mountable, span, this.parentComponent);

		return span;
	}

	public unloadRenderChild(): void {
		const renderChild = this.renderChild;
		if (!renderChild) {
			return;
		}

		this.renderChild = undefined;
		this.parentComponent.removeChild(renderChild);
	}

	public destroy(dom: HTMLElement): void {
		this.unloadRenderChild();
		super.destroy(dom);
	}
}
