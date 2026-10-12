// 侧栏面板的「延迟加载」处理
//
// Obsidian 1.7 以后，侧栏里没显示出来的面板只是一个空壳（DeferredView），
// 要等用户点开它才真正加载。空壳上没有我们自己写的方法，直接调用会报
// 「xxx is not a function」。所以拿面板之前，先确认它是真正加载好的那个。

export interface LeafLike {
	view: unknown;
	isDeferred?: boolean;
	loadIfDeferred?: () => Promise<void>;
}

/** 只返回已经加载好的面板；空壳或者没打开都返回 null */
export function loadedView<T>(leaf: LeafLike | undefined, ViewClass: abstract new (...args: any[]) => T): T | null {
	return leaf && leaf.view instanceof ViewClass ? leaf.view : null;
}

/** 面板开着但还是空壳时，先让 Obsidian 把它加载出来，再返回 */
export async function ensureLoadedView<T>(leaf: LeafLike | undefined, ViewClass: abstract new (...args: any[]) => T): Promise<T | null> {
	if (!leaf) return null;
	if (leaf.isDeferred && leaf.loadIfDeferred) await leaf.loadIfDeferred();
	return loadedView(leaf, ViewClass);
}
