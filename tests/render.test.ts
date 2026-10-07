// 排版渲染：预览 / 长图 / 发布共用的那条路
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThemeManager, renderSetup, type RenderPrefs } from '../src/utils/theme-manager';
import { MarkedFormatter } from '../src/utils/formatter';
import { HEADING_STYLES, headingStyleCss, headingStyleDef } from '../src/utils/heading-styles';

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const MD = '# 大标题\n\n开头有 ==重点== 和 **加粗**。\n\n## 一、为什么要写\n\n正文\n\n## 二、怎么写\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |\n';

async function themes() {
	const tm = new ThemeManager({} as any);
	return tm.loadThemes();
}
const prefs = (p: Partial<RenderPrefs> = {}): RenderPrefs => ({
	headingStyle: 'theme', headingAvatar: false, avatarDataUrl: '', endMark: false, endMarkText: 'END', ...p,
});

test('15 套内置排版都能加载，包含 Serena 蓝白', async () => {
	const list = await themes();
	assert.equal(list.length, 15);
	const serena = list.find(t => t.name === 'Serena 蓝白');
	assert.ok(serena, '缺少 Serena 蓝白');
	assert.equal(serena!.accent?.toLowerCase(), '#0058a3');
	assert.equal(serena!.accent2?.toLowerCase(), '#53a4ea');
	for (const t of list) assert.ok(t.css.length > 100, `${t.name} 的 CSS 是空的`);
});

test('每一套排版都能把文章渲染出来（不报错、带内联样式）', async () => {
	for (const t of await themes()) {
		const { css, options } = renderSetup(t, prefs());
		const html = await MarkedFormatter.markdownToHtml(MD, css, options);
		assert.match(html, /为什么要写/, t.name);
		assert.match(html, /style="/, `${t.name} 没有内联样式`);
	}
});

test('==高亮== 变成 sp-mark', async () => {
	const t = (await themes())[0];
	const { css, options } = renderSetup(t, prefs());
	const html = await MarkedFormatter.markdownToHtml(MD, css, options);
	assert.match(html, /<span[^>]*class="sp-mark"[^>]*>重点<\/span>/);
});

test('Serena 蓝白：标题自带「一、」时换成 01，不重复', async () => {
	const serena = (await themes()).find(t => t.name === 'Serena 蓝白')!;
	const { css, options } = renderSetup(serena, prefs());
	const html = await MarkedFormatter.markdownToHtml(MD, css, options);
	assert.match(html, /01/);
	assert.doesNotMatch(html, /一、为什么要写/);
});

test('每种章节样式都能套在 Serena 蓝白上', async () => {
	const serena = (await themes()).find(t => t.name === 'Serena 蓝白')!;
	assert.equal(HEADING_STYLES.length, 10); // 跟随排版 + 9 种
	for (const s of HEADING_STYLES) {
		const { css, options } = renderSetup(serena, prefs({ headingStyle: s.id }));
		const html = await MarkedFormatter.markdownToHtml(MD, css, options);
		if (s.id === 'theme') continue;
		assert.match(html, new RegExp(`sp-h-${s.id}`), `章节样式 ${s.id} 没生效`);
		assert.ok(headingStyleCss(s.id, '#0058a3', '#53a4ea').length > 50);
	}
	assert.equal(headingStyleDef('theme'), undefined);
	assert.equal(headingStyleDef('不存在'), undefined);
});

test('IP 头像放在章节标题前，下划线只包住标题文字', async () => {
	const serena = (await themes()).find(t => t.name === 'Serena 蓝白')!;
	const { css, options } = renderSetup(serena, prefs({ headingAvatar: true, avatarDataUrl: AVATAR }));
	const html = await MarkedFormatter.markdownToHtml(MD, css, options);
	assert.match(html, /class="[^"]*sp-has-avatar/);
	assert.match(html, /<img[^>]*sp-h-avatar/);
	assert.match(html, /class="sp-h-text"/);
});

test('头像开关关着或没上传图片时不放头像', async () => {
	const serena = (await themes()).find(t => t.name === 'Serena 蓝白')!;
	for (const p of [prefs({ headingAvatar: false, avatarDataUrl: AVATAR }), prefs({ headingAvatar: true, avatarDataUrl: '' })]) {
		const { css, options } = renderSetup(serena, p);
		assert.doesNotMatch(await MarkedFormatter.markdownToHtml(MD, css, options), /sp-h-avatar/);
	}
});

test('结束标记：文字可自定义，关掉就没有', async () => {
	const serena = (await themes()).find(t => t.name === 'Serena 蓝白')!;
	let { css, options } = renderSetup(serena, prefs({ endMark: true, endMarkText: '  木瓜 · 完  ' }));
	let html = await MarkedFormatter.markdownToHtml(MD, css, options);
	assert.match(html, /sp-end/);
	assert.match(html, />木瓜 · 完</);
	({ css, options } = renderSetup(serena, prefs({ endMark: false })));
	html = await MarkedFormatter.markdownToHtml(MD, css, options);
	assert.doesNotMatch(html, /sp-end/);
});

test('新用户默认结束标记是 END，不是 Serena', async () => {
	const { DEFAULT_SETTINGS } = await import('../src/types/index');
	assert.equal(DEFAULT_SETTINGS.endMarkText, 'END');
});
