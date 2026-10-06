import { App, ItemView, WorkspaceLeaf, Notice, MarkdownView, Modal, TFile, normalizePath, sanitizeHTMLToDom, setIcon } from 'obsidian';
import html2canvas from 'html2canvas';
import WeChatPublisherPlugin from '../main';
import { WeChatAccount, PublishProgress, DraftMeta } from '../types';
import { DraftConfirmModal, buildDraftDefaults, detectCover, resolveImageRef } from '../modals/draft-confirm-modal';
import { MarkedFormatter } from '../utils/formatter';
import { ThemeManager } from '../utils/theme-manager';
import { getAccessToken, uploadImage, addDraft, WeixinApiError } from '../services/weixin-api';
import { toUploadable } from '../utils/image';
import { scanImages } from '../modals/precheck';
import { isRelayUp, prepareXDraft, pushXDraft, type XPrepared } from '../x/xpush';
import { AVATAR_DATA_URI, ICON_ID } from '../brand';
import { KAITOX_STORE_URL } from '../modals/onboarding-modal';
import { AccountModal } from '../modals/account-modal';

const MP_HOME_URL = 'https://mp.weixin.qq.com/';
const X_DRAFTS_URL = 'https://x.com/compose/articles';
const DEV_PLATFORM_URL = 'https://developers.weixin.qq.com/console/product/mp';
import { ThemeEditorModal } from '../theme-editor/theme-editor-modal';
import { exportThemeJson, parseThemeJson, type CustomThemeDef } from '../theme-editor/custom-theme';
import { CUSTOM_THEME_PREFIX, renderSetup, type Theme } from '../utils/theme-manager';
import { HEADING_STYLES } from '../utils/heading-styles';
import { squareAvatar } from '../utils/image';

/** 发布进度里 X 渠道使用的伪账号 id */
const X_TARGET_ID = '__x_article__';

export const VIEW_TYPE_PUBLISHER = 'serena-post-view';

export class PublisherView extends ItemView {
	plugin: WeChatPublisherPlugin;
	selectedAccountIds: Set<string> = new Set();
	coverImage: { path?: string; base64?: string } | null = null;
	/** 当前笔记自动识别出的封面（笔记属性 cover 或正文第一张图） */
	autoCover: { filePath: string; base64: string; source: string } | null = null;
	autoCoverLoading = false;
	/** 用户手动移除了自动封面的笔记 */
	autoCoverDismissed: Set<string> = new Set();
	currentFile: TFile | null = null;
	private autoCoverSeq = 0;
	/** Kaitox 中转程序是否在线（null = 还没检测） */
	relayOnline: boolean | null = null;
	publishProgress: Map<string, PublishProgress> = new Map();
	isPublishing: boolean = false;
	selectedTheme: string = '绿白清简';     // 当前选中的主题
	themeManager: ThemeManager;
	publishSummary: { successCount: number; failCount: number } | null = null; // 发布汇总信息
	/** 最近一次推送的内容（用于失败后重试） */
	private lastRun: { file: TFile; draft: DraftMeta; html: string; xPrepared: XPrepared | null } | null = null;
	private retrying = new Set<string>();

	constructor(leaf: WorkspaceLeaf, plugin: WeChatPublisherPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.themeManager = new ThemeManager(this.app);
		this.selectedTheme = this.plugin.settings.defaultTheme;
	}

	getViewType(): string {
		return VIEW_TYPE_PUBLISHER;
	}

	getDisplayText(): string {
		return 'SerenaPost';
	}

	getIcon(): string {
		return ICON_ID;
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('wechat-multi-publisher-view');

		// 初始化主题管理器
		this.themeManager.setThemesFolder(this.plugin.settings.themesFolder);
		this.themeManager.setCustomThemesEnabled(this.plugin.settings.customThemesEnabled);
		this.themeManager.setCustomDefs(this.plugin.settings.customThemes);
		await this.themeManager.loadThemes();
		const initialTheme = this.themeManager.getTheme(this.plugin.settings.defaultTheme) ?? this.themeManager.getDefaultTheme();
		this.selectedTheme = initialTheme.name;
		if (this.plugin.settings.defaultTheme !== initialTheme.name) {
			this.plugin.settings.defaultTheme = initialTheme.name;
			await this.plugin.saveSettings();
		}

		// 跟随当前笔记自动识别封面
		this.registerEvent(this.app.workspace.on('file-open', file => {
			if (file && file.extension === 'md') void this.setCurrentFile(file);
		}));
		this.registerEvent(this.app.metadataCache.on('changed', file => {
			if (this.currentFile && file.path === this.currentFile.path) void this.refreshAutoCover(true);
		}));

		this.render();
		this.plugin.refreshLivePreview();
		if (!this.plugin.settings.onboardingDone) {
			this.app.workspace.onLayoutReady(() => window.setTimeout(() => this.plugin.openOnboarding(), 600));
		}
		void this.checkRelay();
		// 内置中转在 Obsidian 布局就绪后才启动，开头几秒多查两次，避免误显示「未运行」
		for (const ms of [2000, 5000]) {
			const t = window.setTimeout(() => void this.checkRelay(), ms);
			this.register(() => window.clearTimeout(t));
		}
		this.registerInterval(window.setInterval(() => void this.checkRelay(), 15000));
		const initial = this.app.workspace.getActiveFile();
		if (initial && initial.extension === 'md') void this.setCurrentFile(initial);
	}

	async checkRelay() {
		const online = await isRelayUp(this.plugin.settings);
		if (online !== this.relayOnline) {
			this.relayOnline = online;
			if (!this.isPublishing) this.render();
		}
	}

	get xSelected(): boolean {
		return this.plugin.settings.xSelected;
	}

	async setCurrentFile(file: TFile) {
		if (this.currentFile?.path === file.path) return;
		this.currentFile = file;
		// 手动上传的封面只属于上一篇笔记
		this.coverImage = null;
		await this.refreshAutoCover(false);
	}

	async refreshAutoCover(silent: boolean) {
		const file = this.currentFile;
		const seq = ++this.autoCoverSeq;
		if (!file) return;
		if (!silent) {
			this.autoCover = null;
			this.autoCoverLoading = true;
			this.render();
		}
		try {
			const markdown = await this.app.vault.cachedRead(file);
			const detected = await detectCover(this.app, file, markdown);
			if (seq !== this.autoCoverSeq) return;
			const prev = this.autoCover?.base64;
			this.autoCover = detected ? { filePath: file.path, ...detected } : null;
			this.autoCoverLoading = false;
			if (!silent || prev !== this.autoCover?.base64) this.render();
		} catch (error) {
			console.error('[SerenaPost] 自动识别封面失败', error);
			if (seq !== this.autoCoverSeq) return;
			this.autoCoverLoading = false;
			this.render();
		}
	}

	async onClose() {
		// Cleanup
	}

	render() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('sp-sidebar');

		// Header
		const header = container.createDiv({ cls: 'publisher-header' });
		const brand = header.createDiv({ cls: 'serena-post-brand' });
		brand.createEl('img', { cls: 'serena-post-avatar', attr: { src: AVATAR_DATA_URI, alt: 'Serena' } });
		const titles = brand.createDiv({ cls: 'sp-brand-titles' });
		titles.createEl('h3', { text: 'SerenaPost' });
		titles.createDiv({ cls: 'serena-post-tagline', text: '一稿双发 · 公众号 + X' });
		const guide = brand.createEl('button', { cls: 'sp-guide-btn', text: '新手引导' });
		guide.onclick = () => this.plugin.openOnboarding();

		this.renderLegacyKaitoxNotice(container);

		const body = container.createDiv({ cls: 'sp-cards' });
		this.card(body, 'target', '发到哪', this.targetSummary(), el => this.renderAccountSelection(el));
		this.card(body, 'look', '长什么样', this.lookSummary(), el => this.renderThemeSelection(el));
		this.card(body, 'cover', '封面', this.coverSummary(), el => this.renderCoverUpload(el));

