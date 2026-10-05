import { App, Modal, Notice, Setting, TFile, requestUrl } from 'obsidian';
import { DraftMeta } from '../types';
import { compressImage } from '../utils/image';

export const DRAFT_LIMITS = { title: 64, author: 8, digest: 120 };

/** 封面图上传前压缩到这个大小以内（KB） */
const COVER_MAX_KB = 1024;

const IMAGE_EXT = /^(png|jpe?g|gif|webp)$/i;

function mimeFromExt(ext: string): string {
	const e = ext.toLowerCase();
	if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
	if (e === 'gif') return 'image/gif';
	if (e === 'webp') return 'image/webp';
	return 'image/png';
}

function arrayBufferToDataUrl(data: ArrayBuffer, mimeType: string): string {
	const bytes = new Uint8Array(data);
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return `data:${mimeType};base64,${btoa(binary)}`;
}

async function toCoverDataUrl(data: ArrayBuffer, mimeType: string): Promise<string> {
	// 封面统一转成 JPG/PNG 并压缩，微信封面素材不接受 webp/gif 动图
	const compressed = await compressImage(data, mimeType, COVER_MAX_KB);
	let { data: out, mimeType: outMime } = compressed;
	if (!/^image\/(jpeg|png)$/.test(outMime)) {
		out = await convertToJpeg(out, outMime);
		outMime = 'image/jpeg';
	}
	return arrayBufferToDataUrl(out, outMime);
}

async function convertToJpeg(data: ArrayBuffer, mimeType: string): Promise<ArrayBuffer> {
	const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('无法读取封面图片'));
			img.src = url;
		});
		const canvas = document.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('无法创建画布');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0);
		const blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(b => (b ? resolve(b) : reject(new Error('封面转换失败'))), 'image/jpeg', 0.9));
		return await blob.arrayBuffer();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * 把笔记里的图片引用（[[a.png]]、![[a.png|300]]、![](a.png)、a.png、https://...）解析成封面 data URL
 */
export async function resolveImageRef(app: App, ref: string, sourcePath: string): Promise<string | null> {
	let link = ref.trim();
	if (!link) return null;
	if (link.startsWith('data:image/')) return link;

	if (/^https?:\/\//i.test(link)) {
		try {
			const res = await requestUrl({ url: link, method: 'GET' });
			const type = (res.headers['content-type'] || res.headers['Content-Type'] || 'image/jpeg').split(';')[0];
			return await toCoverDataUrl(res.arrayBuffer, type);
		} catch (e) {
			console.error('[WeChatPB] 下载封面失败', e);
			return null;
		}
	}

	link = link.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0].trim();
	const md = link.match(/^!?\[[^\]]*\]\(([^)\s]+)[^)]*\)$/);
	if (md) link = md[1];
	try { link = decodeURIComponent(link); } catch { /* 保持原样 */ }

	const file = app.metadataCache.getFirstLinkpathDest(link, sourcePath)
		?? app.vault.getAbstractFileByPath(link);
	if (!(file instanceof TFile) || !IMAGE_EXT.test(file.extension)) return null;
	const data = await app.vault.readBinary(file);
	return await toCoverDataUrl(data, mimeFromExt(file.extension));
}

/** 找正文里第一张图片的引用 */
export function findFirstImageRef(markdown: string): string | null {
	const re = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) {
		const ref = (m[1] ?? m[2] ?? '').split('|')[0];
		const ext = ref.split('?')[0].split('.').pop() ?? '';
		if (IMAGE_EXT.test(ext) || /^https?:\/\//i.test(ref)) return ref;
	}
	return null;
}

function fmString(fm: Record<string, any> | undefined, keys: string[]): string {
	if (!fm) return '';
	for (const k of keys) {
		const v = fm[k];
		if (typeof v === 'string' && v.trim()) return v.trim();
		if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
	}
	return '';
}

function fmBool(fm: Record<string, any> | undefined, keys: string[]): boolean | undefined {
	if (!fm) return undefined;
	for (const k of keys) {
		const v = fm[k];
		if (typeof v === 'boolean') return v;
		if (typeof v === 'string') {
			if (/^(true|yes|on|1|开|开启|是)$/i.test(v.trim())) return true;
			if (/^(false|no|off|0|关|关闭|否)$/i.test(v.trim())) return false;
		}
	}
	return undefined;
}

/**
 * 自动识别笔记封面：笔记属性 cover > 正文第一张图片
 */
