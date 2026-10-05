/**
 * X 文章预览弹窗：按 X Article 的样子渲染当前笔记，并列出 Kaitox 的样式检查结果。
 * 渲染逻辑来自 Kaitox（MIT）。Mermaid 图在这里只显示占位，推送时由 Kaitox 扩展转换。
 */
import { App, Modal, setIcon } from 'obsidian';
import { renderPreviewHtml, extractMermaidBlocks, MERMAID_SRC_PREFIX } from '../../vendor/kaitox/x-article/index';
import type { StyleReport } from '../../vendor/kaitox/relay-protocol/index';
import { bytesToBlobUrl, type Resolved } from './resolve';

export function renderStyleReport(container: HTMLElement, report: StyleReport | undefined, unresolved: string[]) {
	const issues = report?.issues ?? [];
	const c = report?.counts ?? { error: 0, warning: 0, info: 0 };
	const box = container.createDiv({ cls: 'wechatpb-x-report' });
	if (issues.length === 0 && unresolved.length === 0) {
		box.createDiv({ cls: 'wechatpb-x-ok', text: '✓ X 格式检查通过' });
		return;
	}
	const chips = box.createDiv({ cls: 'wechatpb-x-chips' });
	if (c.error) chips.createSpan({ cls: 'wechatpb-chip is-error', text: `${c.error} 处错误` });
	if (c.warning) chips.createSpan({ cls: 'wechatpb-chip is-warn', text: `${c.warning} 处提示` });
	if (c.info) chips.createSpan({ cls: 'wechatpb-chip is-info', text: `${c.info} 条信息` });
	if (unresolved.length) chips.createSpan({ cls: 'wechatpb-chip is-error', text: `${unresolved.length} 个引用找不到` });

	const details = box.createEl('details');
	details.createEl('summary', { text: '查看详情' });
	const list = details.createDiv({ cls: 'wechatpb-x-issues' });
	for (const issue of issues) {
		const row = list.createDiv({ cls: `wechatpb-x-issue is-${issue.severity}` });
		const ic = row.createSpan({ cls: 'wechatpb-x-issue-ic' });
		setIcon(ic, issue.severity === 'error' ? 'x-circle' : issue.severity === 'warning' ? 'alert-triangle' : 'info');
		const txt = row.createDiv();
		txt.createDiv({ text: issue.message });
		const meta: string[] = [];
		if (issue.suggestion) meta.push(issue.suggestion);
		if (issue.line) meta.push(`第 ${issue.line} 行`);
		if (meta.length) txt.createDiv({ cls: 'wechatpb-x-issue-meta', text: meta.join(' · ') });
	}
	if (unresolved.length) {
		const row = list.createDiv({ cls: 'wechatpb-x-issue is-error' });
		row.createDiv({ text: `找不到、将被跳过：${unresolved.join('、')}` });
	}
}

export class XPreviewModal extends Modal {
	private urls: string[] = [];

	constructor(
		app: App,
		private resolved: Resolved,
		private report: StyleReport,
		private title: string,
		private coverDataUrl?: string
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('wechatpb-x-preview-modal');
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'X 文章预览' });
		renderStyleReport(contentEl, this.report, this.resolved.unresolved);

		const bySrc: Record<string, string> = {};
		for (const a of this.resolved.assets) {
			const u = bytesToBlobUrl(a.bytes, a.mime);
			this.urls.push(u);
			bySrc[a.src] = u;
		}
		let coverUrl: string | undefined = this.coverDataUrl;
		if (!coverUrl && this.resolved.cover) {
			coverUrl = bytesToBlobUrl(this.resolved.cover.bytes, this.resolved.cover.mime);
			this.urls.push(coverUrl);
		}

		const { markdown } = extractMermaidBlocks(this.resolved.body);
		const html = renderPreviewHtml(markdown, {
			title: this.title,
			coverUrl,
			resolveImage: src => (src.startsWith(MERMAID_SRC_PREFIX) ? null : bySrc[src] ?? null)
		});
		const frame = contentEl.createDiv({ cls: 'wechatpb-x-preview-frame' });
		// renderPreviewHtml 的文本与属性已全部转义；用 DOMParser 解析以保留 blob: 图片地址（同 Kaitox 做法）
		const doc = new DOMParser().parseFromString(html, 'text/html');
		for (const node of Array.from(doc.body.childNodes)) frame.appendChild(document.importNode(node, true));
	}

	onClose() {
		for (const u of this.urls) URL.revokeObjectURL(u);
		this.urls = [];
		this.contentEl.empty();
	}
}