		// 底部固定：预览 / 发布 + 进度
		const footer = container.createDiv({ cls: 'sp-footer' });
		if (this.isPublishing || this.publishSummary) {
			this.renderPublishProgress(footer);
		}
		this.renderActionButtons(footer);
	}

	/** 旧 Kaitox 插件还开着：它会弹「relay 未运行」之类的提示，和 SerenaPost 的内置中转重复 */
	private renderLegacyKaitoxNotice(container: HTMLElement) {
		const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string>; disablePluginAndSave?: (id: string) => Promise<void> } }).plugins;
		if (!plugins?.enabledPlugins?.has('kaitox')) return;
		const box = container.createDiv({ cls: 'sp-legacy-notice' });
		const text = box.createDiv({ cls: 'sp-legacy-text' });
		text.createEl('strong', { text: '可以关掉旧 Kaitox 插件' });
		text.createDiv({ text: 'SerenaPost 已经内置了推 X 的功能。旧插件开着会重复弹「relay 未运行」的提示。（Chrome 里的 Kaitox 扩展要保留）' });
		const btn = box.createEl('button', { text: '一键关闭', cls: 'mod-cta' });
		btn.onclick = async () => {
			btn.disabled = true;
			try {
				await plugins.disablePluginAndSave?.('kaitox');
				new Notice('已关闭旧 Kaitox 插件，以后用 SerenaPost 推 X 就行');
			} catch (e) {
				new Notice(`关闭失败，可到「设置 → 第三方插件」手动关闭：${e instanceof Error ? e.message : e}`);
			}
			this.render();
		};
	}

	/** 可折叠的分组卡片，折叠时标题右边显示当前选择 */
	private card(parent: HTMLElement, id: string, title: string, summary: string, fill: (el: HTMLElement) => void) {
		const collapsed = this.plugin.settings.collapsedCards.includes(id);
		const card = parent.createDiv({ cls: `sp-card${collapsed ? ' is-collapsed' : ''}` });
		const head = card.createDiv({ cls: 'sp-card-head' });
		const chev = head.createSpan({ cls: 'sp-card-chev' });
		setIcon(chev, 'chevron-down');
		head.createSpan({ cls: 'sp-card-title', text: title });
		head.createSpan({ cls: 'sp-card-summary', text: summary });
		head.onclick = async () => {
			const list = this.plugin.settings.collapsedCards;
			this.plugin.settings.collapsedCards = collapsed ? list.filter(c => c !== id) : [...list, id];
			await this.plugin.saveSettings();
			this.render();
		};
		if (!collapsed) fill(card.createDiv({ cls: 'sp-card-body' }));
	}

	private targetSummary(): string {
		const parts: string[] = [];
		if (this.selectedAccountIds.size) parts.push(`公众号 ${this.selectedAccountIds.size} 个`);
		if (this.xSelected) parts.push('X');
		return parts.length ? parts.join(' + ') : '未选择';
	}

	private lookSummary(): string {
		const style = HEADING_STYLES.find(h => h.id === this.plugin.settings.headingStyle);
		const styleText = style && style.id !== 'theme' ? ` · ${style.label.split(/\s|　/)[0]}` : '';
		return `${this.selectedTheme}${styleText}`;
	}

	private coverSummary(): string {
		const file = this.currentFile;
		if (this.coverImage) return '已手动设置';
		if (this.autoCover && file && this.autoCover.filePath === file.path && !this.autoCoverDismissed.has(file.path)) return '自动：正文第一张图';
		return '未设置';
	}

	renderAccountSelection(container: HTMLElement) {
		const section = container.createDiv({ cls: 'account-selection-section' });
		section.createEl('h4', { text: '选择账号' });

		if (this.plugin.settings.accounts.length === 0) {
			this.selectedAccountIds.clear();
			const empty = section.createDiv({ cls: 'account-remark sp-empty-cta' });
			empty.createSpan({ text: '还没有公众号账号。' });
			const start = empty.createEl('button', { text: '跟着引导设置', cls: 'mod-cta' });
			start.onclick = () => this.plugin.openOnboarding();
			this.renderXItem(section);
			this.renderSelectedCount(section);
			return;
		}

		// Quick actions
		const actionsDiv = section.createDiv({ cls: 'quick-actions' });

		const selectAllBtn = actionsDiv.createEl('button', { text: '全选' });
		selectAllBtn.onclick = () => {
			this.plugin.settings.accounts
				.filter(acc => acc.status === 'online')
				.forEach(acc => this.selectedAccountIds.add(acc.id));
			this.render();
		};

		const clearBtn = actionsDiv.createEl('button', { text: '清空' });
		clearBtn.onclick = () => {
			this.selectedAccountIds.clear();
			this.render();
		};

		// Account list
		const accountList = section.createDiv({ cls: 'account-list' });

		for (const account of this.plugin.settings.accounts) {
			this.renderAccountItem(accountList, account);
		}

		this.renderXItem(accountList);
		this.renderSelectedCount(section);
	}

	renderSelectedCount(section: HTMLElement) {
		const parts = [`${this.selectedAccountIds.size} 个公众号`];
		if (this.xSelected) parts.push('X');
		section.createDiv({ cls: 'selected-count', text: `已选择：${parts.join(' + ')}` });
	}

	/** 「X 文章草稿」选项（通过 Kaitox 中转推送） */
	renderXItem(container: HTMLElement) {
		const item = container.createDiv({ cls: 'account-item wechatpb-x-item' });
		const checkbox = item.createEl('input', { type: 'checkbox' });
		checkbox.checked = this.xSelected;
		checkbox.onchange = async () => {
			this.plugin.settings.xSelected = checkbox.checked;
			await this.plugin.saveSettings();
			this.render();
		};
		const label = item.createDiv({ cls: 'account-label' });
		const dot = label.createSpan({ cls: 'wechatpb-relay-dot' });
		const online = this.relayOnline;
		dot.addClass(online === null ? 'is-unknown' : online ? 'is-on' : 'is-off');
		dot.setAttr('aria-label', online ? '中转已连接' : '中转未连接');
		label.createSpan({ cls: 'account-name', text: 'X 文章草稿' });
		const remark = label.createDiv({ cls: 'account-remark' });
		if (online === null) remark.setText('正在检测中转…');
		else if (!online) remark.setText('中转未运行：到 SerenaPost 设置打开「内置中转」');
		else {
			remark.appendText('中转已就绪 · 需要 Chrome 里的 ');
			const a = remark.createEl('a', { text: 'Kaitox 扩展', href: KAITOX_STORE_URL });
			a.onclick = e => { e.stopPropagation(); };
		}
	}

	renderAccountItem(container: HTMLElement, account: WeChatAccount) {
		const item = container.createDiv({ cls: 'account-item' });

		if (account.status === 'expired') {
			item.addClass('expired');
		} else if (account.status === 'error') {
			item.addClass('error');
		}

		const checkbox = item.createEl('input', { type: 'checkbox' });
		checkbox.checked = this.selectedAccountIds.has(account.id);
		checkbox.disabled = account.status !== 'online';
		checkbox.onchange = () => {
			if (checkbox.checked) {
				this.selectedAccountIds.add(account.id);
			} else {
				this.selectedAccountIds.delete(account.id);
			}
			this.render();
		};

		const statusIcon = account.status === 'online' ? '✅' :
						  account.status === 'expired' ? '⚠️' : '❌';

		const label = item.createDiv({ cls: 'account-label' });
		label.createSpan({ cls: 'status-icon', text: statusIcon });
		label.createSpan({ cls: 'account-name', text: account.name });

		if (account.remark) {
			label.createDiv({ text: account.remark, cls: 'account-remark' });
		}

		if (account.status === 'expired') {
			item.createDiv({ text: '登录已过期 - 请重新登录', cls: 'warning-text' });
		}
	}

	async reloadThemes() {
		this.themeManager.setThemesFolder(this.plugin.settings.themesFolder);
		this.themeManager.setCustomThemesEnabled(this.plugin.settings.customThemesEnabled);
		this.themeManager.setCustomDefs(this.plugin.settings.customThemes);
		await this.themeManager.loadThemes();
		if (!this.themeManager.getTheme(this.selectedTheme)) {
			this.selectedTheme = this.themeManager.getDefaultTheme().name;
		}
		this.plugin.refreshLivePreview();
	}

	private async selectTheme(name: string) {
		this.selectedTheme = name;
		this.plugin.settings.defaultTheme = name;
		await this.plugin.saveSettings();
	}

	/** 编辑器预览用：当前笔记正文（去掉属性、图片转成可显示的数据） */
	private async getPreviewMarkdown(): Promise<string> {
		const file = this.currentFile ?? this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') return '';
		let content = this.removeFrontmatter(await this.app.vault.cachedRead(file));
		const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => (l.view as MarkdownView).file?.path === file.path);
		if (leaf) {
			try { content = await this.processImageLinks(content, leaf.view as MarkdownView); } catch { /* 预览不显示图片也无妨 */ }
		}
		return content;
	}

	async openThemeEditor() {
		const current = this.themeManager.getTheme(this.selectedTheme);
		const builtins = this.themeManager.getBuiltinThemes();
		const editing = current?.customDef;
		const startBase = editing?.base ?? (current?.builtin ? current.name : builtins[0]?.name);
		new ThemeEditorModal(this.app, {
			builtins,
			editing,
			startBase,
			existingNames: this.plugin.settings.customThemes.map(t => t.name),
			previewMarkdown: await this.getPreviewMarkdown(),
			onSave: async (def, isNew) => {
				const list = this.plugin.settings.customThemes;
				if (isNew) list.push(def);
				else {
					const i = list.findIndex(t => t.id === def.id);
					if (i >= 0) list[i] = def; else list.push(def);
				}
				await this.plugin.saveSettings();
				await this.reloadThemes();
				await this.selectTheme(CUSTOM_THEME_PREFIX + def.name);
				new Notice(isNew ? `已保存新排版「${def.name}」` : `已更新排版「${def.name}」`);
				this.render();
			},
			onDelete: async def => {
				this.plugin.settings.customThemes = this.plugin.settings.customThemes.filter(t => t.id !== def.id);
				await this.plugin.saveSettings();
				await this.reloadThemes();
				await this.selectTheme(this.themeManager.getTheme(def.base)?.name ?? this.themeManager.getDefaultTheme().name);
				new Notice(`已删除排版「${def.name}」`);
				this.render();
			},
			onExport: def => this.exportTheme(def)
		}).open();
	}

	async exportTheme(def: CustomThemeDef) {
		const folder = 'SerenaPost排版';
		const safe = def.name.replace(/[\\/:*?"<>|]/g, '-');
		const path = normalizePath(`${folder}/${safe}.serenapost.json`);
		try {
			if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) await this.app.vault.modify(existing, exportThemeJson(def));
			else await this.app.vault.create(path, exportThemeJson(def));
			new Notice(`已导出到仓库：${path}\n把这个文件发给别人，对方点「导入排版」即可使用`, 8000);
		} catch (e) {
			new Notice(`导出失败：${e instanceof Error ? e.message : e}`);
		}
	}

	async importTheme(raw: string) {
		try {
			const builtins = this.themeManager.getBuiltinThemes().map(t => t.name);
			const def = parseThemeJson(raw, builtins, this.themeManager.getDefaultTheme().name);
			const names = this.plugin.settings.customThemes.map(t => t.name);
			let name = def.name;
			let i = 2;
			while (names.includes(name)) name = `${def.name} ${i++}`;
			def.name = name;
			this.plugin.settings.customThemes.push(def);
			await this.plugin.saveSettings();
			await this.reloadThemes();
			await this.selectTheme(CUSTOM_THEME_PREFIX + def.name);
			new Notice(`已导入排版「${def.name}」`);
			this.render();
		} catch (e) {
			new Notice(`导入失败：${e instanceof Error ? e.message : e}`);
		}
	}

	renderThemeSelection(container: HTMLElement) {
		const section = container.createDiv({ cls: 'theme-selection-section' });

		// Title
		section.createEl('h4', { text: '排版样式' });

		// Select and refresh button in same row
		const controlRow = section.createDiv({ cls: 'theme-control-row' });

		// Create select element
		const select = controlRow.createEl('select', { cls: 'theme-select' });

		const themes = this.themeManager.getThemes();
		const builtinGroup = select.createEl('optgroup', { attr: { label: '内置排版' } });
		const customThemes = themes.filter(theme => !theme.builtin);
		const customGroup = customThemes.length > 0
			? select.createEl('optgroup', { attr: { label: '自定义排版' } })
			: null;

		for (const theme of themes) {
			const parent = theme.builtin ? builtinGroup : customGroup;
			if (!parent) continue;
			const option = parent.createEl('option', { value: theme.name, text: theme.name });
			option.selected = this.selectedTheme === theme.name;
		}

		// Handle selection change
		select.onchange = async () => {
			this.selectedTheme = select.value;
			this.plugin.settings.defaultTheme = this.selectedTheme;
			await this.plugin.saveSettings();
			this.render();
		};

		// Refresh button
		const refreshBtn = controlRow.createEl('button', {
			text: '刷新',
			cls: 'theme-refresh-btn'
		});
		refreshBtn.onclick = async () => {
			// Reload themes
			this.themeManager.setThemesFolder(this.plugin.settings.themesFolder);
			await this.reloadThemes();
			new Notice('主题列表已刷新');
			this.render();
		};

		// 可视化编辑器入口
		const selectedForEdit = this.themeManager.getTheme(this.selectedTheme);
		const editRow = section.createDiv({ cls: 'theme-edit-row' });
		const editBtn = editRow.createEl('button', {
			text: selectedForEdit?.customDef ? '编辑这套排版' : '基于这套新建排版'
		});
		editBtn.onclick = () => void this.openThemeEditor();
		const importBtn = editRow.createEl('button', { text: '导入排版' });
		const importInput = editRow.createEl('input', { type: 'file', cls: 'hidden-input' });
		importInput.accept = '.json,application/json';
		importInput.onchange = async () => {
			const f = importInput.files?.[0];
			importInput.value = '';
			if (f) await this.importTheme(await f.text());
		};
		importBtn.onclick = () => importInput.click();

		const selected = this.themeManager.getTheme(this.selectedTheme);
		const themeHint = section.createDiv({ cls: 'theme-hint' });
		themeHint.createSpan({ cls: 'theme-color-dot', attr: { style: `--theme-accent: ${selected?.accent ?? '#64748b'}` } });
		themeHint.createSpan({
			text: selected?.description ?? '内置排版已自动加载，开箱即用'
		});
		this.renderBrandControls(section);
		section.createDiv({
			cls: 'theme-library-hint',
			text: `已内置 ${themes.filter(theme => theme.builtin).length} 套排版${customThemes.length > 0 ? `，另加载 ${customThemes.length} 套自定义排版` : '，开箱即用'}`
		});
	}

	/** 当前排版 + 侧栏的章节样式 / IP 头像 / END 标记 */
	renderSetupFor(theme: Theme) {
		const st = this.plugin.settings;
		return renderSetup(theme, {
			headingStyle: st.headingStyle,
			headingAvatar: st.headingAvatar,
			avatarDataUrl: st.brandAvatar || AVATAR_DATA_URI,
			endMark: st.endMark,
			endMarkText: st.endMarkText
		});
	}

	/** 章节样式下拉 + IP 头像 / END 开关 */
	renderBrandControls(section: HTMLElement) {
		const st = this.plugin.settings;
		const box = section.createDiv({ cls: 'sp-brand-controls' });
		const row = box.createDiv({ cls: 'sp-brand-row' });
		row.createSpan({ cls: 'sp-brand-label', text: '章节样式' });
		const select = row.createEl('select', { cls: 'dropdown sp-heading-select' });
		for (const s of HEADING_STYLES) {
			const opt = select.createEl('option', { value: s.id, text: s.label });
			opt.selected = st.headingStyle === s.id;
		}
		select.onchange = async () => {
			st.headingStyle = select.value;
			await this.plugin.saveSettings();
		};

		const toggle = (text: string, get: () => boolean, set: (v: boolean) => void) => {
			const label = box.createEl('label', { cls: 'sp-brand-toggle' });
			const cb = label.createEl('input', { type: 'checkbox' });
			cb.checked = get();
			label.createSpan({ text });
			cb.onchange = async () => {
				set(cb.checked);
				await this.plugin.saveSettings();
			};
		};
		toggle('章节标题前放 IP 头像', () => st.headingAvatar, v => { st.headingAvatar = v; });
		const avatarRow = box.createDiv({ cls: 'sp-brand-row sp-avatar-row' });
		const avatarImg = avatarRow.createEl('img', { cls: 'sp-avatar-preview' });
		avatarImg.src = st.brandAvatar || AVATAR_DATA_URI;
		avatarRow.createSpan({ cls: 'sp-brand-label', text: st.brandAvatar ? '自己上传的头像' : '内置 Serena 头像' });
		const upload = avatarRow.createEl('button', { text: '上传头像' });
		const input = avatarRow.createEl('input', { type: 'file', cls: 'hidden-input' });
		input.accept = 'image/png,image/jpeg';
		upload.onclick = () => input.click();
		input.onchange = async () => {
			const f = input.files?.[0];
			input.value = '';
			if (!f) return;
			try {
				st.brandAvatar = await squareAvatar(f);
				st.headingAvatar = true;
				await this.plugin.saveSettings();
				new Notice('IP 头像已更新');
				this.render();
			} catch (e) {
				new Notice(`头像读取失败：${e instanceof Error ? e.message : e}`);
			}
		};
		if (st.brandAvatar) {
			const reset = avatarRow.createEl('button', { text: '恢复内置' });
			reset.onclick = async () => {
				st.brandAvatar = '';
				await this.plugin.saveSettings();
				this.render();
			};
		}
		toggle('文末加结束标记', () => st.endMark, v => { st.endMark = v; this.render(); });
		if (st.endMark) {
			const endRow = box.createDiv({ cls: 'sp-brand-row sp-end-row' });
			endRow.createSpan({ cls: 'sp-brand-label', text: '标记文字' });
			const input = endRow.createEl('input', { type: 'text', cls: 'sp-end-input' });
			input.placeholder = '例如：你的名字 · END';
			input.maxLength = 40;
			input.value = st.endMarkText;
			input.oninput = async () => {
				st.endMarkText = input.value.trim();
				await this.plugin.saveSettings();
			};
		}
	}

	renderCoverUpload(container: HTMLElement) {
		const section = container.createDiv({ cls: 'cover-upload-section' });
		section.createEl('h4', { text: '封面图片' });

		const file = this.currentFile;
		const auto = this.autoCover && file && this.autoCover.filePath === file.path && !this.autoCoverDismissed.has(file.path)
			? this.autoCover : null;

		if (!this.coverImage && !auto && this.autoCoverLoading) {
			section.createDiv({ cls: 'cover-source-hint', text: '正在识别文章里的第一张图片…' });
		}

		if (this.coverImage || auto) {
			const src = this.coverImage?.base64 ?? auto!.base64;
			section.createDiv({
				cls: 'cover-source-hint',
				text: this.coverImage ? '已手动上传封面' : `已自动使用${auto!.source}作为封面`
			});
			const preview = section.createDiv({ cls: 'cover-preview' });
			const img = preview.createEl('img');
			img.src = src;
			img.alt = '封面图片';

			const removeBtn = preview.createEl('button', { text: '×', cls: 'remove-cover' });
			removeBtn.setAttr('aria-label', '移除封面');
			removeBtn.onclick = () => {
				if (this.coverImage) {
					this.coverImage = null;
				} else if (file) {
					this.autoCoverDismissed.add(file.path);
				}
				this.render();
			};

			const actions = section.createDiv({ cls: 'cover-actions' });
			const replaceBtn = actions.createEl('button', { text: '更换封面' });
			const fileInput = actions.createEl('input', { type: 'file', cls: 'hidden-input' });
			fileInput.accept = 'image/jpeg,image/png';
			fileInput.onchange = async (e) => {
				const picked = (e.target as HTMLInputElement).files?.[0];
				if (picked) await this.handleFileUpload(picked);
			};
			replaceBtn.onclick = () => fileInput.click();
		} else if (file && this.autoCoverDismissed.has(file.path) && !this.autoCoverLoading) {
			const restore = section.createDiv({ cls: 'cover-source-hint' });
			restore.setText('已移除自动封面。');
			const link = restore.createEl('a', { text: '恢复自动识别', href: '#' });
			link.onclick = (e) => {
				e.preventDefault();
				this.autoCoverDismissed.delete(file.path);
				this.render();
			};
			this.renderCoverDropArea(section);
		} else if (!this.autoCoverLoading) {
			this.renderCoverDropArea(section);
		}
	}

	renderCoverDropArea(section: HTMLElement) {
		{
			// 没识别到图片时，显示上传区域
			// Show upload area
			const uploadArea = section.createDiv({ cls: 'cover-upload-area' });
			const placeholder = uploadArea.createDiv({ cls: 'upload-placeholder' });
			placeholder.createEl('p', { text: '点击或拖拽上传' });
			placeholder.createEl('p', { cls: 'upload-hint', text: 'JPG/PNG 格式，最大 2 MB，建议比例 2.35:1' });

			const fileInput = uploadArea.createEl('input', { type: 'file', cls: 'hidden-input' });
			fileInput.accept = 'image/jpeg,image/png';

			fileInput.onchange = async (e) => {
				const file = (e.target as HTMLInputElement).files?.[0];
				if (file) {
					await this.handleFileUpload(file);
				}
			};

			uploadArea.onclick = () => fileInput.click();

			// Drag and drop
			uploadArea.ondragover = (e) => {
				e.preventDefault();
				uploadArea.addClass('dragover');
			};

			uploadArea.ondragleave = () => {
				uploadArea.removeClass('dragover');
			};

			uploadArea.ondrop = async (e) => {
				e.preventDefault();
				uploadArea.removeClass('dragover');

				const file = e.dataTransfer?.files?.[0];
				if (file) {
					await this.handleFileUpload(file);
				}
			};
		}
	}

	async handleFileUpload(file: File) {
		// Validate file type
		if (!file.type.match(/^image\/(jpeg|png)$/)) {
			new Notice('仅支持 JPG/PNG 格式');
			return;
		}

		// Validate file size
		if (file.size > 2 * 1024 * 1024) {
			new Notice('图片大小不能超过 2MB');
			return;
		}

		// Read file as base64
		const reader = new FileReader();
		reader.onload = (e) => {
			this.coverImage = {
				base64: e.target?.result as string
			};
			this.render();
			new Notice('封面图片上传成功');
		};
		reader.readAsDataURL(file);
	}

	renderActionButtons(container: HTMLElement) {
		const section = container.createDiv({ cls: 'action-buttons sp-actions' });
		const row = section.createDiv({ cls: 'sp-actions-row' });
		const previewBtn = row.createEl('button', { text: '预览', cls: 'preview-btn' });
		previewBtn.onclick = () => this.handlePreview();
		const exportBtn = row.createEl('button', { text: '导出长图' });
		exportBtn.onclick = () => this.handleExportLongImage();

		const noTarget = this.selectedAccountIds.size === 0 && !this.xSelected;
		const publishBtn = section.createEl('button', { text: this.isPublishing ? '发布中…' : '发布到草稿箱', cls: 'publish-btn mod-cta' });
		publishBtn.disabled = noTarget || this.isPublishing;
		publishBtn.onclick = () => this.handlePublish();
		if (noTarget && !this.isPublishing) {
			section.createDiv({ cls: 'sp-actions-hint', text: '先在「发到哪」勾选公众号或 X' });
		}
	}

	renderPublishProgress(container: HTMLElement) {
		const section = container.createDiv({ cls: 'publish-progress-section' });
		section.createEl('h4', { text: '发布进度' });

		const progressList = section.createDiv({ cls: 'progress-list' });

		for (const [accountId, progress] of this.publishProgress) {
			const account = accountId === X_TARGET_ID
				? { name: 'X 文章草稿' }
				: this.plugin.settings.accounts.find(a => a.id === accountId);
			if (!account) continue;

			const item = progressList.createDiv({ cls: 'progress-item' });

			let statusText = '';
			let statusClass = '';

			switch (progress.status) {
				case 'pending':
					statusText = '等待中...';
					statusClass = 'pending';
					break;
				case 'publishing':
					statusText = '发布中...';
					statusClass = 'publishing';
					break;
				case 'success':
					statusText = `成功 (${(progress.duration || 0) / 1000}秒)`;
					statusClass = 'success';
					break;
				case 'failed':
					statusText = `失败：${progress.error}`;
					statusClass = 'failed';
					break;
			}

			const header = item.createDiv({ cls: 'progress-item-header' });
			header.createSpan({ cls: 'account-name', text: account.name });
			header.createSpan({ cls: `status ${statusClass}`, text: progress.status === 'failed' ? '失败' : statusText });
			if (progress.status === 'failed' && progress.error) {
				item.createDiv({ cls: 'sp-fail-msg', text: progress.error });
				const actions = item.createDiv({ cls: 'sp-fail-actions' });
				for (const a of this.errorActions(accountId, progress.error)) {
					const b = actions.createEl('button', { text: a.label, cls: a.primary ? 'mod-cta' : '' });
					b.onclick = async () => {
						b.disabled = true;
						try { await a.run(); } finally { b.disabled = false; }
					};
				}
			}
		}

		// 显示发布汇总信息
		if (this.publishSummary && !this.isPublishing) {
			const summary = section.createDiv({ cls: 'publish-summary' });
			const { successCount, failCount } = this.publishSummary;

			let summaryText = '发布完成：';
			let summaryClass = '';

			if (failCount === 0) {
				summaryText += `全部成功 (${successCount}/${successCount + failCount})`;
				summaryClass = 'summary-success';
			} else if (successCount === 0) {
				summaryText += `全部失败 (0/${successCount + failCount})`;
				summaryClass = 'summary-failed';
			} else {
				summaryText += `${successCount} 个成功，${failCount} 个失败`;
				summaryClass = 'summary-partial';
			}

			summary.className = `publish-summary ${summaryClass}`;
			summary.textContent = summaryText;

			// 推送成功后的直达入口
			const okWechat = Array.from(this.publishProgress.values()).some(p => p.accountId !== X_TARGET_ID && p.status === 'success');
			const okX = this.publishProgress.get(X_TARGET_ID)?.status === 'success';
			if (okWechat || okX) {
				const links = section.createDiv({ cls: 'sp-done-links' });
				if (okWechat) {
					const b = links.createEl('button', { text: '打开公众号草稿箱', cls: 'mod-cta' });
					b.onclick = () => { window.open(MP_HOME_URL); };
				}
				if (okX) {
					const b = links.createEl('button', { text: '打开 X 草稿', cls: 'mod-cta' });
					b.onclick = () => { window.open(X_DRAFTS_URL); };
				}
				const tips: string[] = [];
				if (okWechat) tips.push('公众号：登录后点左侧「内容管理 → 草稿箱」');
				if (okX) tips.push('X：Chrome 里的 Kaitox 扩展会在 X 文章编辑器里建好草稿，几秒后在草稿列表里能看到');
				links.createDiv({ cls: 'sp-done-tip', text: tips.join('；') });
			}
			const close = section.createEl('button', { cls: 'sp-progress-close', text: '收起' });
			close.onclick = () => {
				this.publishSummary = null;
				this.publishProgress.clear();
				this.render();
			};
		}
	}

	/** 根据错误给出能直接点的下一步 */
	private errorActions(targetId: string, error: string): { label: string; primary?: boolean; run: () => void | Promise<void> }[] {
		const actions: { label: string; primary?: boolean; run: () => void | Promise<void> }[] = [];
		const retry = { label: '重新推送', primary: true, run: () => this.retryTarget(targetId) };
		const openPlatform = { label: '打开开发者平台', run: () => { window.open(DEV_PLATFORM_URL); } };
		const copyError = {
			label: '复制错误信息', run: async () => {
				await navigator.clipboard.writeText(error);
				new Notice('已复制错误信息');
			}
		};

		if (targetId === X_TARGET_ID) {
			if (/中转/.test(error)) {
				actions.push({
					label: '启动内置中转', primary: true, run: async () => {
						const mode = await this.plugin.relay.takeOver(this.plugin.settings);
						this.relayOnline = await isRelayUp(this.plugin.settings);
						new Notice(this.relayOnline ? '中转已启动，可以重新推送了' : `中转启动失败：${this.plugin.relay.error || mode}`);
						this.render();
					}
				});
				actions.push({ ...retry, primary: false });
			} else {
				actions.push(retry);
			}
			actions.push({ label: '安装 Kaitox 扩展', run: () => { window.open(KAITOX_STORE_URL); } });
			actions.push(copyError);
			return actions;
		}

		const code = error.match(/errcode:\s*([-\w]+)/)?.[1] ?? '';
		const account = this.plugin.settings.accounts.find(a => a.id === targetId);
		const editAccount = {
			label: '编辑账号', run: () => {
				if (!account) return;
				new AccountModal(this.app, this.plugin, account, async updated => {
					const i = this.plugin.settings.accounts.findIndex(a => a.id === account.id);
					if (i !== -1) this.plugin.settings.accounts[i] = updated;
					await this.plugin.saveSettings();
					new Notice('账号已更新，可以重新推送了');
					this.render();
				}).open();
			}
		};

		if (code === '40164') {
			const ip = error.match(/IP\s*([0-9a-fA-F.:]{7,})/)?.[1];
			if (ip) {
				actions.push({
					label: `复制 IP ${ip}`, primary: true, run: async () => {
						await navigator.clipboard.writeText(ip);
						new Notice(`已复制 ${ip}，去开发者平台加进 IP 白名单`);
					}
				});
			}
			actions.push(openPlatform, { ...retry, primary: !ip });
		} else if (['40001', '40125', '40013'].includes(code) || /AppSecret/.test(error)) {
			actions.push({ ...editAccount, primary: true } as typeof editAccount & { primary: boolean }, openPlatform, { ...retry, primary: false });
		} else if (code === '48001') {
			actions.push({
				label: '改用「复制到公众号」', primary: true, run: async () => {
					await this.plugin.openLivePreview('wechat');
					new Notice('点预览顶部的「复制到公众号」，再到公众号编辑器里粘贴');
				}
			}, openPlatform);
		} else if (code === '45009') {
			actions.push(copyError);
		} else if (['40007', '40009', '41005'].includes(code) || /封面/.test(error)) {
			actions.push({ label: '换封面重新发布', primary: true, run: () => this.handlePublish() }, copyError);
		} else {
			actions.push(retry, copyError);
		}
		return actions;
	}

	/** 只重推失败的那一个目标 */
	private async retryTarget(targetId: string) {
		const run = this.lastRun;
		if (!run) { new Notice('找不到上次推送的内容，请重新点「发布到草稿箱」'); return; }
		if (this.retrying.has(targetId) || this.isPublishing) return;
		this.retrying.add(targetId);
		try {
			if (targetId === X_TARGET_ID) {
				if (run.xPrepared) await this.publishToX(run.file, run.xPrepared, run.draft);
			} else {
				await this.publishToAccount(targetId, run.draft, run.html);
			}
		} finally {
			this.retrying.delete(targetId);
		}
		const all = Array.from(this.publishProgress.values());
		this.publishSummary = {
			successCount: all.filter(p => p.status === 'success').length,
			failCount: all.filter(p => p.status === 'failed').length
		};
		this.render();
	}

	/** 当前笔记 → 公众号 HTML。forCopy=true 时图片转成内嵌（复制 / 发布用），否则用本地路径（预览快） */
	async buildWechatHtml(md: MarkdownView, forCopy: boolean): Promise<string | null> {
		let content = md.getViewData();
		if (!content.trim()) return null;
		if (this.plugin.settings.excludeFrontmatter) content = this.removeFrontmatter(content);
		content = forCopy ? await this.processImageLinks(content, md) : await this.processImageLinksForPreview(content, md);
		const theme = this.themeManager.getTheme(this.selectedTheme) ?? this.themeManager.getDefaultTheme();
		const setup = this.renderSetupFor(theme);
		return MarkedFormatter.markdownToHtmlSync(content, setup.css, setup.options);
	}

	async handlePreview() {
		await this.plugin.openLivePreview('wechat');
	}

	async handlePreviewModal() {
		// Try to get active view first, then fall back to any visible markdown view
		let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!activeView) {
			// If no active markdown view, try to find any visible markdown view
			const leaves = this.app.workspace.getLeavesOfType('markdown');
			if (leaves.length > 0) {
				activeView = leaves[0].view as MarkdownView;
			}
		}

		if (!activeView) {
			new Notice('请先打开一个笔记');
			return;
		}

		let content = activeView.getViewData();
		if (!content.trim()) {
			new Notice('当前笔记内容为空');
			return;
		}
		if (this.plugin.settings.excludeFrontmatter) content = this.removeFrontmatter(content);

		// Convert images to base64 for copying
		content = await this.processImageLinks(content, activeView);

		// Get custom CSS from selected theme
		const theme = this.themeManager.getTheme(this.selectedTheme) ?? this.themeManager.getDefaultTheme();
		const setup = this.renderSetupFor(theme);

		// Convert markdown to WeChat HTML with custom CSS
		const html = MarkedFormatter.markdownToHtmlSync(content, setup.css, setup.options);

		// Show preview modal
		const title = activeView.file?.basename || '无标题';
		const exportDir = activeView.file?.parent?.path || '';
		const previewModal = new PreviewModal(this.app, html, title, exportDir);
		previewModal.open();
	}

	async handleExportLongImage(): Promise<void> {
		let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			activeView = (this.app.workspace.getLeavesOfType('markdown')[0]?.view as MarkdownView | undefined) ?? null;
		}
		if (!activeView) {
			new Notice('请先打开一个笔记');
			return;
		}
		let content = activeView.getViewData();
		if (!content.trim()) {
			new Notice('当前笔记内容为空');
			return;
		}
		if (this.plugin.settings.excludeFrontmatter) content = this.removeFrontmatter(content);
		content = await this.processImageLinks(content, activeView);
		const theme = this.themeManager.getTheme(this.selectedTheme) ?? this.themeManager.getDefaultTheme();
		const setup = this.renderSetupFor(theme);
		const html = MarkedFormatter.markdownToHtmlSync(content, setup.css, setup.options);
		const modal = new PreviewModal(
			this.app,
			html,
			activeView.file?.basename || '无标题',
			activeView.file?.parent?.path || ''
		);
		try {
			const path = await modal.exportLongImage();
			new Notice(`长图已保存：${path}`);
		} catch (error) {
			new Notice(`导出失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Process image links for preview - use resource paths instead of base64
	 */
	async processImageLinksForPreview(content: string, activeView: MarkdownView): Promise<string> {
		// Process Obsidian-style images ![[image.png]]
		const imageRegex = /!\[\[([^\]]+)\]\]/g;
		const matches = Array.from(content.matchAll(imageRegex));

		for (const match of matches) {
			const filename = match[1].split('|')[0].trim();
			const file = this.app.metadataCache.getFirstLinkpathDest(filename, activeView.file?.path || '');

			if (file && file.extension.match(/^(png|jpe?g|gif|svg|webp)$/i)) {
				// Use Obsidian resource path for preview
				const resourcePath = this.app.vault.getResourcePath(file);
				content = content.replace(match[0], `![${filename}](${resourcePath})`);
			}
		}

		// Process standard markdown images
		const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
		const mdMatches = Array.from(content.matchAll(mdImageRegex));

		for (const match of mdMatches) {
			const imagePath = match[2];

			// Skip if already absolute URL or resource path
			if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('app://')) {
				continue;
			}

			const file = this.app.metadataCache.getFirstLinkpathDest(imagePath, activeView.file?.path || '');
			if (file && file.extension.match(/^(png|jpe?g|gif|svg|webp)$/i)) {
				const resourcePath = this.app.vault.getResourcePath(file);
				content = content.replace(match[0], `![${match[1]}](${resourcePath})`);
			}
		}

		return content;
	}

	/**
	 * Process Obsidian image links and convert them to base64 data URLs
	 */
	async processImageLinks(content: string, activeView: MarkdownView): Promise<string> {
		const imageRegex = /!\[\[([^\]]+)\]\]/g;
		const matches = Array.from(content.matchAll(imageRegex));

		for (const match of matches) {
			const filename = match[1];

			// Try to find the file in the vault（去掉 |300 这类尺寸写法）
			const file = this.app.metadataCache.getFirstLinkpathDest(filename.split('|')[0].trim(), activeView.file?.path || '');

			if (file && file.extension.match(/^(png|jpe?g|gif|svg|webp)$/i)) {
				try {
					// Read file as binary
					let arrayBuffer = await this.app.vault.readBinary(file);

					// Determine mime type
					let mimeType = 'image/png';
					if (file.extension === 'jpg' || file.extension === 'jpeg') {
						mimeType = 'image/jpeg';
					} else if (file.extension === 'gif') {
						mimeType = 'image/gif';
					} else if (file.extension === 'svg') {
						mimeType = 'image/svg+xml';
					} else if (file.extension === 'webp') {
						mimeType = 'image/webp';
					}
					const compressed = await toUploadable(arrayBuffer, mimeType);
					arrayBuffer = compressed.data;
					mimeType = compressed.mimeType;
					const base64 = btoa(
						new Uint8Array(arrayBuffer)
							.reduce((data, byte) => data + String.fromCharCode(byte), '')
					);

					// Create data URL
					const dataUrl = `data:${mimeType};base64,${base64}`;

					// Replace in content
					content = content.replace(match[0], `![${filename}](${dataUrl})`);
				} catch (error) {
					console.error(`Failed to load image: ${filename}`, error);
					// Keep original if failed
				}
			}
		}

		// Also process standard markdown images with relative paths
		const mdImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
		const mdMatches = Array.from(content.matchAll(mdImageRegex));
		for (const match of mdMatches) {
			const imagePath = match[2];

			// Skip if already a data URL or absolute URL
			if (imagePath.startsWith('data:') || imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
				continue;
			}

			// Try to find the file
			const file = this.app.metadataCache.getFirstLinkpathDest(imagePath, activeView.file?.path || '');

			if (file && file.extension.match(/^(png|jpe?g|gif|svg|webp)$/i)) {
				try {
					let arrayBuffer = await this.app.vault.readBinary(file);

					let mimeType = 'image/png';
					if (file.extension === 'jpg' || file.extension === 'jpeg') {
						mimeType = 'image/jpeg';
					} else if (file.extension === 'gif') {
						mimeType = 'image/gif';
					} else if (file.extension === 'svg') {
						mimeType = 'image/svg+xml';
					} else if (file.extension === 'webp') {
						mimeType = 'image/webp';
					}
					const compressed = await toUploadable(arrayBuffer, mimeType);
					arrayBuffer = compressed.data;
					mimeType = compressed.mimeType;
					const base64 = btoa(
						new Uint8Array(arrayBuffer)
							.reduce((data, byte) => data + String.fromCharCode(byte), '')
					);

					const dataUrl = `data:${mimeType};base64,${base64}`;
					content = content.replace(match[0], `![${match[1]}](${dataUrl})`);
				} catch (error) {
					console.error(`Failed to load image: ${imagePath}`, error);
				}
			}
		}

		return content;
	}

	async handlePublish() {
		// Try to get active view first, then fall back to any visible markdown view
		let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

		if (!activeView) {
			// If no active markdown view, try to find any visible markdown view
			const leaves = this.app.workspace.getLeavesOfType('markdown');
			if (leaves.length > 0) {
				activeView = leaves[0].view as MarkdownView;
			}
		}

		if (!activeView) {
			new Notice('请先打开一个笔记');
			return;
		}

		let content = activeView.getViewData();
		if (!content.trim()) {
			new Notice('当前笔记内容为空');
			return;
		}
		const file = activeView.file;
		if (!file) {
			new Notice('请先打开一个笔记');
			return;
		}
		const wantX = this.xSelected;
		if (this.selectedAccountIds.size === 0 && !wantX) {
			new Notice('请先勾选至少一个公众号或 X');
			return;
		}
		if (this.isPublishing) return;

		// 发布前确认：标题 / 作者 / 摘要 / 封面 / 留言
		const loading = new Notice('正在准备草稿信息…', 0);
		let draft: DraftMeta | null;
		let xPrepared: XPrepared | null = null;
		try {
			if (wantX) {
				xPrepared = await prepareXDraft(this.app, file);
				this.relayOnline = await isRelayUp(this.plugin.settings);
			}
			const { meta, coverSource } = await buildDraftDefaults(this.app, {
				file,
				markdown: this.removeFrontmatter(content),
				panelCoverBase64: this.coverImage?.base64,
				autoCoverBase64: this.autoCover?.filePath === file.path ? this.autoCover.base64 : undefined,
				autoCoverSource: this.autoCover?.filePath === file.path ? this.autoCover.source : undefined,
				skipAutoDetect: this.autoCoverDismissed.has(file.path),
				defaultCoverBase64: this.plugin.settings.defaultCoverImage,
				defaultAuthor: this.plugin.settings.defaultAuthor,
				defaultOpenComment: this.plugin.settings.defaultOpenComment
			});
			loading.hide();
			const accountNames = this.plugin.settings.accounts
				.filter(a => this.selectedAccountIds.has(a.id))
				.map(a => a.name);
			draft = await new DraftConfirmModal(
				this.app, meta, coverSource, accountNames,
				xPrepared ? { report: xPrepared.report, unresolved: xPrepared.resolved.unresolved, relayOnline: !!this.relayOnline } : undefined,
				scanImages(this.app, file, content)
			).openAndWait();
		} catch (error) {
			loading.hide();
			new Notice(`准备草稿失败：${error instanceof Error ? error.message : error}`);
			return;
		}
		if (!draft) return;
		const title = draft.title;

		if (this.plugin.settings.excludeFrontmatter) content = this.removeFrontmatter(content);

		// Process Obsidian image links to base64
		content = await this.processImageLinks(content, activeView);

		// Initialize progress
		this.isPublishing = true;
		this.publishProgress.clear();
		this.publishSummary = null; // 清空之前的汇总信息

		for (const accountId of this.selectedAccountIds) {
			this.publishProgress.set(accountId, {
				accountId,
				status: 'pending'
			});
		}
		if (xPrepared) this.publishProgress.set(X_TARGET_ID, { accountId: X_TARGET_ID, status: 'pending' });

		this.render();

		// X 与公众号并行推送
		const xPromise = xPrepared ? this.publishToX(file, xPrepared, draft) : Promise.resolve(null);

		// Get custom CSS from selected theme
		const theme = this.themeManager.getTheme(this.selectedTheme) ?? this.themeManager.getDefaultTheme();
		const setup = this.renderSetupFor(theme);

		// Convert markdown to WeChat HTML with custom CSS
		const htmlContent = MarkedFormatter.markdownToHtmlSync(content, setup.css, setup.options);
		// 记下这次推送的内容，失败后可以单独「重新推送」
		this.lastRun = { file, draft, html: htmlContent, xPrepared };

		// Publish with concurrency control
		const accountIds = Array.from(this.selectedAccountIds);
		const maxConcurrent = this.plugin.settings.maxConcurrent;

		let successCount = 0;
		let failCount = 0;

		for (let i = 0; i < accountIds.length; i += maxConcurrent) {
			const batch = accountIds.slice(i, i + maxConcurrent);
			const promises = batch.map(accountId => this.publishToAccount(accountId, draft!, htmlContent));
			const results = await Promise.all(promises);

			for (const result of results) {
				if (result.success) {
					successCount++;
				} else {
					failCount++;
				}
			}
		}

		const xResult = await xPromise;
		if (xResult) {
			if (xResult.success) successCount++; else failCount++;
		}

		this.isPublishing = false;

		// 保存汇总信息
		this.publishSummary = { successCount, failCount };

		// Don't clear progress immediately - let user see the final status
		// Progress will be cleared on next publish or when user closes the view
		this.render();

		// Show summary notice (also shown in progress section now)
		new Notice(`发布完成：${successCount} 个成功，${failCount} 个失败`);

		// Save to history
		this.plugin.settings.publishHistory.unshift({
			time: new Date().toISOString(),
			articleTitle: title,
			accountIds: xPrepared ? [...accountIds, X_TARGET_ID] : accountIds,
			successCount,
			failCount
		});

		// Keep only last 100 records
		if (this.plugin.settings.publishHistory.length > 100) {
			this.plugin.settings.publishHistory = this.plugin.settings.publishHistory.slice(0, 100);
		}

		await this.plugin.saveSettings();
	}

	/**
	 * Upload images in HTML content and replace with WeChat URLs
	 */
	async uploadImagesAndReplace(htmlContent: string, accessToken: string, proxyConfig?: any): Promise<string> {
		// Extract all base64 images from HTML
		const imgRegex = /<img[^>]+src="data:image\/(jpeg|jpg|png);base64,([^"]+)"[^>]*>/g;
		const matches = Array.from(htmlContent.matchAll(imgRegex));

		let processedContent = htmlContent;
		const uploadedB64 = new Map<string, string>();

		for (let i = 0; i < matches.length; i++) {
			const match = matches[i];
			const fullMatch = match[0];
			const imageType = match[1];
			const base64Data = match[2];

			try {
				// 同一张图（例如每个章节标题前的 IP 头像）只上传一次
				const cachedUrl = uploadedB64.get(base64Data);
				if (cachedUrl) {
					processedContent = processedContent.replace(fullMatch, fullMatch.replace(`data:image/${imageType};base64,${base64Data}`, cachedUrl));
					continue;
				}
				// Convert base64 to ArrayBuffer
				const binaryString = atob(base64Data);
				const bytes = new Uint8Array(binaryString.length);
				for (let j = 0; j < binaryString.length; j++) {
					bytes[j] = binaryString.charCodeAt(j);
				}
				const imageBuffer = bytes.buffer;

				// Upload to WeChat
				const uploadResult = await uploadImage(
					imageBuffer,
					`image_${i + 1}.${imageType === 'jpeg' || imageType === 'jpg' ? 'jpg' : 'png'}`,
					accessToken,
					proxyConfig
				);

				if (uploadResult && uploadResult.url) {
					uploadedB64.set(base64Data, uploadResult.url);
					// Replace base64 image with WeChat URL
					const newImg = fullMatch.replace(
						`data:image/${imageType};base64,${base64Data}`,
						uploadResult.url
					);
					processedContent = processedContent.replace(fullMatch, newImg);
				}
			} catch (error) {
				console.error(`[UploadImages] Failed to upload image ${i + 1}:`, error);
				// 微信会过滤 base64 图片，上传失败的图片在草稿里会缺失，提示用户
				new Notice(`第 ${i + 1} 张正文图片上传失败，草稿中可能缺少这张图：${error instanceof Error ? error.message : error}`, 8000);
			}
		}

		// 网络图片（例如网页剪藏里的图片）：微信草稿不显示外链图片，下载后上传到公众号
		const remoteRegex = /<img[^>]+src="(https?:\/\/[^"]+)"[^>]*>/g;
		const remoteMatches = Array.from(processedContent.matchAll(remoteRegex));
		const uploaded = new Map<string, string>();
		for (let i = 0; i < remoteMatches.length; i++) {
			const rawSrc = remoteMatches[i][1];
			if (/^https?:\/\/mmbiz\.(qpic|qlogo)\.cn\//i.test(rawSrc) || uploaded.has(rawSrc)) continue;
			const url = rawSrc.replace(/&amp;/g, '&');
			try {
				const dataUrl = await resolveImageRef(this.app, url, '');
				if (!dataUrl) throw new Error('图片下载失败');
				const [header, b64] = dataUrl.split(',');
				const bin = atob(b64);
				const bytes = new Uint8Array(bin.length);
				for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
				const ext = header.includes('image/png') ? 'png' : 'jpg';
				const result = await uploadImage(bytes.buffer, `remote_${i + 1}.${ext}`, accessToken, proxyConfig);
				if (result?.url) uploaded.set(rawSrc, result.url);
			} catch (error) {
				console.error(`[UploadImages] Failed to upload remote image ${url}:`, error);
				new Notice(`网络图片上传失败，草稿中可能缺少这张图：${url.slice(0, 60)}`, 8000);
			}
		}
		for (const [from, to] of uploaded) {
			processedContent = processedContent.split(`src="${from}"`).join(`src="${to}"`);
		}

		return processedContent;
	}

	async publishToX(file: TFile, prepared: XPrepared, draft: DraftMeta) {
		const start = Date.now();
		this.publishProgress.set(X_TARGET_ID, { accountId: X_TARGET_ID, status: 'publishing' });
		this.render();
		try {
			await pushXDraft(this.app, this.plugin.settings, file, prepared, {
				title: draft.title,
				coverDataUrl: draft.coverBase64 || undefined
			});
			const duration = Date.now() - start;
			this.publishProgress.set(X_TARGET_ID, { accountId: X_TARGET_ID, status: 'success', duration });
			this.render();
			return { success: true };
		} catch (error) {
			const duration = Date.now() - start;
			const msg = error instanceof Error ? error.message : String(error);
			this.publishProgress.set(X_TARGET_ID, { accountId: X_TARGET_ID, status: 'failed', duration, error: msg });
			this.render();
			return { success: false };
		}
	}

	async handleXPreview() {
		await this.plugin.openLivePreview('x');
	}

	/** X 文章预览所需数据（按 Kaitox 规则解析当前笔记） */
	async buildXPreview(file: TFile) {
		const prepared = await prepareXDraft(this.app, file);
		const cover = this.coverImage?.base64
			?? (this.autoCover?.filePath === file.path && !this.autoCoverDismissed.has(file.path) ? this.autoCover.base64 : undefined);
		return { prepared, cover };
	}


	async publishToAccount(accountId: string, draft: DraftMeta, content: string) {
		const account = this.plugin.settings.accounts.find(a => a.id === accountId);
		if (!account) {
			return { success: false, duration: 0, error: '账号未找到' };
		}

		// Update progress
		this.publishProgress.set(accountId, {
			accountId,
			status: 'publishing'
		});
		this.render();

		const startTime = Date.now();

		try {
			let resolved = this.plugin.resolveAccount(account);
			if (!resolved.appsecret) {
				throw new Error('缺少 AppSecret，请在插件设置中重新保存账号');
			}
			const ensureToken = async (force = false) => {
				if (force || !resolved.accessToken || !account.tokenExpireTime || Date.now() >= account.tokenExpireTime) {
					const token = await getAccessToken(account.appid, resolved.appsecret, resolved.proxyConfig);
					this.plugin.setAccessToken(account, token);
					account.tokenExpireTime = Date.now() + 7200 * 1000;
					await this.plugin.saveSettings();
					resolved = this.plugin.resolveAccount(account);
				}
				if (!resolved.accessToken) throw new Error('无法获取 Access Token');
				return resolved.accessToken;
			};

			const pushDraft = async (accessToken: string) => {
				// 上传封面（必填，失败直接报错，不再静默跳过）
				const base64Data = draft.coverBase64.split(',')[1];
				if (!base64Data) throw new Error('封面图片数据无效，请重新选择封面');
				const binaryString = atob(base64Data);
				const bytes = new Uint8Array(binaryString.length);
				for (let i = 0; i < binaryString.length; i++) {
					bytes[i] = binaryString.charCodeAt(i);
				}
				let thumbMediaId: string;
				try {
					const ext = draft.coverBase64.startsWith('data:image/png') ? 'png' : 'jpg';
					const uploadResult = await uploadImage(bytes.buffer, `cover.${ext}`, accessToken, resolved.proxyConfig);
					thumbMediaId = uploadResult.media_id;
				} catch (uploadError) {
					if (uploadError instanceof WeixinApiError) throw uploadError;
					throw new Error(`封面上传失败：${uploadError instanceof Error ? uploadError.message : uploadError}`);
				}

				// Upload images in content and replace with WeChat URLs
				const processedContent = await this.uploadImagesAndReplace(content, accessToken, resolved.proxyConfig);

				const articles = [{
					title: draft.title,
					author: draft.author,
					digest: draft.digest,
					content: processedContent,
					content_source_url: draft.contentSourceUrl,
					thumb_media_id: thumbMediaId,
					need_open_comment: draft.openComment ? 1 : 0,
					only_fans_can_comment: draft.onlyFansCanComment ? 1 : 0
				}];

				await addDraft(articles, accessToken, resolved.proxyConfig);
			};

			try {
				await pushDraft(await ensureToken());
			} catch (error) {
				// Token 失效（例如在别处重置过 AppSecret 或刷新过 Token）时自动重取一次
				const code = error instanceof WeixinApiError ? String(error.errcode) : '';
				if (code === '40001' || code === '42001' || code === '40014') {
					await pushDraft(await ensureToken(true));
				} else {
					throw error;
				}
			}

			const duration = Date.now() - startTime;

			// Update progress
			this.publishProgress.set(accountId, {
				accountId,
				status: 'success',
				duration
			});
			this.render();

			return { success: true, duration };
		} catch (error) {
			const duration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : '发布失败';

			console.error('[Publish] Error:', error);

			// Update progress
			this.publishProgress.set(accountId, {
				accountId,
				status: 'failed',
				duration,
				error: errorMessage
			});
			this.render();

			return { success: false, duration, error: errorMessage };
		}
	}

	private removeFrontmatter(content: string): string {
		return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
	}
}

/**
 * Preview Modal - Shows formatted WeChat HTML
 */
class PreviewModal extends Modal {
	html: string;
	title: string;
	exportDir: string;

	constructor(app: App, html: string, title: string, exportDir: string) {
		super(app);
		this.html = html;
		this.title = title;
		this.exportDir = exportDir;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: '微信预览' });

		// Create preview container
		const previewContainer = contentEl.createDiv({ cls: 'wechat-preview-container' });
		previewContainer.replaceChildren(sanitizeHTMLToDom(this.html));

		// Add copy button
		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		const copyBtn = buttonContainer.createEl('button', { text: '复制', cls: 'mod-cta' });
		copyBtn.onclick = async () => {
			try {
				// Create a temporary element to hold the HTML
					const tempDiv = document.body.createDiv({ cls: 'wechat-multi-publisher-copy-buffer' });
					tempDiv.replaceChildren(sanitizeHTMLToDom(this.html));

				// Select the content
				const range = document.createRange();
				range.selectNodeContents(tempDiv);
				const selection = window.getSelection();
				if (selection) {
					selection.removeAllRanges();
					selection.addRange(range);

					// Copy to clipboard using the modern Clipboard API with HTML
					const htmlContent = tempDiv.innerHTML;
					const textContent = tempDiv.innerText;

					await navigator.clipboard.write([
						new ClipboardItem({
							'text/html': new Blob([htmlContent], { type: 'text/html' }),
							'text/plain': new Blob([textContent], { type: 'text/plain' })
						})
					]);

					copyBtn.textContent = '已复制！';
				}

				// Clean up
				document.body.removeChild(tempDiv);
				selection?.removeAllRanges();

					window.setTimeout(() => {
					copyBtn.textContent = '复制';
				}, 2000);
			} catch (error) {
				console.error('Copy failed:', error);
				copyBtn.textContent = '复制失败';
					window.setTimeout(() => {
					copyBtn.textContent = '复制';
				}, 2000);
			}
		};

		const exportBtn = buttonContainer.createEl('button', { text: '导出长图' });
		exportBtn.onclick = async () => {
			exportBtn.disabled = true;
			try {
				const path = await this.exportLongImage();
				new Notice(`长图已保存：${path}`);
			} catch (error) {
				new Notice(`导出失败：${error instanceof Error ? error.message : String(error)}`);
			} finally {
				exportBtn.disabled = false;
			}
		};

		const closeBtn = buttonContainer.createEl('button', { text: '关闭', cls: 'mod-cancel' });
		closeBtn.onclick = () => this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	async exportLongImage(): Promise<string> {
		const root = document.body.createDiv({ cls: 'wechat-multi-publisher-image-export' });
		root.replaceChildren(sanitizeHTMLToDom(this.html));
		try {
			// requestAnimationFrame may pause when Obsidian is in the background.
			await new Promise<void>(resolve => window.setTimeout(resolve, 50));
			await this.waitForImages(root);
			const width = Math.ceil(root.getBoundingClientRect().width);
			const height = Math.ceil(root.scrollHeight);
			if (!width || !height) throw new Error('预览内容为空');
			const maxScale = Math.min(32760 / width, 32760 / height, Math.sqrt(268435456 / (width * height)));
			if (maxScale < 1) throw new Error('文章太长，超出单张长图的渲染上限');
			const canvas = await html2canvas(root, {
				backgroundColor: '#ffffff',
				scale: Math.min(2, maxScale),
				useCORS: true,
				allowTaint: true,
				logging: false,
				imageTimeout: 0,
				width,
				height,
				windowWidth: Math.max(width, window.innerWidth),
				windowHeight: Math.max(height, window.innerHeight),
				scrollX: 0,
				scrollY: 0
			});
			const blob = await new Promise<Blob>((resolve, reject) => {
				canvas.toBlob(value => value ? resolve(value) : reject(new Error('生成 PNG 失败')), 'image/png');
			});
			const path = await this.availablePath('png');
			await this.app.vault.createBinary(path, await blob.arrayBuffer());
			return path;
		} finally {
			root.remove();
		}
	}

	private async waitForImages(root: HTMLElement): Promise<void> {
		await Promise.all(Array.from(root.querySelectorAll('img')).map(image => {
			if (image.complete) return image.decode?.().catch(() => undefined) ?? Promise.resolve();
			return new Promise<void>(resolve => {
				image.addEventListener('load', () => resolve(), { once: true });
				image.addEventListener('error', () => resolve(), { once: true });
			});
		}));
	}

	private async availablePath(extension: string): Promise<string> {
		const base = this.title.replace(/[\\/:*?"<>|]/g, '-').trim() || '微信文章';
		for (let index = 0; ; index += 1) {
			const filename = `${base}${index ? `-${index}` : ''}.${extension}`;
			const path = normalizePath(this.exportDir ? `${this.exportDir}/${filename}` : filename);
			if (!await this.app.vault.adapter.exists(path)) return path;
		}
	}
}
