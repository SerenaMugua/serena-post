// 发布面板被 Obsidian 延迟加载（只是空壳）时，预览不能直接调用它的方法
// 这条测的是 10-10 发现的 bug：正式库预览报「publisher.buildWechatHtml is not a function」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ensureLoadedView, loadedView } from '../src/utils/deferred-view';

class FakePublisher { buildWechatHtml() { return '<p>ok</p>'; } }
class FakeDeferredShell {}

function deferredLeaf() {
	const leaf = {
		view: new FakeDeferredShell() as unknown,
		isDeferred: true,
		loads: 0,
		async loadIfDeferred() { leaf.loads++; leaf.view = new FakePublisher(); leaf.isDeferred = false; },
	};
	return leaf;
}

test('空壳面板：同步取不到（返回 null），不会拿空壳去调用方法', () => {
	assert.equal(loadedView(deferredLeaf(), FakePublisher), null);
});

test('空壳面板：先加载再返回，能正常排版', async () => {
	const leaf = deferredLeaf();
	const view = await ensureLoadedView(leaf, FakePublisher);
	assert.ok(view instanceof FakePublisher);
	assert.equal(view.buildWechatHtml(), '<p>ok</p>');
	assert.equal(leaf.loads, 1);
});

test('已经加载好的面板：直接返回，不重复加载', async () => {
	const leaf = deferredLeaf();
	await leaf.loadIfDeferred();
	const view = await ensureLoadedView(leaf, FakePublisher);
	assert.ok(view instanceof FakePublisher);
	assert.equal(leaf.loads, 1);
});

test('发布面板没打开：返回 null（预览会提示先打开发布面板）', async () => {
	assert.equal(await ensureLoadedView(undefined, FakePublisher), null);
	assert.equal(loadedView(undefined, FakePublisher), null);
});

test('实时预览用的是会先加载面板的写法', () => {
	const src = readFileSync('src/views/live-preview-view.ts', 'utf8');
	assert.doesNotMatch(src, /getPublisherView\(\)/, '实时预览里不要再用 getPublisherView()，空壳面板会报错');
	assert.match(src, /await this\.plugin\.loadPublisherView\(\)/);
});

// 10-12 新发现：后台没显示的「笔记标签」也是空壳，预览报「md.getViewData is not a function」
import { MarkdownView } from 'obsidian';
import { findLoadedMarkdownView, findMarkdownView } from '../src/utils/markdown-view';

function fakeApp(leaves: any[], active: any = null) {
	return { workspace: { getActiveViewOfType: () => active, getLeavesOfType: () => leaves } } as any;
}

test('笔记标签是空壳：同步找不到（不会拿空壳去读内容）', () => {
	const shell = { view: {}, isDeferred: true, loadIfDeferred: async () => {} };
	assert.equal(findLoadedMarkdownView(fakeApp([shell])), null);
});

test('笔记标签是空壳：异步会先加载再返回', async () => {
	const md = new (MarkdownView as any)();
	const leaf: any = { view: {}, isDeferred: true, async loadIfDeferred() { leaf.view = md; leaf.isDeferred = false; } };
	assert.equal(await findMarkdownView(fakeApp([leaf])), md);
});

test('有正在编辑的笔记时优先用它', async () => {
	const active = new (MarkdownView as any)();
	assert.equal(await findMarkdownView(fakeApp([], active)), active);
});
