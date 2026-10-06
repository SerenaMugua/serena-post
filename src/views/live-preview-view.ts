/**
 * 实时预览：放在笔记旁边，边写边看。公众号 / X 两个标签切换，呈现方式统一。
 * 笔记内容、排版、章节样式、IP 头像、END 标记任何一个变了，都会自动刷新。
 * 顶部还有一排快捷格式按钮，选中文字点一下就能变成章节标题、表格等。
 */
import { ItemView, MarkdownView, Notice, TFile, WorkspaceLeaf, sanitizeHTMLToDom, setIcon } from 'obsidian';
import type WeChatPublisherPlugin from '../main';
import { ICON_ID } from '../brand';
import { QUICK_FORMATS } from '../utils/quick-format';
import { renderXPreviewInto } from '../x/x-preview-modal';
import { marked } from 'marked';

export const VIEW_TYPE_LIVE_PREVIEW = 'serena-post-live-preview';
export type PreviewMode = 'wechat' | 'x';

export class LivePreviewView extends ItemView {
	private md: MarkdownView | null = null;
	private mode: PreviewMode = 'wechat';
	private blobUrls: string[] = [];
	private tabs: Partial<Record<PreviewMode, HTMLElement>> = {};
	private copyBtn!: HTMLButtonElement;
	private timer: number | null = null;
	private running = false;
	private pending = false;
	private nameEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private contentEl2!: HTMLElement;
	/** 预览里每个段落对应的笔记行号（按顺序） */
	private blocks: { line: number; el: HTMLElement }[] = [];
	/** 正在监听滚动的编辑器 */
	private boundScroller: HTMLElement | null = null;
	private onEditorScroll = () => this.syncFromEditor();
	private syncRaf = 0;
	private lastSyncLine = -1;
	private lastPath = '';
	/** 从预览点回原文后，短时间内不让编辑器滚动反过来带动预览 */
	private suppressSyncUntil = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: WeChatPublisherPlugin) {
		super(leaf);
	}

	getViewType() { return VIEW_TYPE_LIVE_PREVIEW; }
	getDisplayText() { return 'SerenaPost 预览'; }
	getIcon() { return ICON_ID; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass('sp-live');
		const head = root.createDiv({ cls: 'sp-live-head' });
		const tabs = head.createDiv({ cls: 'sp-live-tabs' });
		for (const [mode, text] of [['wechat', '公众号'], ['x', 'X 文章']] as const) {
			const tab = tabs.createEl('button', { cls: 'sp-live-tab', text });
			tab.onclick = () => this.setMode(mode);
			this.tabs[mode] = tab;
		}
		this.copyBtn = head.createEl('button', { text: '复制到公众号', cls: 'mod-cta sp-live-copy' });
		this.copyBtn.onclick = () => void this.copy(this.copyBtn);

		const info = root.createDiv({ cls: 'sp-live-info' });
		info.createSpan({ cls: 'sp-live-dot' });
		info.createSpan({ cls: 'sp-live-title', text: '实时预览' });
		this.nameEl = info.createSpan({ cls: 'sp-live-name' });
		const sync = info.createEl('label', { cls: 'sp-live-sync', attr: { 'aria-label': '编辑器滚动时，预览跟着滚；点预览里的段落，笔记跳到那里' } });
		const syncCb = sync.createEl('input', { type: 'checkbox' });
		syncCb.checked = this.plugin.settings.previewSyncScroll;
		sync.createSpan({ text: '同步滚动' });
		syncCb.onchange = async () => {
			this.plugin.settings.previewSyncScroll = syncCb.checked;
			await this.plugin.saveSettings();
			if (syncCb.checked) { this.lastSyncLine = -1; this.syncFromEditor(); }
		};

		// 快捷格式：选中文字点一下
		const bar = root.createDiv({ cls: 'sp-format-bar' });
		for (const f of QUICK_FORMATS) {
			const btn = bar.createEl('button', { cls: 'sp-format-btn', attr: { 'aria-label': f.label } });
			const ic = btn.createSpan({ cls: 'sp-format-ic' });
			setIcon(ic, f.icon);
			btn.createSpan({ text: f.short });
			// mousedown 时阻止抢焦点，编辑器里的选区就不会丢
			btn.onmousedown = e => e.preventDefault();
			btn.onclick = () => {
				const md = this.currentMd();
				if (!md) { new Notice('先在笔记里选中要设置的文字'); return; }
				void f.run(md.editor, { app: this.app, file: md.file });
				this.schedule(200);
			};
		}

		this.scrollEl = root.createDiv({ cls: 'sp-live-scroll' });
		this.scrollEl.addEventListener('click', e => this.jumpToSource(e));
		const phone = this.scrollEl.createDiv({ cls: 'sp-live-phone' });
		this.contentEl2 = phone.createDiv({ cls: 'sp-live-content' });

		this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => {
			if (info instanceof MarkdownView) this.md = info;
			this.schedule(500);
		}));
		this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
			if (leaf?.view instanceof MarkdownView && leaf.view !== this.md) {
				this.md = leaf.view;
				this.scrollEl.scrollTop = 0;
				this.schedule(50);
			}
		}));
		// 切换笔记时编辑器内容可能还没换好，过一会儿再刷新一次，避免显示上一篇
		this.registerEvent(this.app.workspace.on('file-open', () => {
			this.schedule(150);
			window.setTimeout(() => this.schedule(10), 700);
		}));
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.schedule(800)));
		this.registerEvent(this.app.vault.on('modify', f => {
			if (this.mode === 'x' && f === this.md?.file) this.schedule(600);
		}));

		this.applyModeUi();
		await this.update();
	}

	async onClose() {
		if (this.timer) window.clearTimeout(this.timer);
		this.releaseBlobs();
		this.boundScroller?.removeEventListener('scroll', this.onEditorScroll);
		this.boundScroller = null;
	}

	/** 给预览里的每个段落标上它在笔记里的行号 */
	private annotateLines(md: MarkdownView) {
		this.blocks = [];
		const root = this.contentEl2.querySelector('section.note-to-mp') ?? this.contentEl2;
		let text = md.getViewData();
		let offset = 0;
		if (this.plugin.settings.excludeFrontmatter) {
			const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
			if (fm) {
				offset = fm[0].split('\n').length - 1;
				text = text.slice(fm[0].length);
			}
		}
		let tokens: { type: string; raw: string }[] = [];
		try {
			tokens = marked.lexer(text) as unknown as { type: string; raw: string }[];
		} catch {
			return;
		}
		const lines: number[] = [];
		let pos = 0;
		let line = offset;
		for (const t of tokens) {
			if (t.type !== 'space' && t.type !== 'def') {
				// 段落开头的空行不算
				const lead = t.raw.match(/^\n*/)?.[0].length ?? 0;
				lines.push(line + lead);
			}
			line += (t.raw.match(/\n/g)?.length ?? 0);
			pos += t.raw.length;
		}
		const els = Array.from(root.children).filter(el => !el.classList.contains('sp-end')) as HTMLElement[];
		const n = Math.min(els.length, lines.length);
		for (let i = 0; i < n; i++) {
			els[i].dataset.spLine = String(lines[i]);
			els[i].addClass('sp-src-block');
			this.blocks.push({ line: lines[i], el: els[i] });
		}
	}

	/** 点预览里的段落 → 笔记跳到对应位置 */
	private jumpToSource(e: MouseEvent) {
		if (this.mode !== 'wechat') return;
		const target = e.target as HTMLElement;
		if (target.closest('a')) e.preventDefault();
		const block = target.closest('[data-sp-line]') as HTMLElement | null;
		const md = this.currentMd();
		if (!block || !md) return;
		const line = Number(block.dataset.spLine);
		if (!Number.isFinite(line)) return;
		const editor = md.editor;
		this.suppressSyncUntil = Date.now() + 1200;
		const len = editor.getLine(line)?.length ?? 0;
		editor.setSelection({ line, ch: 0 }, { line, ch: len });
		editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		this.app.workspace.setActiveLeaf(md.leaf, { focus: true });
		block.addClass('sp-src-flash');
		window.setTimeout(() => block.removeClass('sp-src-flash'), 900);
	}

	/** 监听笔记编辑器的滚动 */
	private bindEditorScroll(md: MarkdownView) {
		const cm = (md.editor as unknown as { cm?: { scrollDOM?: HTMLElement } }).cm;
		const scroller = cm?.scrollDOM ?? null;
		if (scroller === this.boundScroller) return;
		this.boundScroller?.removeEventListener('scroll', this.onEditorScroll);
		this.boundScroller = scroller;
		scroller?.addEventListener('scroll', this.onEditorScroll, { passive: true });
	}

	/** 编辑器滚到哪，预览就跟到哪 */
	private syncFromEditor() {
		if (this.mode !== 'wechat' || !this.plugin.settings.previewSyncScroll || this.blocks.length === 0) return;
		if (Date.now() < this.suppressSyncUntil) return;
		if (this.syncRaf) return;
		this.syncRaf = window.requestAnimationFrame(() => {
			this.syncRaf = 0;
			const md = this.currentMd();
			const cm = (md?.editor as unknown as { cm?: any })?.cm;
			if (!cm?.scrollDOM) return;
			let top: number;
			try {
				// 视口顶部相对文档开头的高度（扣掉标题、笔记属性等上方的内容）
				const h = cm.scrollDOM.getBoundingClientRect().top - cm.documentTop;
				const block = cm.lineBlockAtHeight(Math.max(0, h));
				top = cm.state.doc.lineAt(block.from).number - 1;
			} catch {
				return;
			}
			if (top === this.lastSyncLine) return;
			this.lastSyncLine = top;
			// 找到 top 所在的预览段落，按段内位置插值
			let i = 0;
			while (i + 1 < this.blocks.length && this.blocks[i + 1].line <= top) i++;
			const cur = this.blocks[i];
			const next = this.blocks[i + 1];
			const base = this.scrollEl.getBoundingClientRect().top - this.scrollEl.scrollTop;
			const curTop = cur.el.getBoundingClientRect().top - base;
			let y = curTop;
			if (next && next.line > cur.line && top >= cur.line) {
				const nextTop = next.el.getBoundingClientRect().top - base;
				y = curTop + (nextTop - curTop) * Math.min(1, (top - cur.line) / (next.line - cur.line));
			}
			if (top < (this.blocks[0]?.line ?? 0)) y = 0;
			this.scrollEl.scrollTop = Math.max(0, y - 12);
		});
	}

	setMode(mode: PreviewMode) {
		if (this.mode !== mode) this.scrollEl.scrollTop = 0;
		this.mode = mode;
		this.applyModeUi();
		this.schedule(10);
	}

	private applyModeUi() {
		for (const [m, el] of Object.entries(this.tabs)) el?.toggleClass('is-active', m === this.mode);
		this.copyBtn.toggle(this.mode === 'wechat');
		this.contentEl.toggleClass('is-x', this.mode === 'x');
	}

	private releaseBlobs() {
		for (const u of this.blobUrls) URL.revokeObjectURL(u);
		this.blobUrls = [];
	}

	/** 设置或内容变了：稍等一下再刷新，连续输入时不会卡 */
	schedule(ms = 300) {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.update();
		}, ms);
	}

	private currentMd(): MarkdownView | null {
		if (this.md && this.md.file && this.md.leaf.view === this.md) return this.md;
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return (this.md = active);
		const leaf = this.app.workspace.getLeavesOfType('markdown')[0];
		this.md = (leaf?.view as MarkdownView | undefined) ?? null;
		return this.md;
	}

	private message(text: string) {
		this.nameEl.setText('');
		this.contentEl2.empty();
		this.contentEl2.createDiv({ cls: 'sp-live-empty', text });
	}

	async update() {
		if (this.running) { this.pending = true; return; }
		this.running = true;
		try {
			const publisher = this.plugin.getPublisherView();
			if (!publisher) {
				this.message('先点左侧的 SerenaPost 头像图标打开发布面板，这里就会显示预览。');
				return;
			}
			const md = this.currentMd();
			if (!md) {
				this.message('打开一篇笔记，这里会实时显示它在公众号里的样子。');
				return;
			}
			const path = md.file?.path ?? '';
			if (path !== this.lastPath) {
				this.lastPath = path;
				this.scrollEl.scrollTop = 0;
				this.lastSyncLine = -1;
			}
			const top = this.scrollEl.scrollTop;
			if (this.mode === 'x') {
				const file = md.file;
				if (!(file instanceof TFile)) { this.message('打开一篇笔记即可预览。'); return; }
				const { prepared, cover } = await publisher.buildXPreview(file);
				const old = this.blobUrls;
				this.contentEl2.empty();
				this.blobUrls = renderXPreviewInto(this.contentEl2, prepared.resolved, prepared.report, prepared.resolved.title, cover);
				for (const u of old) URL.revokeObjectURL(u);
				this.nameEl.setText(`${file.basename} · X 文章`);
			} else {
				const html = await publisher.buildWechatHtml(md, false);
				if (html === null) {
					this.message('这篇笔记还是空的。');
					return;
				}
				this.releaseBlobs();
				this.contentEl2.replaceChildren(sanitizeHTMLToDom(html));
				this.nameEl.setText(`${md.file?.basename ?? ''} · ${publisher.selectedTheme}`);
				this.annotateLines(md);
			}
			this.scrollEl.scrollTop = top;
			this.bindEditorScroll(md);
		} catch (e) {
			console.error('[SerenaPost] 实时预览失败', e);
			this.message(`预览失败：${e instanceof Error ? e.message : e}`);
		} finally {
			this.running = false;
			if (this.pending) {
				this.pending = false;
				this.schedule(100);
			}
		}
	}

	/** 复制带格式的正文（图片转成内嵌），可以直接粘贴进公众号编辑器 */
	private async copy(btn: HTMLButtonElement) {
		const publisher = this.plugin.getPublisherView();
		const md = this.currentMd();
		if (!publisher || !md) {
			new Notice('请先打开 SerenaPost 发布面板和一篇笔记');
			return;
		}
		btn.disabled = true;
		try {
			const html = await publisher.buildWechatHtml(md, true);
			if (!html) return;
			const tmp = document.body.createDiv({ cls: 'wechat-multi-publisher-copy-buffer' });
			tmp.replaceChildren(sanitizeHTMLToDom(html));
			try {
				await navigator.clipboard.write([new ClipboardItem({
					'text/html': new Blob([tmp.innerHTML], { type: 'text/html' }),
					'text/plain': new Blob([tmp.innerText], { type: 'text/plain' })
				})]);
			} finally {
				tmp.remove();
			}
			btn.setText('已复制');
		} catch (e) {
			btn.setText('复制失败');
			console.error('[SerenaPost] 复制失败', e);
		} finally {
			btn.disabled = false;
			window.setTimeout(() => btn.setText('复制到公众号'), 2000);
		}
	}
}