export async function detectCover(app: App, file: TFile, markdown: string, notifyMissing = false): Promise<{ base64: string; source: string } | null> {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, any> | undefined;
	const fmCover = fmString(fm, ['cover', '封面', 'banner', 'image']);
	if (fmCover) {
		const base64 = await resolveImageRef(app, fmCover, file.path);
		if (base64) return { base64, source: '笔记属性 cover' };
		if (notifyMissing) new Notice(`笔记属性里的封面「${fmCover}」没找到，已改用其他封面`);
	}
	const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
	const first = findFirstImageRef(body);
	if (first) {
		const base64 = await resolveImageRef(app, first, file.path);
		if (base64) return { base64, source: '正文第一张图片' };
	}
	return null;
}

export interface DraftDefaultsInput {
	file: TFile;
	markdown: string;
	/** 侧边栏手动上传的封面（最优先） */
	panelCoverBase64?: string;
	/** 侧边栏已自动识别好的封面，避免重复下载 */
	autoCoverBase64?: string;
	autoCoverSource?: string;
	/** 用户在侧边栏移除了自动封面，则不再自动识别 */
	skipAutoDetect?: boolean;
	defaultCoverBase64?: string;
	defaultAuthor: string;
	defaultOpenComment: boolean;
}

/**
 * 计算弹窗默认值：笔记属性 > 侧边栏/设置 > 自动推断
 * 封面优先级：侧边栏手动上传 > 属性 cover > 正文第一张图 > 设置里的默认封面
 */
export async function buildDraftDefaults(app: App, input: DraftDefaultsInput): Promise<{ meta: DraftMeta; coverSource: string }> {
	const fm = app.metadataCache.getFileCache(input.file)?.frontmatter as Record<string, any> | undefined;

	const title = fmString(fm, ['title', '标题']) || input.file.basename;
	const author = fmString(fm, ['author', '作者']) || input.defaultAuthor;
	const digest = fmString(fm, ['digest', '摘要', 'description', 'summary']);
	const contentSourceUrl = fmString(fm, ['source_url', 'sourceUrl', '原文链接']);
	const openComment = fmBool(fm, ['comment', 'open_comment', '留言']) ?? input.defaultOpenComment;

	let coverBase64 = '';
	let coverSource = '';
	if (input.panelCoverBase64) {
		coverBase64 = input.panelCoverBase64;
		coverSource = '侧边栏上传的封面';
	} else if (input.autoCoverBase64) {
		coverBase64 = input.autoCoverBase64;
		coverSource = input.autoCoverSource || '自动识别';
	} else if (!input.skipAutoDetect) {
		const detected = await detectCover(app, input.file, input.markdown, true);
		if (detected) {
			coverBase64 = detected.base64;
			coverSource = detected.source;
		}
	}
	if (!coverBase64 && input.defaultCoverBase64) {
		coverBase64 = input.defaultCoverBase64;
		coverSource = '设置里的默认封面';
	}

	return {
		meta: {
			title,
			author,
			digest,
			contentSourceUrl,
			coverBase64,
			openComment,
			onlyFansCanComment: false
		},
		coverSource
	};
}

/**
 * 发布前确认弹窗：确认标题、作者、摘要、封面、留言设置
 */
export class DraftConfirmModal extends Modal {
	private meta: DraftMeta;
	private coverSource: string;
	private accountNames: string[];
	private resolver: ((meta: DraftMeta | null) => void) | null = null;
	private submitted = false;

	constructor(app: App, meta: DraftMeta, coverSource: string, accountNames: string[]) {
		super(app);
		this.meta = { ...meta };
		this.coverSource = coverSource;
		this.accountNames = accountNames;
	}

	/** 打开弹窗，确认返回 DraftMeta，取消返回 null */
	openAndWait(): Promise<DraftMeta | null> {
		return new Promise(resolve => {
			this.resolver = resolve;
			this.open();
		});
	}

	onOpen() {
		this.modalEl.addClass('wechatpb-draft-modal');
		this.render();
	}

