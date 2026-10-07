// 整理全文（快捷格式里的「整理全文」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyMarkdown } from '../src/utils/quick-format';

test('「一、」开头的短句变成章节标题，「（一）」变成小标题', () => {
	const r = tidyMarkdown('开头一段。\n一、为什么要写\n正文\n（一）第一个原因\n正文');
	assert.match(r.text, /^## 一、为什么要写$/m);
	assert.match(r.text, /^### （一）第一个原因$/m);
	assert.equal(r.headings, 2);
});

test('「第X部分」也算章节标题', () => {
	assert.match(tidyMarkdown('第二部分 实操\n内容').text, /^## 第二部分 实操$/m);
});

test('以句号、冒号结尾的长句不当标题', () => {
	const r = tidyMarkdown('一、这是一句完整的话。\n二、下面是清单：');
	assert.equal(r.headings, 0);
});

test('多余空行合并成一个，行尾空格去掉', () => {
	const r = tidyMarkdown('第一段   \n\n\n\n第二段\n\n\n');
	assert.equal(r.text, '第一段\n\n第二段\n');
	assert.ok(r.blanks >= 2);
});

test('代码块和笔记属性原样保留', () => {
	const src = '---\ntitle: 一、不是标题\n---\n```\n一、代码里的\n\n\n\n```\n';
	const r = tidyMarkdown(src);
	assert.match(r.text, /title: 一、不是标题/);
	assert.match(r.text, /```\n一、代码里的\n\n\n\n```/);
	assert.equal(r.headings, 0);
});

test('已经整齐的文章不改动', () => {
	const src = '## 一、标题\n\n正文\n';
	assert.equal(tidyMarkdown(src).text, src);
});
