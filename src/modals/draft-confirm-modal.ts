import { App, Modal, Notice, Setting, TFile, requestUrl, setIcon } from 'obsidian';
import { DraftMeta } from '../types';
import { compressImage, cropToRatio, imageSize } from '../utils/image';
import type { ImageScan } from './precheck';
import { renderStyleReport } from '../x/x-preview-modal';
import type { StyleReport } from '../../vendor/kaitox/relay-protocol/index';

export interface XConfirmInfo {
	report: StyleReport;
	unresolved: string[];
	relayOnline: boolean;
	/** 启动内置中转，返回是否成功 */
	startRelay?: () => Promise<boolean>;
}

export const DRAFT_LIMITS = { title: 64, author: 8, digest: 120 };

/** 公众号封面推荐比例 2.35:1（900×383） */
const COVER_RATIO = 2.35;

interface CheckIssue {
	id: string;
	/** error 必须修复才能推送；warn / info 可以忽略 */
	level: 'error' | 'warn' | 'info';
	text: string;
	fixLabel?: string;
	fix?: () => void | Promise<void>;
}

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
			console.error('[SerenaPost] 下载封面失败', e);
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
	// 作者：专门的公众号作者属性 > 设置里的默认作者 > 通用 author 属性（去掉 [[ ]] 和 @，超长则不用）
	const cleanName = (v: string) => v.replace(/^\[\[|\]\]$/g, '').split('|').pop()!.replace(/^@/, '').trim();
	const fmAuthor = cleanName(fmString(fm, ['author', '作者']));
	const author = cleanName(fmString(fm, ['wx_author', '公众号作者']))
		|| input.defaultAuthor
		|| (fmAuthor.length <= DRAFT_LIMITS.author ? fmAuthor : '');
	// 摘要：专门的 digest/摘要 优先；description 只作参考，超长自动截断
	let digest = fmString(fm, ['digest', '摘要']);
	if (!digest) {
		const desc = fmString(fm, ['description', 'summary']).replace(/\s+/g, ' ');
		digest = desc.length > DRAFT_LIMITS.digest ? desc.slice(0, DRAFT_LIMITS.digest - 1) + '…' : desc;
	}
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
	private xInfo?: XConfirmInfo;
	private resolver: ((meta: DraftMeta | null) => void) | null = null;
	private submitted = false;
	private scan?: ImageScan;
	private ignored = new Set<string>();
	private coverDims: { w: number; h: number } | null = null;
	private checkEl: HTMLElement | null = null;

	constructor(app: App, meta: DraftMeta, coverSource: string, accountNames: string[], xInfo?: XConfirmInfo, scan?: ImageScan) {
		super(app);
		this.meta = { ...meta };
		this.coverSource = coverSource;
		this.accountNames = accountNames;
		this.xInfo = xInfo;
		this.scan = scan;
	}

	private async measureCover() {
		this.coverDims = null;
		if (!this.meta.coverBase64) return;
		try {
			this.coverDims = await imageSize(this.meta.coverBase64);
		} catch { /* 读不出尺寸就不检查比例 */ }
		this.renderChecks();
	}

	/** 发布前体检：列出问题，能一键修的给按钮 */
	private issues(): CheckIssue[] {
		const m = this.meta;
		const out: CheckIssue[] = [];
		const L = DRAFT_LIMITS;
		if (!m.title.trim()) out.push({ id: 'title-empty', level: 'error', text: '还没有标题' });
		if (m.title.length > L.title) {
			out.push({ id: 'title', level: 'error', text: `标题 ${m.title.length} 字，超过 ${L.title} 字上限`, fixLabel: `截成 ${L.title} 字`, fix: () => { m.title = m.title.slice(0, L.title); } });
		}
		if (this.hasWechat) {
			if (m.author.length > L.author) {
				out.push({ id: 'author', level: 'error', text: `作者「${m.author}」${m.author.length} 个字，公众号最多 ${L.author} 个字`, fixLabel: `只保留前 ${L.author} 个字`, fix: () => { m.author = m.author.slice(0, L.author); } });
			}
			if (m.digest.length > L.digest) {
				out.push({ id: 'digest', level: 'error', text: `摘要 ${m.digest.length} 字，超过 ${L.digest} 字上限`, fixLabel: `截成 ${L.digest} 字`, fix: () => { m.digest = m.digest.slice(0, L.digest - 1) + '…'; } });
			}
			if (!m.coverBase64) {
				out.push({ id: 'cover-missing', level: 'error', text: '公众号草稿必须有封面', fixLabel: '选择封面', fix: () => this.pickCover() });
			} else if (this.coverDims) {
				const { w, h } = this.coverDims;
				const r = w / h;
				if (Math.abs(r - COVER_RATIO) > 0.3) {
					out.push({
						id: 'cover-ratio', level: 'warn',
						text: `封面是 ${w}×${h}（约 ${r.toFixed(2)}:1），公众号封面推荐 2.35:1，其他比例在列表里会被裁掉一部分`,
						fixLabel: '居中裁成 2.35:1',
						fix: async () => {
							m.coverBase64 = await cropToRatio(m.coverBase64, COVER_RATIO);
							this.coverSource += '（已裁成 2.35:1）';
							await this.measureCover();
						}
					});
				}
			}
			const sc = this.scan;
			if (sc?.missing.length) {
				out.push({ id: 'img-missing', level: 'warn', text: `${sc.missing.length} 张图片在库里找不到（${sc.missing.slice(0, 3).join('、')}${sc.missing.length > 3 ? ' 等' : ''}），草稿里会缺这些图` });
			}
			if (sc?.animated.length) {
				out.push({ id: 'img-gif', level: 'warn', text: `${sc.animated.length} 张 GIF 动图：公众号接口只能上传静态图，发布后会变成第一帧（想保留动图，需要发布后在公众号编辑器里重新插入）` });
			}
			if (sc?.large.length) {
				const max = Math.max(...sc.large.map(i => i.kb));
				out.push({ id: 'img-large', level: 'info', text: `${sc.large.length} 张图片超过 1MB（最大 ${(max / 1024).toFixed(1)}MB），发布时会自动压缩到 1MB 以内` });
			}
			if (sc?.remote.length) {
				out.push({ id: 'img-remote', level: 'info', text: `${sc.remote.length} 张网络图片，发布时会自动下载再上传到公众号；如果原网站不让下载，草稿里会少这张图` });
			}
		}
		const x = this.xInfo;
		if (x && !x.relayOnline) {
			out.push({
				id: 'x-relay', level: 'error', text: 'X：中转程序没有运行，X 会推送失败',
				fixLabel: x.startRelay ? '启动内置中转' : undefined,
				fix: x.startRelay ? async () => {
					const ok = await x.startRelay!();
					x.relayOnline = ok;
					new Notice(ok ? '中转已启动' : '中转启动失败，请到 SerenaPost 设置里检查「内置中转」');
				} : undefined
			});
		}
		if (x?.unresolved.length) {
			out.push({ id: 'x-unresolved', level: 'warn', text: `X：${x.unresolved.length} 个引用找不到（${x.unresolved.slice(0, 3).join('、')}），推送时会跳过` });
		}
		const xErrors = x?.report?.counts?.error ?? 0;
		if (xErrors) {
			out.push({ id: 'x-style', level: 'warn', text: `X：格式检查有 ${xErrors} 处错误，可以在下方「X 文章」里查看详情` });
		}
		return out.filter(i => i.level === 'error' || !this.ignored.has(i.id));
	}

	private renderChecks() {
		const box = this.checkEl;
		if (!box) return;
		box.empty();
		const list = this.issues();
		const head = box.createDiv({ cls: 'sp-check-head' });
		const ic = head.createSpan({ cls: 'sp-check-head-ic' });
		if (list.length === 0) {
			box.addClass('is-pass');
			setIcon(ic, 'check-circle-2');
			head.createSpan({ text: '发布前检查通过' });
			return;
		}
		box.removeClass('is-pass');
		setIcon(ic, 'stethoscope');
		const errors = list.filter(i => i.level === 'error').length;
		head.createSpan({ text: errors ? `发布前检查：${errors} 个问题需要先修复` : `发布前检查：${list.length} 条提醒` });
		for (const issue of list) {
			const row = box.createDiv({ cls: `sp-check-row is-${issue.level}` });
			const ri = row.createSpan({ cls: 'sp-check-ic' });
			setIcon(ri, issue.level === 'error' ? 'x-circle' : issue.level === 'warn' ? 'alert-triangle' : 'info');
			row.createDiv({ cls: 'sp-check-text', text: issue.text });
			const actions = row.createDiv({ cls: 'sp-check-actions' });
			if (issue.fix) {
				const b = actions.createEl('button', { text: issue.fixLabel ?? '修复', cls: 'mod-cta' });
				b.onclick = async () => {
					b.disabled = true;
					try {
						await issue.fix!();
					} catch (e) {
						new Notice(`修复失败：${e instanceof Error ? e.message : e}`);
					}
					this.render();
				};
			}
			if (issue.level !== 'error') {
				const b = actions.createEl('button', { text: issue.level === 'info' ? '知道了' : '忽略' });
				b.onclick = () => {
					this.ignored.add(issue.id);
					this.renderChecks();
				};
			}
		}
	}

	private get hasWechat(): boolean {
		return this.accountNames.length > 0;
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
		void this.measureCover();
	}

	onClose() {
		this.contentEl.empty();
		if (!this.submitted) this.resolver?.(null);
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: '推送到草稿箱' });
		const targets = [...this.accountNames.map(n => `公众号「${n}」`)];
		if (this.xInfo) targets.push('X 文章草稿');
		contentEl.createEl('p', {
			cls: 'wechatpb-draft-target',
			text: `将发送到：${targets.join('、')}`
		});

		this.checkEl = contentEl.createDiv({ cls: 'sp-check' });
		this.renderChecks();

		if (this.xInfo) {
			const xBox = contentEl.createDiv({ cls: 'wechatpb-x-confirm' });
			xBox.createEl('div', { cls: 'wechatpb-x-confirm-title', text: 'X 文章' });
			renderStyleReport(xBox, this.xInfo.report, this.xInfo.unresolved);
		}

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
				this.renderChecks();
			});
			text.inputEl.addClass('wechatpb-wide-input');
		});

		if (this.hasWechat) {
		// 作者
		const authorSetting = new Setting(contentEl).setName('作者（公众号）').setDesc('');
		const authorCount = authorSetting.descEl.createSpan({ cls: 'wechatpb-counter' });
		counter(authorCount, this.meta.author, DRAFT_LIMITS.author);
		authorSetting.addText(text => text
			.setPlaceholder('可留空')
			.setValue(this.meta.author)
			.onChange(v => {
				this.meta.author = v;
				counter(authorCount, v, DRAFT_LIMITS.author);
				this.renderChecks();
			}));

		// 摘要
		const digestSetting = new Setting(contentEl).setName('摘要（公众号）').setDesc('留空则微信自动截取正文前 54 字。');
		const digestCount = digestSetting.descEl.createSpan({ cls: 'wechatpb-counter' });
		counter(digestCount, this.meta.digest, DRAFT_LIMITS.digest);
		digestSetting.addTextArea(area => {
			area.setValue(this.meta.digest).onChange(v => {
				this.meta.digest = v;
				counter(digestCount, v, DRAFT_LIMITS.digest);
				this.renderChecks();
			});
			area.inputEl.rows = 3;
			area.inputEl.addClass('wechatpb-wide-input');
		});

		// 原文链接
		new Setting(contentEl)
			.setName('原文链接（公众号）')
			.setDesc('可选，文末「阅读原文」跳转地址')
			.addText(text => text
				.setPlaceholder('https://')
				.setValue(this.meta.contentSourceUrl)
				.onChange(v => { this.meta.contentSourceUrl = v.trim(); }));

		}

		// 封面
		const coverSetting = new Setting(contentEl)
			.setName(this.hasWechat ? '封面（必填）' : '封面')
			.setDesc(this.meta.coverBase64 ? `来源：${this.coverSource}` : '还没有封面：在笔记属性写 cover，或点击右侧选择图片');
		coverSetting.addButton(btn => btn
			.setButtonText(this.meta.coverBase64 ? '更换' : '选择图片')
			.onClick(() => this.pickCover()));
		if (this.meta.coverBase64) {
			const preview = contentEl.createDiv({ cls: 'wechatpb-cover-preview' });
			preview.createEl('img', { attr: { src: this.meta.coverBase64, alt: '封面预览' } });
		}

		if (this.hasWechat) {
		// 留言
		new Setting(contentEl)
			.setName('开启留言（公众号）')
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
				await this.measureCover();
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
		const blocking = this.issues().filter(i => i.level === 'error');
		if (blocking.length) {
			new Notice(`还有 ${blocking.length} 个问题需要先修复（见弹窗顶部「发布前检查」）`);
			this.checkEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			return;
		}
		if (!m.title) { new Notice('请填写标题'); return; }
		if (m.title.length > DRAFT_LIMITS.title) { new Notice(`标题最多 ${DRAFT_LIMITS.title} 字`); return; }
		if (this.hasWechat && m.author.length > DRAFT_LIMITS.author) { new Notice(`作者最多 ${DRAFT_LIMITS.author} 字`); return; }
		if (this.hasWechat && m.digest.length > DRAFT_LIMITS.digest) { new Notice(`摘要最多 ${DRAFT_LIMITS.digest} 字`); return; }
		if (m.contentSourceUrl && !/^https?:\/\//i.test(m.contentSourceUrl)) {
			new Notice('原文链接需要以 http:// 或 https:// 开头'); return;
		}
		if (this.hasWechat && !m.coverBase64) { new Notice('微信草稿必须有封面，请先选择封面'); return; }
		if (!m.openComment) m.onlyFansCanComment = false;
		this.submitted = true;
		this.resolver?.({ ...m });
		this.close();
	}
}
