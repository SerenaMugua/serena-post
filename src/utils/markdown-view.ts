import { App, MarkdownView } from 'obsidian';
import { ensureLoadedView, loadedView } from './deferred-view';

/**
 * 找「当前要处理的笔记」：优先用正在编辑的那篇；
 * 没有的话找已经打开的笔记标签。被 Obsidian 延迟加载的笔记标签（空壳）会先加载出来，
 * 否则调用 getViewData / editor 会报「xxx is not a function」。
 */
export async function findMarkdownView(app: App): Promise<MarkdownView | null> {
	const active = app.workspace.getActiveViewOfType(MarkdownView);
	if (active) return active;
	const leaves = app.workspace.getLeavesOfType('markdown');
	for (const leaf of leaves) {
		const view = loadedView(leaf, MarkdownView);
		if (view) return view;
	}
	return ensureLoadedView(leaves[0], MarkdownView);
}

/** 同步版本：只返回已经加载好的笔记，空壳跳过 */
export function findLoadedMarkdownView(app: App): MarkdownView | null {
	const active = app.workspace.getActiveViewOfType(MarkdownView);
	if (active) return active;
	for (const leaf of app.workspace.getLeavesOfType('markdown')) {
		const view = loadedView(leaf, MarkdownView);
		if (view) return view;
	}
	return null;
}
