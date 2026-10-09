/**
 * X 草稿报警：推送后 Kaitox 扩展回报「没建成 / 失败 / 一直没回报」时弹出，
 * 说清楚可能的原因和下一步。
 */
import { App, Modal, setIcon } from 'obsidian';
import type { XWatchResult } from '../x/xpush';

export interface XAlertInfo {
	title: string;
	result: Exclude<XWatchResult, { kind: 'ok' } | { kind: 'lost' }>;
	gifs: string[];
	videos: string[];
	actions: { label: string; primary?: boolean; run: () => void | Promise<void> }[];
}

/** 把回报翻译成一句话（也用在侧栏的失败信息里） */
export function xAlertMessage(r: XAlertInfo['result']): string {
	if (r.kind === 'failed') return `X 草稿没有建成${r.error ? `：${r.error}` : ''}`;
	if (r.kind === 'no-id') return 'X 草稿没有建成：Kaitox 扩展提交了草稿，但 X 没有返回草稿编号（X 拒绝了这篇草稿）';
	return 'X 一直没有确认草稿：3 分钟内没收到 Kaitox 扩展的回报';
}

/** 可能的原因，按可能性排 */
export function xAlertReasons(info: Pick<XAlertInfo, 'result' | 'gifs' | 'videos'>): string[] {
	const out: string[] = [];
	if (info.result.kind === 'timeout') {
		out.push('Chrome 没开、Kaitox 扩展被关掉了，或者 Chrome 里没登录 X');
		out.push('推送后打开的 X 文章编辑器页面被关掉了（扩展要在那个页面里建草稿）');
		out.push('X 那边比较慢，可以过一会儿到 X 草稿箱里看看');
		return out;
	}
	const media: string[] = [];
	if (info.gifs.length) media.push(`${info.gifs.length} 张动图（${info.gifs.slice(0, 2).join('、')}${info.gifs.length > 2 ? ' 等' : ''}）`);
	if (info.videos.length) media.push(`${info.videos.length} 个视频（${info.videos.slice(0, 2).join('、')}${info.videos.length > 2 ? ' 等' : ''}）`);
	if (media.length) {
		out.push(`这篇有 ${media.join(' 和 ')}。X 文章不接受直接上传动图和视频：SerenaPost 已经把动图转成静态图、视频换成了提示文字，如果还是失败，先把它们从笔记里删掉再推一次试试`);
	}
	out.push('X 偶尔会临时拒绝，过一两分钟点「重新推送」');
	out.push('Chrome 里的 Kaitox 扩展不是最新版：到 Chrome 扩展管理页更新一下');
	return out;
}

export class XAlertModal extends Modal {
	constructor(app: App, private info: XAlertInfo) {
		super(app);
	}

	onOpen() {
		const { contentEl, info } = this;
		this.modalEl.addClass('sp-x-alert');
		const head = contentEl.createDiv({ cls: 'sp-x-alert-head' });
		const ic = head.createSpan({ cls: `sp-x-alert-ic is-${info.result.kind === 'timeout' ? 'warn' : 'error'}` });
		setIcon(ic, info.result.kind === 'timeout' ? 'clock' : 'alert-triangle');
		head.createEl('h3', { text: info.result.kind === 'timeout' ? 'X 还没确认草稿' : 'X 草稿没有建成' });
		contentEl.createDiv({ cls: 'sp-x-alert-article', text: `《${info.title}》` });
		contentEl.createDiv({ cls: 'sp-x-alert-msg', text: xAlertMessage(info.result) });

		contentEl.createDiv({ cls: 'sp-x-alert-sub', text: '可能的原因' });
		const ul = contentEl.createEl('ol', { cls: 'sp-x-alert-reasons' });
		for (const r of xAlertReasons(info)) ul.createEl('li', { text: r });

		const actions = contentEl.createDiv({ cls: 'sp-x-alert-actions' });
		for (const a of info.actions) {
			const b = actions.createEl('button', { text: a.label, cls: a.primary ? 'mod-cta' : '' });
			b.onclick = async () => {
				b.disabled = true;
				try { await a.run(); } finally { b.disabled = false; }
				this.close();
			};
		}
		const ok = actions.createEl('button', { text: '知道了' });
		ok.onclick = () => this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