	onClose() {
		this.contentEl.empty();
		if (!this.submitted) this.resolver?.(null);
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: '推送到公众号草稿箱' });
		contentEl.createEl('p', {
			cls: 'wechatpb-draft-target',
			text: `将发送到：${this.accountNames.join('、')}`
		});

		const counter = (el: HTMLElement, value: string, max: number) => {
			el.setText(`${value.length} / ${max}`);
			el.toggleClass('is-over', value.length > max);
		};

		// 标题
		const titleSetting = new Setting(contentEl).setName('标题').setDesc('');
		const titleCount = titleSetting.descEl.createSpan({ cls: 'wechatpb-counter' });
		counter(titleCount, this.meta.title, DRAFT_LIMITS.title);
		titleSetting.addText(text => {
			text.setValue(this.meta.title).onChange(v => {
				this.meta.title = v;
				counter(titleCount, v, DRAFT_LIMITS.title);
			});
			text.inputEl.addClass('wechatpb-wide-input');
		});

		// 作者
		const authorSetting = new Setting(contentEl).setName('作者').setDesc('');
		const authorCount = authorSetting.descEl.createSpan({ cls: 'wechatpb-counter' });
		counter(authorCount, this.meta.author, DRAFT_LIMITS.author);
		authorSetting.addText(text => text
			.setPlaceholder('可留空')
			.setValue(this.meta.author)
			.onChange(v => {
				this.meta.author = v;
				counter(authorCount, v, DRAFT_LIMITS.author);
			}));

		// 摘要
		const digestSetting = new Setting(contentEl).setName('摘要').setDesc('留空则微信自动截取正文前 54 字。');
		const digestCount = digestSetting.descEl.createSpan({ cls: 'wechatpb-counter' });
		counter(digestCount, this.meta.digest, DRAFT_LIMITS.digest);
		digestSetting.addTextArea(area => {
			area.setValue(this.meta.digest).onChange(v => {
				this.meta.digest = v;
				counter(digestCount, v, DRAFT_LIMITS.digest);
			});
			area.inputEl.rows = 3;
			area.inputEl.addClass('wechatpb-wide-input');
		});

		// 原文链接
		new Setting(contentEl)
			.setName('原文链接')
			.setDesc('可选，文末「阅读原文」跳转地址')
			.addText(text => text
				.setPlaceholder('https://')
				.setValue(this.meta.contentSourceUrl)
				.onChange(v => { this.meta.contentSourceUrl = v.trim(); }));

		// 封面
		const coverSetting = new Setting(contentEl)
			.setName('封面（必填）')
			.setDesc(this.meta.coverBase64 ? `来源：${this.coverSource}` : '还没有封面：在笔记属性写 cover，或点击右侧选择图片');
		coverSetting.addButton(btn => btn
			.setButtonText(this.meta.coverBase64 ? '更换' : '选择图片')
			.onClick(() => this.pickCover()));
		if (this.meta.coverBase64) {
			const preview = contentEl.createDiv({ cls: 'wechatpb-cover-preview' });
			preview.createEl('img', { attr: { src: this.meta.coverBase64, alt: '封面预览' } });
		}

		// 留言
		new Setting(contentEl)
			.setName('开启留言')
			.addToggle(t => t.setValue(this.meta.openComment).onChange(v => {
				this.meta.openComment = v;
				this.render();
			}));
		if (this.meta.openComment) {
			new Setting(contentEl)
				.setName('仅粉丝可留言')
				.addToggle(t => t.setValue(this.meta.onlyFansCanComment).onChange(v => {
					this.meta.onlyFansCanComment = v;
				}));
		}

		// 按钮
		const footer = new Setting(contentEl);
		footer.addButton(btn => btn.setButtonText('取消').onClick(() => this.close()));
		footer.addButton(btn => btn
			.setButtonText('推送到草稿箱')
			.setCta()
			.onClick(() => this.submit()));
	}

	private pickCover() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'image/jpeg,image/png,image/webp';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				this.meta.coverBase64 = await toCoverDataUrl(await file.arrayBuffer(), file.type || 'image/jpeg');
				this.coverSource = `手动选择（${file.name}）`;
				this.render();
			} catch (e) {
				new Notice(`封面读取失败：${e instanceof Error ? e.message : e}`);
			}
		};
		input.click();
	}

	private submit() {
		const m = this.meta;
		m.title = m.title.trim();
		m.author = m.author.trim();
		m.digest = m.digest.trim();
		if (!m.title) { new Notice('请填写标题'); return; }
		if (m.title.length > DRAFT_LIMITS.title) { new Notice(`标题最多 ${DRAFT_LIMITS.title} 字`); return; }
		if (m.author.length > DRAFT_LIMITS.author) { new Notice(`作者最多 ${DRAFT_LIMITS.author} 字`); return; }
		if (m.digest.length > DRAFT_LIMITS.digest) { new Notice(`摘要最多 ${DRAFT_LIMITS.digest} 字`); return; }
		if (m.contentSourceUrl && !/^https?:\/\//i.test(m.contentSourceUrl)) {
			new Notice('原文链接需要以 http:// 或 https:// 开头'); return;
		}
		if (!m.coverBase64) { new Notice('微信草稿必须有封面，请先选择封面'); return; }
		if (!m.openComment) m.onlyFansCanComment = false;
		this.submitted = true;
		this.resolver?.({ ...m });
		this.close();
	}
}
