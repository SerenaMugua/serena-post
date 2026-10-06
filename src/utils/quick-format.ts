/**
 * 快捷格式：选中文字点一下就变成章节标题、表格等，不用记 Markdown 语法。
 * 编辑器右键菜单、实时预览顶部工具栏、命令面板（可绑快捷键）共用这一套。
 */
import { Notice, normalizePath, type App, type Editor, type TFile } from 'obsidian';

export interface FormatContext {
	app: App;
	file: TFile | null;
}

export interface QuickFormat {
	id: string;
	label: string;
	icon: string;
	/** 工具栏上显示的简短文字 */
	short: string;
	run: (editor: Editor, ctx: FormatContext) => void | Promise<void>;
}

const HEADING_RE = /^#{1,6}\s+/;
const QUOTE_RE = /^>\s?/;
const BULLET_RE = /^[-*+]\s+/;
const ORDERED_RE = /^\d+[.)]\s+/;

/** 去掉行首已有的块级标记（标题、引用、列表），换成新的 */
function stripBlock(line: string): string {
	return line.replace(HEADING_RE, '').replace(QUOTE_RE, '').replace(BULLET_RE, '').replace(ORDERED_RE, '');
}

function selectedLines(editor: Editor): { from: number; to: number; lines: string[] } {
	const a = editor.getCursor('from');
	const b = editor.getCursor('to');
	let to = b.line;
	// 选区停在下一行行首时不算那一行
	if (b.ch === 0 && to > a.line) to--;
	const lines: string[] = [];
	for (let i = a.line; i <= to; i++) lines.push(editor.getLine(i));
	return { from: a.line, to, lines };
}

function replaceLines(editor: Editor, from: number, to: number, lines: string[]) {
	editor.replaceRange(lines.join('\n'), { line: from, ch: 0 }, { line: to, ch: editor.getLine(to).length });
	editor.setSelection({ line: from, ch: 0 }, { line: from + lines.length - 1, ch: lines[lines.length - 1].length });
	editor.focus();
}

/** 每行加同一个前缀；如果已经全是这种格式，再点一次就取消 */
function toggleLinePrefix(editor: Editor, prefix: string | ((i: number) => string), test: RegExp) {
	const { from, to, lines } = selectedLines(editor);
	const nonEmpty = lines.filter(l => l.trim());
	const all = nonEmpty.length > 0 && nonEmpty.every(l => test.test(l));
	let n = 0;
	const out = lines.map(l => {
		if (!l.trim()) return l;
		const body = stripBlock(l);
		if (all) return body;
		const p = typeof prefix === 'string' ? prefix : prefix(n++);
		return p + body;
	});
	replaceLines(editor, from, to, out);
}

function heading(level: 2 | 3) {
	const mark = '#'.repeat(level) + ' ';
	return (editor: Editor) => toggleLinePrefix(editor, mark, new RegExp(`^#{${level}}\\s+`));
}

function wrapInline(editor: Editor, mark: string) {
	const sel = editor.getSelection();
	if (!sel) {
		const cur = editor.getCursor();
		editor.replaceRange(mark + mark, cur);
		editor.setCursor({ line: cur.line, ch: cur.ch + mark.length });
		editor.focus();
		return;
	}
	const unwrapped = sel.startsWith(mark) && sel.endsWith(mark) && sel.length > mark.length * 2
		? sel.slice(mark.length, -mark.length)
		: null;
	editor.replaceSelection(unwrapped ?? mark + sel + mark);
	editor.focus();
}

/** 选中的几行（Excel / 飞书表格复制来的、或用逗号、竖线、两个以上空格分开）→ Markdown 表格；没选中就插入空表格 */
function table(editor: Editor) {
	const sel = editor.getSelection();
	const rows = sel.split('\n').map(l => l.trim()).filter(Boolean);
	const splitRow = (l: string): string[] => {
		if (l.includes('\t')) return l.split('\t');
		if (/^\|.*\|$/.test(l)) return l.slice(1, -1).split('|');
		if (l.includes('|') || l.includes('｜')) return l.split(/[|｜]/);
		if (/[,，]/.test(l)) return l.split(/[,，]/);
		return l.split(/\s{2,}/);
	};
	let cells = rows.map(r => splitRow(r).map(c => c.trim()));
	const cols = Math.max(0, ...cells.map(r => r.length));
	let md: string;
	if (rows.length >= 1 && cols >= 2) {
		cells = cells.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c) || c === ''));
		cells = cells.map(r => [...r, ...Array(cols - r.length).fill('')]);
		const line = (r: string[]) => `| ${r.map(c => c.replace(/\|/g, '\\|')).join(' | ')} |`;
		md = [line(cells[0]), line(Array(cols).fill('---')), ...cells.slice(1).map(line)].join('\n');
	} else {
		md = '| 标题 | 说明 |\n| --- | --- |\n| 内容 | 内容 |\n| 内容 | 内容 |';
	}
	insertBlock(editor, md, sel.length > 0);
}

