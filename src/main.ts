import { App, Plugin, PluginSettingTab, Setting, Notice, WorkspaceLeaf, FuzzySuggestModal, Modal, normalizePath, addIcon } from 'obsidian';
import { AVATAR_DATA_URI, ICON_ID, ICON_SVG, PLUGIN_NAME } from './brand';
import { squareAvatar } from './utils/image';
import { EmbeddedRelay } from './x/embedded-relay';
import { PluginSettings, DEFAULT_SETTINGS, WeChatAccount, ResolvedWeChatAccount, ResolvedProxyConfig } from './types';
import { PublisherView, VIEW_TYPE_PUBLISHER } from './views/publisher-view';
import { LivePreviewView, VIEW_TYPE_LIVE_PREVIEW, type PreviewMode } from './views/live-preview-view';
import { QUICK_FORMATS } from './utils/quick-format';
import { AccountModal } from './modals/account-modal';
import { KAITOX_STORE_URL, OnboardingModal } from './modals/onboarding-modal';
import { getAccessToken } from './services/weixin-api';
import { DEFAULT_BUILTIN_THEME } from './builtin-themes';
import { CUSTOM_THEME_AI_GUIDE } from './custom-theme-guide';

// 文件夹选择模态框
class FolderSuggestModal extends FuzzySuggestModal<string> {
	folderPaths: string[];
	onChoose: (path: string) => void;

	constructor(app: App, folderPaths: string[], onChoose: (path: string) => void) {
		super(app);
		this.folderPaths = folderPaths;
		this.onChoose = onChoose;
		this.setPlaceholder('输入文件夹名称进行搜索...');
	}

	getItems(): string[] {
		return this.folderPaths;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string, evt: MouseEvent | KeyboardEvent): void {
		this.onChoose(item);
	}
}

class CustomThemeGuideModal extends Modal {
	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wechatpb-theme-guide-modal');
		contentEl.createEl('h2', { text: 'AI 自定义排版示例' });
		contentEl.createEl('p', {
			text: '复制下面的完整规范发给 AI，再补充你的参考图片、品牌颜色或文章类型。AI 输出的 CSS 可以保存为 .css 文件，或放进 Markdown 的 css 代码块。'
		});
		const guide = contentEl.createEl('textarea', { cls: 'wechatpb-theme-guide-content' });
		guide.value = CUSTOM_THEME_AI_GUIDE;
		guide.readOnly = true;

