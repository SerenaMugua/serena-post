/**
 * 公众号实时预览：放在笔记旁边，边写边看。
 * 笔记内容、排版、章节样式、IP 头像、END 标记任何一个变了，都会自动刷新。
 */
import { ItemView, MarkdownView, Notice, WorkspaceLeaf, sanitizeHTMLToDom } from 'obsidian';
import type WeChatPublisherPlugin from '../main';
import { ICON_ID } from '../brand';

export const VIEW_TYPE_LIVE_PREVIEW = 'serena-post-live-preview';

export class LivePreviewView extends ItemView {
	private md: MarkdownView | null = null;
	private timer: number | null = null;
	private running = false;
	private pending = false;
	private nameEl!: HTMLElement;
	private scrollEl!: HTMLElement;
	private contentEl2!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: WeChatPublisherPlugin) {
		super(leaf);
	}

	getViewType() { return VIEW_TYPE_LIVE_PREVIEW; }
	getDisplayText() { return '公众号预览'; }
	getIcon() { return ICON_ID; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass('sp-live');
		const head = root.createDiv({ cls: 'sp-live-head' });
		const info = head.createDiv({ cls: 'sp-live-info' });
		info.createSpan({ cls: 'sp-live-dot' });
		info.createSpan({ cls: 'sp-live-title', text: '实时预览' });
		this.nameEl = info.createSpan({ cls: 'sp-live-name' });
		const copyBtn = head.createEl('button', { text: '复制到公众号', cls: 'mod-cta' });
		copyBtn.onclick = () => void this.copy(copyBtn);

		this.scrollEl = root.createDiv({ cls: 'sp-live-scroll' });
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
		this.registerEvent(this.app.workspace.on('file-open', () => this.schedule(100)));
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.schedule(800)));

		await this.update();
	}

	async onClose() {
		if (this.timer) window.clearTimeout(this.timer);
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
			const html = await publisher.buildWechatHtml(md, false);
			if (html === null) {
				this.message('这篇笔记还是空的。');
				return;
			}
			const top = this.scrollEl.scrollTop;
			this.contentEl2.replaceChildren(sanitizeHTMLToDom(html));
			this.scrollEl.scrollTop = top;
			this.nameEl.setText(`${md.file?.basename ?? ''} · ${publisher.selectedTheme}`);
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