/** 以独立段落插入（前后自动空行），replace=true 时替换选区 */
function insertBlock(editor: Editor, block: string, replace: boolean) {
	const from = editor.getCursor('from');
	const to = replace ? editor.getCursor('to') : from;
	const before = from.ch > 0 ? editor.getLine(from.line).slice(0, from.ch) : (from.line > 0 ? editor.getLine(from.line - 1) : '');
	const afterLine = editor.getLine(to.line).slice(to.ch);
	const lead = from.ch > 0 ? '\n\n' : (before.trim() ? '\n' : '');
	const tail = afterLine.trim() ? '\n\n' : '\n';
	editor.replaceRange(lead + block + tail, from, to);
	const startLine = from.line + (lead.match(/\n/g)?.length ?? 0);
	editor.setCursor({ line: startLine, ch: 0 });
	editor.focus();
}

function codeBlock(editor: Editor) {
	const sel = editor.getSelection();
	insertBlock(editor, '```\n' + (sel || '在这里粘贴代码') + '\n```', sel.length > 0);
}

function divider(editor: Editor) {
	insertBlock(editor, '---', false);
}

function clearFormat(editor: Editor) {
	const { from, to, lines } = selectedLines(editor);
	replaceLines(editor, from, to, lines.map(l => stripBlock(l).replace(/\*\*(.+?)\*\*/g, '$1').replace(/==(.+?)==/g, '$1')));
}

