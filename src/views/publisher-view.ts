import { App, ItemView, WorkspaceLeaf, Notice, MarkdownView, Modal, TFile, normalizePath, sanitizeHTMLToDom } from 'obsidian';
import html2canvas from 'html2canvas';
import WeChatPublisherPlugin from '../main';
import { WeChatAccount, PublishProgress, DraftMeta } from '../types';
import { DraftConfirmModal, buildDraftDefaults, detectCover, resolveImageRef } from '../modals/draft-confirm-modal';
import { MarkedFormatter } from '../utils/formatter';
import { ThemeManager } from '../utils/theme-manager';
import { getAccessToken, uploadImage, addDraft, WeixinApiError } from '../services/weixin-api';
import { compressImage } from '../utils/image';
import { isRelayUp, prepareXDraft, pushXDraft, type XPrepared } from '../x/xpush';
import { XPreviewModal } from '../x/x-preview-modal';
import { AVATAR_DATA_URI, ICON_ID } from '../brand';
import { ThemeEditorModal } from '../theme-editor/theme-editor-modal';
import { exportThemeJson, parseThemeJson, type CustomThemeDef } from '../theme-editor/custom-theme';
import { CUSTOM_THEME_PREFIX } from '../utils/theme-manager';

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
		void this.checkRelay();
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

		// Header
		const header = container.createDiv({ cls: 'publisher-header' });
		const brand = header.createDiv({ cls: 'serena-post-brand' });
		brand.createEl('img', { cls: 'serena-post-avatar', attr: { src: AVATAR_DATA_URI, alt: 'Serena' } });
		const titles = brand.createDiv();
		titles.createEl('h3', { text: 'SerenaPost' });
		titles.createDiv({ cls: 'serena-post-tagline', text: '一稿双发 · 公众号 + X' });

		// Account selection
		this.renderAccountSelection(container);

		// Cover upload
		this.renderCoverUpload(container);

		// Theme selection
		this.renderThemeSelection(container);

		// Action buttons
		this.renderActionButtons(container);

		// Progress section (shown when publishing or has summary to display)
		if (this.isPublishing || this.publishSummary) {
			this.renderPublishProgress(container);
		}
	}

	renderAccountSelection(container: HTMLElement) {
		const section = container.createDiv({ cls: 'account-selection-section' });
		section.createEl('h4', { text: '选择账号' });

		if (this.plugin.settings.accounts.length === 0) {
			this.selectedAccountIds.clear();
			section.createDiv({ cls: 'account-remark', text: '还没有公众号账号，可在插件设置里添加' });
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
		label.createDiv({
			cls: 'account-remark',
			text: online === null ? '正在检测中转…' : online ? '中转已就绪 · 需要 Chrome 里的 Kaitox 扩展' : '中转未运行：到 SerenaPost 设置打开「内置中转」'
		});
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
			new Notice(`已选择样式：${this.selectedTheme}`);
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
		section.createDiv({
			cls: 'theme-library-hint',
			text: `已内置 ${themes.filter(theme => theme.builtin).length} 套排版${customThemes.length > 0 ? `，另加载 ${customThemes.length} 套自定义排版` : '，开箱即用'}`
		});
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
		const section = container.createDiv({ cls: 'action-buttons' });

		// Preview button
		const previewBtn = section.createEl('button', { text: '预览', cls: 'preview-btn' });
		previewBtn.onclick = () => this.handlePreview();

		const xPreviewBtn = section.createEl('button', { text: 'X 预览' });
		xPreviewBtn.onclick = () => this.handleXPreview();

		const exportBtn = section.createEl('button', { text: '导出长图' });
		exportBtn.onclick = () => this.handleExportLongImage();

		// Publish button
		const publishBtn = section.createEl('button', { text: '发布到草稿箱', cls: 'publish-btn' });
		publishBtn.disabled = (this.selectedAccountIds.size === 0 && !this.xSelected) || this.isPublishing;
		publishBtn.onclick = () => this.handlePublish();
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
			header.createSpan({ cls: `status ${statusClass}`, text: statusText });
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
		}
	}

	async handlePreview() {
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
		const customCSS = theme.css;

		// Convert markdown to WeChat HTML with custom CSS
		const html = MarkedFormatter.markdownToHtmlSync(content, customCSS, { headingLabel: theme.headingLabel });

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
		const html = MarkedFormatter.markdownToHtmlSync(content, theme.css, { headingLabel: theme.headingLabel });
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
			const filename = match[1];
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

			// Try to find the file in the vault
			const file = this.app.metadataCache.getFirstLinkpathDest(filename, activeView.file?.path || '');

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
					const compressed = await compressImage(arrayBuffer, mimeType);
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
					const compressed = await compressImage(arrayBuffer, mimeType);
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
				xPrepared ? { report: xPrepared.report, unresolved: xPrepared.resolved.unresolved, relayOnline: !!this.relayOnline } : undefined
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
		const customCSS = theme.css;

		// Convert markdown to WeChat HTML with custom CSS
		const htmlContent = MarkedFormatter.markdownToHtmlSync(content, customCSS, { headingLabel: theme.headingLabel });

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

		for (let i = 0; i < matches.length; i++) {
			const match = matches[i];
			const fullMatch = match[0];
			const imageType = match[1];
			const base64Data = match[2];

			try {
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
		const file = this.currentFile ?? this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('请先打开一篇 Markdown 笔记');
			return;
		}
		const loading = new Notice('正在生成 X 预览…', 0);
		try {
			const prepared = await prepareXDraft(this.app, file);
			const cover = this.coverImage?.base64
				?? (this.autoCover?.filePath === file.path && !this.autoCoverDismissed.has(file.path) ? this.autoCover.base64 : undefined);
			loading.hide();
			new XPreviewModal(this.app, prepared.resolved, prepared.report, prepared.resolved.title, cover).open();
		} catch (error) {
			loading.hide();
			new Notice(`X 预览失败：${error instanceof Error ? error.message : error}`);
		}
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