		const actions = contentEl.createDiv({ cls: 'modal-button-container' });
		const copyButton = actions.createEl('button', { text: '复制给 AI', cls: 'mod-cta' });
		copyButton.onclick = async () => {
			try {
				await navigator.clipboard.writeText(CUSTOM_THEME_AI_GUIDE);
				copyButton.textContent = '已复制';
				window.setTimeout(() => copyButton.textContent = '复制给 AI', 1800);
			} catch (error) {
				console.error('Failed to copy custom theme guide:', error);
				new Notice('复制失败，请在示例框中全选复制');
			}
		};
		actions.createEl('button', { text: '关闭', cls: 'mod-cancel' }).onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class WeChatPublisherPlugin extends Plugin {
	settings: PluginSettings;
	statusCheckInterval: number | null = null;
	relay = new EmbeddedRelay();

	async onload() {
		await this.loadSettings();
		addIcon(ICON_ID, ICON_SVG);

		// 内置中转：Obsidian 开着就能推送到 X（配合 Chrome 里的 Kaitox 扩展）
		if (this.settings.embeddedRelay) {
			this.app.workspace.onLayoutReady(() => { void this.relay.start(this.settings); });
		}

		// Register the publisher view
		this.registerView(
			VIEW_TYPE_PUBLISHER,
			(leaf) => new PublisherView(leaf, this)
		);

		this.registerView(VIEW_TYPE_LIVE_PREVIEW, leaf => new LivePreviewView(leaf, this));
		this.addCommand({
			id: 'open-live-preview',
			name: '打开公众号实时预览',
			callback: () => void this.openLivePreview()
		});

		// 快捷格式：命令（可绑快捷键）+ 编辑器右键菜单
		for (const f of QUICK_FORMATS) {
			this.addCommand({ id: `format-${f.id}`, name: `格式：${f.label}`, icon: f.icon, editorCallback: (editor, ctx) => void f.run(editor, { app: this.app, file: ctx.file }) });
		}
		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
			menu.addItem(item => {
				item.setTitle('SerenaPost 快捷格式').setIcon(ICON_ID).setSection('selection');
				const sub = (item as unknown as { setSubmenu?: () => import('obsidian').Menu }).setSubmenu?.();
				const target = sub ?? menu;
				for (const f of QUICK_FORMATS) {
					target.addItem(i => i.setTitle(f.label).setIcon(f.icon).onClick(() => void f.run(editor, { app: this.app, file: info.file })));
				}
			});
		}));

		// Add ribbon icon
		this.addRibbonIcon(ICON_ID, PLUGIN_NAME, () => {
			void this.activateView();
		});

		// Add command to open publisher
		this.addCommand({
			id: 'open-publisher',
			name: '打开发布面板',
			callback: () => {
				void this.activateView();
			}
		});

		// Add settings tab
		this.addSettingTab(new WeChatPublisherSettingTab(this.app, this));

		// Start auto-check for token status
		this.startAutoCheck();
	}

	onunload() {
		this.stopAutoCheck();
		void this.relay.stop();
	}

	async loadSettings() {
		let saved = await this.loadData() as Partial<PluginSettings> | null;
		if (!saved) saved = await this.migrateFromWeChatPB();
		this.settings = {
			...DEFAULT_SETTINGS,
			...(saved ?? {}),
			accounts: saved?.accounts ?? [],
			publishHistory: saved?.publishHistory ?? [],
			customThemesEnabled: saved?.customThemesEnabled ?? Boolean(saved?.themesFolder),
			defaultTheme: !saved?.defaultTheme || saved.defaultTheme === '默认'
				? DEFAULT_BUILTIN_THEME
				: saved.defaultTheme
		};
		await this.migrateLegacySecrets();
	}

	/** 首次安装 SerenaPost 时，自动沿用旧 WeChatPB 插件的设置（账号、主题、默认作者等）。密钥在 SecretStorage 里，ID 不变，直接可用。 */
	private async migrateFromWeChatPB(): Promise<Partial<PluginSettings> | null> {
		try {
			const oldPath = normalizePath(`${this.app.vault.configDir}/plugins/wechat-multi-publisher/data.json`);
			if (!(await this.app.vault.adapter.exists(oldPath))) return null;
			const data = JSON.parse(await this.app.vault.adapter.read(oldPath)) as Partial<PluginSettings>;
			await this.saveData(data);
			new Notice('SerenaPost：已沿用 WeChatPB 的账号和设置');
			return data;
		} catch (e) {
			console.error('[SerenaPost] 迁移旧设置失败', e);
			return null;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshLivePreview();
	}

	private secretId(accountId: string, kind: 'app-secret' | 'access-token' | 'proxy-password'): string {
		const safeAccountId = accountId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
		return `wechat-multi-publisher-${safeAccountId}-${kind}`;
	}

	getAppSecret(account: WeChatAccount): string {
		return this.app.secretStorage.getSecret(account.appSecretId || this.secretId(account.id, 'app-secret')) ?? '';
	}

	getAccessToken(account: WeChatAccount): string | undefined {
		const value = this.app.secretStorage.getSecret(account.accessTokenId || this.secretId(account.id, 'access-token'));
		return value || undefined;
	}

	getProxyPassword(account: WeChatAccount): string | undefined {
		if (!account.proxyConfig) return undefined;
		const id = account.proxyConfig.passwordSecretId || this.secretId(account.id, 'proxy-password');
		const value = this.app.secretStorage.getSecret(id);
		return value || undefined;
	}

	storeAccountSecrets(account: WeChatAccount, appSecret: string, proxyPassword?: string, accessToken?: string): void {
		account.appSecretId = account.appSecretId || this.secretId(account.id, 'app-secret');
		account.accessTokenId = account.accessTokenId || this.secretId(account.id, 'access-token');
		this.app.secretStorage.setSecret(account.appSecretId, appSecret);
		if (accessToken !== undefined) {
			this.app.secretStorage.setSecret(account.accessTokenId, accessToken);
		}
		if (account.proxyConfig) {
			account.proxyConfig.passwordSecretId = account.proxyConfig.passwordSecretId || this.secretId(account.id, 'proxy-password');
			if (proxyPassword !== undefined) {
				this.app.secretStorage.setSecret(account.proxyConfig.passwordSecretId, proxyPassword);
			}
		}
	}

	setAccessToken(account: WeChatAccount, token: string): void {
		account.accessTokenId = account.accessTokenId || this.secretId(account.id, 'access-token');
		this.app.secretStorage.setSecret(account.accessTokenId, token);
		account.tokenExpireTime = Date.now() + 7200 * 1000;
	}

	resolveAccount(account: WeChatAccount): ResolvedWeChatAccount {
		const proxyConfig: ResolvedProxyConfig | undefined = account.proxyConfig ? {
			type: account.proxyConfig.type,
			host: account.proxyConfig.host,
			port: account.proxyConfig.port,
			username: account.proxyConfig.username,
			password: this.getProxyPassword(account)
		} : undefined;
		return {
			...account,
			appsecret: this.getAppSecret(account),
			accessToken: this.getAccessToken(account),
			proxyConfig
		};
	}

	deleteAccountSecrets(account: WeChatAccount): void {
		const ids = [
			account.appSecretId,
			account.accessTokenId,
			account.proxyConfig?.passwordSecretId
		].filter((id): id is string => Boolean(id));
		for (const id of ids) this.app.secretStorage.setSecret(id, '');
	}

	private async migrateLegacySecrets(): Promise<void> {
		let changed = false;
		for (const account of this.settings.accounts) {
			account.appSecretId = account.appSecretId || this.secretId(account.id, 'app-secret');
			account.accessTokenId = account.accessTokenId || this.secretId(account.id, 'access-token');
			if (account.appsecret) {
				this.app.secretStorage.setSecret(account.appSecretId, account.appsecret);
				delete account.appsecret;
				changed = true;
			}
			if (account.accessToken) {
				this.app.secretStorage.setSecret(account.accessTokenId, account.accessToken);
				delete account.accessToken;
				changed = true;
			}
			if (account.proxyConfig) {
				account.proxyConfig.passwordSecretId = account.proxyConfig.passwordSecretId || this.secretId(account.id, 'proxy-password');
				if (account.proxyConfig.password) {
					this.app.secretStorage.setSecret(account.proxyConfig.passwordSecretId, account.proxyConfig.password);
					delete account.proxyConfig.password;
					changed = true;
				}
			}
		}
		if (changed) await this.saveSettings();
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_PUBLISHER);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({
				type: VIEW_TYPE_PUBLISHER,
				active: true,
			});
		}

		if (leaf) {
				await workspace.revealLeaf(leaf);
		}

	}

	openOnboarding() {
		new OnboardingModal(this.app, this).open();
	}

	/** 引导里改了账号 / 头像后刷新侧栏 */
	refreshPublisherSidebar() {
		this.getPublisherView()?.render();
	}

	getPublisherView(): PublisherView | null {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISHER)[0];
		return (leaf?.view as PublisherView | undefined) ?? null;
	}

	/** 在笔记右边打开（或显示）实时预览 */
	async openLivePreview(mode?: PreviewMode) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_LIVE_PREVIEW)[0];
		if (!leaf) {
			const md = workspace.getMostRecentLeaf();
			if (md && md.view.getViewType() === 'markdown') workspace.setActiveLeaf(md, { focus: false });
			leaf = workspace.getLeaf('split', 'vertical');
			await leaf.setViewState({ type: VIEW_TYPE_LIVE_PREVIEW, active: false });
		}
		await workspace.revealLeaf(leaf);
		if (mode && leaf.view instanceof LivePreviewView) leaf.view.setMode(mode);
		else this.refreshLivePreview();
	}

	/** 排版 / 章节样式 / 头像 / END 改了以后刷新预览 */
	refreshLivePreview() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LIVE_PREVIEW)) {
			const view = leaf.view;
			if (view instanceof LivePreviewView) view.schedule(50);
		}
	}

	startAutoCheck() {
		if (this.statusCheckInterval) {
			window.clearInterval(this.statusCheckInterval);
		}

		this.statusCheckInterval = window.setInterval(() => {
			void this.checkAllAccountsStatus();
		}, this.settings.autoCheckInterval);
		this.registerInterval(this.statusCheckInterval);
	}

	stopAutoCheck() {
		if (this.statusCheckInterval) {
			window.clearInterval(this.statusCheckInterval);
			this.statusCheckInterval = null;
		}
	}

	async checkAllAccountsStatus() {
		for (const account of this.settings.accounts) {
			await this.checkAccountStatus(account);
		}
		await this.saveSettings();
	}

	async checkAccountStatus(account: WeChatAccount) {
		// Check if access token is expired or missing
		const resolved = this.resolveAccount(account);
		if (!resolved.accessToken || !account.tokenExpireTime || Date.now() >= account.tokenExpireTime) {
			// Try to refresh token
			try {
				if (!resolved.appsecret) throw new Error('缺少 AppSecret');
				const token = await getAccessToken(account.appid, resolved.appsecret, resolved.proxyConfig);
				this.setAccessToken(account, token);
				account.status = 'online';
				account.lastCheckTime = new Date().toISOString();
			} catch (error) {
				account.status = 'expired';
				account.lastCheckTime = new Date().toISOString();
			}
		} else {
			// Token is still valid
			account.status = 'online';
			account.lastCheckTime = new Date().toISOString();
		}
	}
}