/** 从电脑选一张图，复制进库的附件文件夹，插入 ![[图片]] */
function insertImage(editor: Editor, ctx: FormatContext) {
	const input = document.createElement('input');
	input.type = 'file';
	input.accept = 'image/png,image/jpeg,image/gif,image/webp';
	input.onchange = async () => {
		const f = input.files?.[0];
		if (!f) return;
		try {
			const safe = f.name.replace(/[\\/:*?"<>|#^[\]]/g, '-');
			const path = await ctx.app.fileManager.getAvailablePathForAttachment(safe, ctx.file?.path);
			const created = await ctx.app.vault.createBinary(normalizePath(path), await f.arrayBuffer());
			const link = ctx.app.fileManager.generateMarkdownLink(created, ctx.file?.path ?? '');
			insertBlock(editor, link.startsWith('!') ? link : '!' + link, false);
			new Notice(`已插入图片：${created.name}`);
		} catch (e) {
			new Notice(`插入图片失败：${e instanceof Error ? e.message : e}`);
		}
	};
	input.click();
}

/** 链接：选中的是网址就变成 [链接](网址)；选中的是文字就变成 [文字](https://)，并选中网址方便粘贴 */
function link(editor: Editor) {
	const sel = editor.getSelection().trim();
	const from = editor.getCursor('from');
	if (/^https?:\/\/\S+$/i.test(sel)) {
		editor.replaceSelection(`[链接](${sel})`);
		editor.setSelection({ line: from.line, ch: from.ch + 1 }, { line: from.line, ch: from.ch + 3 });
	} else {
		const text = sel || '链接文字';
		editor.replaceSelection(`[${text}](https://)`);
		const start = from.ch + text.length + 3;
		editor.setSelection({ line: from.line, ch: start }, { line: from.line, ch: start + 8 });
	}
	editor.focus();
}

const CN_HEADING_RE = /^\s*(?:[一二三四五六七八九十]{1,3}\s*[、.．]|第\s*[一二三四五六七八九十\d]{1,3}\s*[章节部分篇讲步][、.．:：\s]?)/;
const CN_SUBHEADING_RE = /^\s*[（(]\s*[一二三四五六七八九十\d]{1,3}\s*[)）]/;

/**
 * 一键整理全文：
 * - 单独一行、以「一、」「第一章」开头的短句 → 章节标题（##）；「（一）」开头 → 小标题（###）
 * - 连续多个空行合成一个；去掉行尾空格；标题前后补空行
 * 代码块和笔记属性不动；整篇只算一步，Ctrl+Z 可以撤销
 */
export function tidyMarkdown(text: string): { text: string; headings: number; blanks: number } {
	const lines = text.split('\n');
	const out: string[] = [];
	let i = 0;
	let headings = 0;
	let blanks = 0;
	if (lines[0]?.trim() === '---') {
		const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
		if (end > 0) {
			out.push(...lines.slice(0, end + 1));
			i = end + 1;
		}
	}
	let inCode = false;
	const isHeadingCandidate = (l: string) => {
		const t = l.trim();
		return t.length > 0 && t.length <= 40 && !/[。；;，,：:]$/.test(t) && !/^[#>|\-*+]/.test(t);
	};
	for (; i < lines.length; i++) {
		let line = lines[i];
		if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
		if (inCode || /^\s*(```|~~~)/.test(line)) { out.push(line); continue; }
		line = line.replace(/[ \t]+$/, '');
		if (isHeadingCandidate(line)) {
			if (CN_HEADING_RE.test(line)) { line = '## ' + line.trim(); headings++; }
			else if (CN_SUBHEADING_RE.test(line)) { line = '### ' + line.trim(); headings++; }
		}
		const isHeading = /^#{1,6}\s/.test(line);
		if (isHeading && out.length && out[out.length - 1].trim() !== '' && out[out.length - 1].trim() !== '---') out.push('');
		if (line.trim() === '') {
			if (out.length && out[out.length - 1].trim() === '') { blanks++; continue; }
			out.push('');
			continue;
		}
		const prev = out[out.length - 1];
		if (prev !== undefined && /^#{1,6}\s/.test(prev) && !isHeading) out.push('');
		out.push(line);
	}
	while (out.length > 1 && out[out.length - 1] === '' && out[out.length - 2] === '') { out.pop(); blanks++; }
	return { text: out.join('\n'), headings, blanks };
}

function tidyAll(editor: Editor) {
	const before = editor.getValue();
	const r = tidyMarkdown(before);
	if (r.text === before) { new Notice('全文已经很整齐了，不需要整理'); return; }
	const last = editor.lastLine();
	editor.replaceRange(r.text, { line: 0, ch: 0 }, { line: last, ch: editor.getLine(last).length });
	editor.focus();
	const parts: string[] = [];
	if (r.headings) parts.push(`设了 ${r.headings} 个标题`);
	if (r.blanks) parts.push(`去掉 ${r.blanks} 处多余空行`);
	new Notice(`整理完成${parts.length ? '：' + parts.join('，') : ''}。不满意可以按 Ctrl+Z 撤销`);
}

export const QUICK_FORMATS: QuickFormat[] = [
	{ id: 'h2', label: '设为章节标题', short: '章节标题', icon: 'heading-2', run: heading(2) },
	{ id: 'h3', label: '设为小标题', short: '小标题', icon: 'heading-3', run: heading(3) },
	{ id: 'bold', label: '加粗', short: '加粗', icon: 'bold', run: e => wrapInline(e, '**') },
	{ id: 'mark', label: '高亮', short: '高亮', icon: 'highlighter', run: e => wrapInline(e, '==') },
	{ id: 'link', label: '插入链接', short: '链接', icon: 'link', run: link },
	{ id: 'image', label: '插入图片（从电脑选）', short: '图片', icon: 'image-plus', run: insertImage },
	{ id: 'quote', label: '设为引用', short: '引用', icon: 'quote', run: e => toggleLinePrefix(e, '> ', QUOTE_RE) },
	{ id: 'ul', label: '设为列表', short: '列表', icon: 'list', run: e => toggleLinePrefix(e, '- ', BULLET_RE) },
	{ id: 'ol', label: '设为编号列表', short: '编号', icon: 'list-ordered', run: e => toggleLinePrefix(e, i => `${i + 1}. `, ORDERED_RE) },
	{ id: 'table', label: '转成表格 / 插入表格', short: '表格', icon: 'table', run: table },
	{ id: 'code', label: '设为代码块', short: '代码块', icon: 'code-2', run: codeBlock },
	{ id: 'hr', label: '插入分割线', short: '分割线', icon: 'minus', run: divider },
	{ id: 'clear', label: '清除格式（变回正文）', short: '清除', icon: 'eraser', run: clearFormat },
	{ id: 'tidy', label: '一键整理全文（自动设标题、去多余空行）', short: '整理全文', icon: 'wand-2', run: tidyAll }
];