class WeChatPublisherSettingTab extends PluginSettingTab {
	plugin: WeChatPublisherPlugin;

	constructor(app: App, plugin: WeChatPublisherPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Max concurrent publish
		new Setting(containerEl)
			.setName('最大并发发布数')
			.setDesc('同时发布的公众号数量')
			.addSlider(slider => slider
				.setLimits(1, 5, 1)
				.setValue(this.plugin.settings.maxConcurrent)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.maxConcurrent = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('排除笔记属性')
			.setDesc('排版和发布时不包含 YAML frontmatter')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.excludeFrontmatter)
				.onChange(async value => {
					this.plugin.settings.excludeFrontmatter = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('X 推送').setHeading();
		const xDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
		xDesc.appendText('推送到 X 需要在 Chrome 安装 ');
		xDesc.createEl('a', { text: 'Kaitox 扩展（Chrome 应用商店）', href: KAITOX_STORE_URL });
		xDesc.appendText(' 并登录 X。中转程序已内置，Obsidian 开着就自动运行。');

		const relayStatus = () => {
			const r = this.plugin.relay;
			return r.mode === 'embedded' ? '运行中（内置）'
				: r.mode === 'external' ? '运行中（使用已有的 Kaitox 中转）'
				: r.mode === 'error' ? `启动失败：${r.error}`
				: '未运行';
		};
		new Setting(containerEl)
			.setName('内置中转')
			.setDesc(`当前状态：${relayStatus()}`)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.embeddedRelay)
				.onChange(async value => {
					this.plugin.settings.embeddedRelay = value;
					await this.plugin.saveSettings();
					if (value) await this.plugin.relay.start(this.plugin.settings);
					else await this.plugin.relay.stop();
					this.display();
				}));

		if (this.plugin.relay.mode === 'external') {
			new Setting(containerEl)
				.setName('接管旧的 Kaitox 中转')
				.setDesc('电脑上还在运行 Kaitox 命令行中转（kaitox relay）。点「接管」会停止它，改用 SerenaPost 内置中转，以后不用再单独启动')
				.addButton(button => button
					.setButtonText('接管')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true).setButtonText('接管中…');
						const mode = await this.plugin.relay.takeOver(this.plugin.settings);
						new Notice(mode === 'embedded' ? 'SerenaPost：已改用内置中转' : `SerenaPost：接管失败（${this.plugin.relay.error || mode}）`);
						this.display();
					}));
		}

		new Setting(containerEl)
			.setName('中转程序地址')
			.setDesc('一般不用改。改了以后需要在 Kaitox 扩展设置里改成同一个地址')
			.addText(text => text
				.setPlaceholder('http://127.0.0.1:8765')
				.setValue(this.plugin.settings.relayBase)
				.onChange(async value => {
					this.plugin.settings.relayBase = value.trim() || 'http://127.0.0.1:8765';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('中转令牌（可选）')
			.setDesc('如果给 relay 配了 token，这里填一样的')
			.addText(text => text
				.setValue(this.plugin.settings.relayToken)
				.onChange(async value => {
					this.plugin.settings.relayToken = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('推送后打开 X 文章编辑器')
			.setDesc('推送成功后自动在浏览器打开 x.com 文章编辑器，Kaitox 扩展会在那里创建草稿')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.openXAfterPush)
				.onChange(async value => {
					this.plugin.settings.openXAfterPush = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('草稿默认信息').setHeading();

		new Setting(containerEl)
			.setName('推送后记住这篇文章的设置')
			.setDesc('推送成功后，把标题、作者、摘要、封面和排版写回笔记属性（title、wx_author、digest、cover、sp_theme 等），下次推送同一篇会自动沿用。')
			.addToggle(t => t.setValue(this.plugin.settings.writeBackMeta).onChange(async v => {
				this.plugin.settings.writeBackMeta = v;
				await this.plugin.saveSettings();
			}));

		new Setting(containerEl)
			.setName('默认作者')
			.setDesc('发布确认弹窗中作者栏的默认值；笔记属性 wx_author（公众号作者）优先。最多 8 个字')
			.addText(text => text
				.setPlaceholder('例如：Serena 木瓜')
				.setValue(this.plugin.settings.defaultAuthor)
				.onChange(async value => {
					this.plugin.settings.defaultAuthor = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('默认开启留言')
			.setDesc('发布确认弹窗中「开启留言」的默认状态；笔记属性 comment 优先')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.defaultOpenComment)
				.onChange(async value => {
					this.plugin.settings.defaultOpenComment = value;
					await this.plugin.saveSettings();
				}));

		const coverSetting = new Setting(containerEl)
			.setName('默认封面图片')
			.setDesc('没有临时封面时使用，最大 2 MB');
		if (this.plugin.settings.defaultCoverImage) {
			coverSetting.addButton(button => button
				.setButtonText('删除默认封面')
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.defaultCoverImage = '';
					await this.plugin.saveSettings();
					this.display();
				}));
			const preview = containerEl.createDiv({ cls: 'default-cover-preview' });
			preview.createEl('img', {
				attr: { src: this.plugin.settings.defaultCoverImage, alt: '默认封面' }
			});
		} else {
			coverSetting.addButton(button => button
				.setButtonText('上传默认封面')
				.onClick(() => this.chooseDefaultCover()));
		}

		// Auto check interval
		new Setting(containerEl)
			.setName('自动检测间隔（小时）')
			.setDesc('自动检测 Access Token 状态的时间间隔')
			.addSlider(slider => slider
				.setLimits(1, 24, 1)
				.setValue(this.plugin.settings.autoCheckInterval / 3600000)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.autoCheckInterval = value * 3600000;
					await this.plugin.saveSettings();
					this.plugin.startAutoCheck();
				}));

		new Setting(containerEl).setName('排版样式').setHeading();

		new Setting(containerEl)
			.setName('内置排版')
			.setDesc('已内置 15 套排版，开箱即用；也可以在侧栏用可视化编辑器做自己的排版。')
			.addButton(button => button
				.setButtonText('查看 AI 排版规范')
				.onClick(() => new CustomThemeGuideModal(this.app).open()));

		new Setting(containerEl)
			.setName('启用自定义排版')
			.setDesc('仅在你要导入或让 AI 设计自己的 CSS 排版时开启。关闭时只显示内置排版和你在编辑器里做的排版。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.customThemesEnabled)
				.onChange(async enabled => {
					this.plugin.settings.customThemesEnabled = enabled;
					await this.plugin.saveSettings();
					await this.refreshPublisherViews();
					this.display();
				}));

		if (this.plugin.settings.customThemesEnabled) {
			new Setting(containerEl)
				.setName('自定义样式文件夹')
				.setDesc('选择库内包含 .css 文件或 css 代码块 Markdown 的文件夹。选择后立即保存并应用。')
				.addText(text => text
					.setPlaceholder('例如：styles/wechat')
					.setValue(this.plugin.settings.themesFolder)
					.onChange(value => {
						this.plugin.settings.themesFolder = normalizePath(value);
					}))
				.addButton(button => button
					.setButtonText('选择文件夹')
					.onClick(() => {
						const folders = this.getAllFolders(this.app.vault.getRoot());
						const folderPaths = folders.map(folder => folder.path).sort();
						new FolderSuggestModal(this.app, folderPaths, async selectedPath => {
							this.plugin.settings.themesFolder = selectedPath;
							await this.plugin.saveSettings();
							await this.refreshPublisherViews();
							this.display();
							new Notice('自定义排版已加载');
						}).open();
					}))
				.addButton(button => button
					.setButtonText('应用路径')
					.setCta()
					.onClick(async () => {
						await this.plugin.saveSettings();
						await this.refreshPublisherViews();
						new Notice('自定义排版已应用');
					}));
		}

		new Setting(containerEl)
			.setName('IP 头像')
			.setDesc('「章节标题前放 IP 头像」用的图片，建议正方形 PNG/JPG。不设置就用内置的 Serena 头像。')
			.then(setting => {
				const img = setting.controlEl.createEl('img', { cls: 'sp-avatar-preview' });
				img.src = this.plugin.settings.brandAvatar || AVATAR_DATA_URI;
			})
			.addButton(button => button
				.setButtonText('换一张')
				.onClick(() => {
					const input = document.createElement('input');
					input.type = 'file';
					input.accept = 'image/png,image/jpeg';
					input.onchange = async () => {
						const f = input.files?.[0];
						if (!f) return;
						try {
							this.plugin.settings.brandAvatar = await squareAvatar(f);
							await this.plugin.saveSettings();
							await this.refreshPublisherViews();
							this.display();
						} catch (e) {
							new Notice(`头像读取失败：${e instanceof Error ? e.message : e}`);
						}
					};
					input.click();
				}))
			.addExtraButton(button => button
				.setIcon('rotate-ccw')
				.setTooltip('恢复内置头像')
				.onClick(async () => {
					this.plugin.settings.brandAvatar = '';
					await this.plugin.saveSettings();
					await this.refreshPublisherViews();
					this.display();
				}));

		new Setting(containerEl)
			.setName('文末标记文字')
			.setDesc('侧栏勾选「文末加结束标记」后显示在文章最后，例如「你的名字 · END」。侧栏里也能直接改。')
			.addText(text => text
				.setPlaceholder('你的名字 · END')
				.setValue(this.plugin.settings.endMarkText)
				.onChange(async value => {
					this.plugin.settings.endMarkText = value.slice(0, 40);
					await this.plugin.saveSettings();
				}));

		// Account management section
		new Setting(containerEl).setName('公众号账号').setHeading();

		// Add account button
		new Setting(containerEl)
			.setName('添加新账号')
			.setDesc('添加一个新的微信公众号')
			.addButton(button => button
				.setButtonText('添加账号')
				.setCta()
				.onClick(() => {
					const modal = new AccountModal(this.app, this.plugin, null, async (account) => {
						this.plugin.settings.accounts.push(account);
						await this.plugin.saveSettings();
						this.display();
						new Notice(`账号 "${account.name}" 添加成功`);
					});
					modal.open();
				}));

		// List existing accounts
		for (const account of this.plugin.settings.accounts) {
			this.displayAccountSetting(containerEl, account);
		}
	}

	private async refreshPublisherViews(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PUBLISHER);
		for (const leaf of leaves) {
			const view = leaf.view as PublisherView;
			view.themeManager.setThemesFolder(this.plugin.settings.themesFolder);
			view.themeManager.setCustomThemesEnabled(this.plugin.settings.customThemesEnabled);
			view.themeManager.setCustomDefs(this.plugin.settings.customThemes);
			await view.themeManager.loadThemes();
			const selected = view.themeManager.getTheme(view.selectedTheme) ?? view.themeManager.getDefaultTheme();
			view.selectedTheme = selected.name;
			view.render();
		}
		this.plugin.refreshLivePreview();
	}

	private chooseDefaultCover(): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = 'image/jpeg,image/png';
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;
			if (file.size > 2 * 1024 * 1024) {
				new Notice('图片大小不能超过 2 MB');
				return;
			}
			const reader = new FileReader();
			reader.onload = async () => {
				this.plugin.settings.defaultCoverImage = String(reader.result ?? '');
				await this.plugin.saveSettings();
				this.display();
			};
			reader.readAsDataURL(file);
		};
		input.click();
	}

	displayAccountSetting(containerEl: HTMLElement, account: WeChatAccount) {
		const accountDiv = containerEl.createDiv({ cls: 'wechat-account-item' });

		const statusIcon = account.status === 'online' ? '✅' :
						  account.status === 'expired' ? '⚠️' : '❌';

		new Setting(accountDiv)
			.setName(`${statusIcon} ${account.name}`)
			.setDesc(account.remark || '暂无备注')
			.addButton(button => button
				.setButtonText('编辑')
				.onClick(() => {
					const modal = new AccountModal(this.app, this.plugin, account, async (updatedAccount) => {
						const index = this.plugin.settings.accounts.findIndex(a => a.id === account.id);
						if (index !== -1) {
							this.plugin.settings.accounts[index] = updatedAccount;
							await this.plugin.saveSettings();
							this.display();
						}
					});
					modal.open();
				}))
			.addButton(button => button
				.setButtonText('刷新')
				.onClick(async () => {
					new Notice('正在刷新 Access Token...');
					await this.plugin.checkAccountStatus(account);
					await this.plugin.saveSettings();
					this.display();

					if (account.status === 'online') {
						new Notice('✅ Access Token 刷新成功');
					} else {
						new Notice('❌ Access Token 刷新失败，请检查 AppID 和 AppSecret');
					}
				}))
			.addButton(button => button
				.setButtonText('删除')
				.setWarning()
				.onClick(async () => {
					if (confirm(`确定要删除账号 "${account.name}" 吗？`)) {
						this.plugin.deleteAccountSecrets(account);
						this.plugin.settings.accounts = this.plugin.settings.accounts.filter(a => a.id !== account.id);
						await this.plugin.saveSettings();
						this.display();
						new Notice(`账号 "${account.name}" 已删除`);
					}
				}));
	}

	// 获取所有文件夹的辅助方法
	getAllFolders(folder: any): any[] {
		let folders: any[] = [];

		for (const child of folder.children) {
			if (child.children) { // 是文件夹
				folders.push(child);
				folders = folders.concat(this.getAllFolders(child));
			}
		}

		return folders;
	}
}

