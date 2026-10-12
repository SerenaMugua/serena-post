import { App, Modal, Notice, Setting } from 'obsidian';
import { WeChatAccount, ProxyConfig } from '../types';
import { checkProxyIP, getAccessToken, testProxy } from '../services/weixin-api';

const MP_URL = 'https://developers.weixin.qq.com/console/product/mp';

/** 设置项名字后面加红色 *，表示必填 */
function required(name: string): DocumentFragment {
	const frag = document.createDocumentFragment();
	frag.append(name);
	const star = document.createElement('span');
	star.className = 'sp-required';
	star.textContent = ' *';
	frag.append(star);
	return frag;
}
import WeChatPublisherPlugin from '../main';

export class AccountModal extends Modal {
	plugin: WeChatPublisherPlugin;
	account: WeChatAccount | null;
	isEdit: boolean;
	onSubmit: (account: WeChatAccount) => void;

	// Form fields
	nameInput: string = '';
	remarkInput: string = '';
	appidInput: string = '';
	appsecretInput: string = '';

	// Proxy fields
	proxyType: 'socks5' | 'http' | 'https' = 'http';
	proxyHost: string = '';
	proxyPort: number = 1080;
	proxyUsername: string = '';
	proxyPassword: string = '';

	constructor(
		app: App,
		plugin: WeChatPublisherPlugin,
		account: WeChatAccount | null,
		onSubmit: (account: WeChatAccount) => void
	) {
		super(app);
		this.plugin = plugin;
		this.account = account;
		this.isEdit = account !== null;
		this.onSubmit = onSubmit;

		// Load existing values if editing
		if (this.isEdit && account) {
			this.nameInput = account.name;
			this.remarkInput = account.remark || '';
			this.appidInput = account.appid;
			this.appsecretInput = '';

			if (account.proxyConfig) {
				this.proxyType = account.proxyConfig.type;
				this.proxyHost = account.proxyConfig.host;
				this.proxyPort = account.proxyConfig.port;
				this.proxyUsername = account.proxyConfig.username || '';
				this.proxyPassword = '';
			}
		}
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.setTitle(this.isEdit ? '编辑账号' : '添加新账号');
		this.modalEl.addClass('sp-account-modal');

		const intro = contentEl.createDiv({ cls: 'sp-account-intro' });
		intro.createDiv({ text: '带红色 * 的必须填。AppID 和 AppSecret 都在微信开发者平台「我的业务与服务 → 公众号 → 基础信息」页面里。' });
		const introLink = intro.createEl('a', { text: '打开微信开发者平台', href: MP_URL });
		introLink.addEventListener('click', e => { e.preventDefault(); window.open(MP_URL); });

		// Account Name
		new Setting(contentEl)
			.setName(required('账号名称'))
			.setDesc('自己起的名字，方便在侧栏里认出来，比如公众号的名字')
			.addText(text => text
				.setPlaceholder('我的公众号')
				.setValue(this.nameInput)
				.onChange((value) => {
					this.nameInput = value;
				}));

		// Remark
		new Setting(contentEl)
			.setName('备注')
			.setDesc('可选的说明或注释')
			.addTextArea(text => text
				.setPlaceholder('账号用途说明...')
				.setValue(this.remarkInput)
				.onChange((value) => {
					this.remarkInput = value;
				}));

		// AppID
		new Setting(contentEl)
			.setName(required('AppID'))
			.setDesc('「基础信息」页里的 AppID，以 wx 开头，旁边有复制按钮')
			.addText(text => text
				.setPlaceholder('请输入公众号 AppID')
				.setValue(this.appidInput)
				.onChange((value) => {
					this.appidInput = value;
				}));

		// AppSecret
		const savedSecret = this.isEdit && this.account ? this.plugin.hasAppSecret(this.account) : false;
		const secretDesc = createFragment(f => {
			if (this.isEdit) {
				if (savedSecret) {
					f.createSpan({ cls: 'sp-status-ok', text: '✅ 已保存在本机（Obsidian 钥匙串）。' });
					f.appendText('为了安全不会显示出来，这里空着是正常的，不用重填。只有在微信那边点过「重置」，才需要填新的。');
				} else {
					f.createSpan({ cls: 'sp-status-bad', text: '还没保存 AppSecret，请填写。' });
				}
			} else {
				f.appendText('同一页「开发密钥」里点「重置」获取。微信后台不会再显示 AppSecret，重置后旧的会马上失效，所以拿到后直接填进来。只保存在你的电脑上（Obsidian 钥匙串）。');
			}
		});
		new Setting(contentEl)
			.setName(required('AppSecret'))
			.setDesc(secretDesc)
			.addText(text => {
				text.setPlaceholder(savedSecret ? '已保存，不用重填' : '请输入 AppSecret')
					.setValue(this.appsecretInput)
					.onChange((value) => {
						this.appsecretInput = value;
					});
				text.inputEl.type = 'password';
			});

		// IP 白名单：不在这里填，要去微信那边加
		const ipSetting = new Setting(contentEl)
			.setName(required('IP 白名单（在微信那边设置）'))
			.setDesc('这一项不在这里填。把下面的本机 IP 复制下来，加到微信开发者平台同一页「开发密钥 → API IP 白名单」里，过几分钟再点「测试 API 配置」。');
		ipSetting.settingEl.addClass('sp-account-ip');
		const ipLine = ipSetting.descEl.createDiv({ cls: 'sp-account-ip-line' });
		ipLine.appendText('本机出口 IP：');
		const ipValue = ipLine.createEl('code', { text: '检测中…' });
		let ip = '';
		ipSetting.addButton(button => button
			.setButtonText('复制 IP')
			.onClick(async () => {
				if (!ip) { new Notice('还没检测到 IP，稍等一下'); return; }
				await navigator.clipboard.writeText(ip);
				new Notice(`已复制 ${ip}`);
			}));
		void checkProxyIP().then(found => {
			ip = found && found !== 'unknown' ? found : '';
			ipValue.setText(ip || '检测失败，可以先保存，推送失败时提示里会显示 IP');
		});

		// Test API Configuration button
		new Setting(contentEl)
			.setName('测试 API 配置')
			.setDesc('检查 AppID、AppSecret 和 IP 白名单是否都设置好了')
			.addButton(button => button
				.setButtonText('测试 API')
				.onClick(async () => {
					await this.testAccessToken();
				}));

		// Proxy section header
		new Setting(contentEl).setName('代理配置（可选，一般不用填）').setHeading();

		// Proxy Type
		new Setting(contentEl)
			.setName('代理类型')
			.setDesc('选择代理协议类型')
			.addDropdown(dropdown => dropdown
				.addOption('http', 'HTTP（推荐，支持认证）')
				.addOption('https', 'HTTPS（支持认证）')
				.addOption('socks5', 'SOCKS5（不支持认证）')
				.setValue(this.proxyType)
				.onChange((value: 'socks5' | 'http' | 'https') => {
					this.proxyType = value;
				}));

		// Proxy Host
		new Setting(contentEl)
			.setName('代理服务器地址')
			.setDesc('可选：代理服务器地址（如：c1023.ips5.vip）留空则使用本地网络')
			.addText(text => text
				.setPlaceholder('c1023.ips5.vip')
				.setValue(this.proxyHost)
				.onChange((value) => {
					this.proxyHost = value;
				}));

		// Proxy Port
		new Setting(contentEl)
			.setName('代理端口')
			.setDesc('可选：代理服务器端口（如：9125）')
			.addText(text => text
				.setPlaceholder('9125')
				.setValue(this.proxyPort.toString())
				.onChange((value) => {
					const port = parseInt(value);
					if (!isNaN(port)) {
						this.proxyPort = port;
					}
				}));

		// Proxy Username (conditional)
		const isAuthSupported = this.proxyType === 'http' || this.proxyType === 'https';
		new Setting(contentEl)
			.setName('代理用户名')
			.setDesc(isAuthSupported ? '可选：代理服务器认证用户名' : '❌ SOCKS5 代理不支持认证')
			.addText(text => text
				.setPlaceholder('用户名')
				.setValue(this.proxyUsername)
				.setDisabled(!isAuthSupported)
				.onChange((value) => {
					this.proxyUsername = value;
				}));

		// Proxy Password (conditional)
		new Setting(contentEl)
			.setName('代理密码')
			.setDesc(isAuthSupported ? (this.isEdit ? '留空表示保留现有代理密码' : '可选：代理服务器认证密码') : 'SOCKS5 代理不支持认证')
			.addText(text => {
				text.setPlaceholder('密码')
					.setValue(this.proxyPassword)
					.setDisabled(!isAuthSupported)
					.onChange((value) => {
						this.proxyPassword = value;
					});
				text.inputEl.type = 'password';
			});

		// Test proxy button
		new Setting(contentEl)
			.setName('测试代理连接')
			.setDesc('验证代理配置是否正常工作')
			.addButton(button => button
				.setButtonText('测试连接')
				.onClick(async () => {
					await this.testProxyConnection();
				}));

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		buttonContainer.createEl('button', { text: '取消', cls: 'mod-cancel' })
			.addEventListener('click', () => {
				this.close();
			});

		const saveButton = buttonContainer.createEl('button', {
			text: this.isEdit ? '保存修改' : '保存',
			cls: 'mod-cta'
		});
		saveButton.addEventListener('click', async () => {
			await this.handleSave();
		});
	}

	async testProxyConnection() {
		if (!this.proxyHost || !this.proxyPort) {
			new Notice('代理未配置，将使用本地网络连接');
			return;
		}

		const proxyConfig: ProxyConfig = {
			type: this.proxyType,
			host: this.proxyHost,
			port: this.proxyPort,
			username: this.proxyUsername || undefined,
			password: this.proxyPassword || undefined
		};

		new Notice('正在测试代理连接...');

		const response = await testProxy(proxyConfig);

		if (response.success) {
			new Notice(`✅ 代理连接成功！延迟：${response.latency}ms`);
		} else {
			new Notice(`❌ 代理连接失败：${response.error}`);
		}
	}

	async testAccessToken() {
		if (!this.appidInput.trim()) {
			new Notice('请输入 AppID');
			return;
		}

		const appSecret = this.appsecretInput.trim() || (this.account ? this.plugin.getAppSecret(this.account) : '');
		if (!appSecret) {
			new Notice('请输入 AppSecret');
			return;
		}

		let proxyConfig: ProxyConfig | undefined = undefined;
		if (this.proxyHost && this.proxyPort) {
			proxyConfig = {
				type: this.proxyType,
				host: this.proxyHost,
				port: this.proxyPort,
				username: this.proxyUsername || undefined,
				password: this.proxyPassword || (this.account ? this.plugin.getProxyPassword(this.account) : undefined)
			};
		}

		new Notice('正在测试 Access Token...');

		try {
			const token = await getAccessToken(
				this.appidInput.trim(),
				appSecret,
				proxyConfig
			);

			if (!token) throw new Error('微信接口未返回 Access Token');
			new Notice('✅ Access Token 获取成功');
		} catch (error) {
			new Notice(`❌ 获取 Access Token 失败：${error.message}`);
		}
	}

	async handleSave() {
		// Validate required fields
		if (!this.nameInput.trim()) {
			new Notice('请填写账号名称（带红色 * 的是必填）');
			return;
		}

		if (!this.appidInput.trim()) {
			new Notice('请填写 AppID（带红色 * 的是必填）');
			return;
		}

		const appSecret = this.appsecretInput.trim() || (this.account ? this.plugin.getAppSecret(this.account) : '');
		if (!appSecret) {
			new Notice('请填写 AppSecret（带红色 * 的是必填）');
			return;
		}

		// Build proxy config (optional)
		let proxyConfig: ProxyConfig | undefined = undefined;
		if (this.proxyHost && this.proxyPort) {
			proxyConfig = {
				type: this.proxyType,
				host: this.proxyHost,
				port: this.proxyPort,
				username: this.proxyUsername || undefined,
				passwordSecretId: this.account?.proxyConfig?.passwordSecretId
			};
		}

		// Create account object
		const account: WeChatAccount = {
			id: this.account?.id || `account-${Date.now()}`,
			name: this.nameInput.trim(),
			remark: this.remarkInput.trim() || undefined,
			appid: this.appidInput.trim(),
			appSecretId: this.account?.appSecretId || '',
			accessTokenId: this.account?.accessTokenId,
			proxyConfig,
			status: 'offline',
			lastCheckTime: this.account?.lastCheckTime
		};

		const proxyPassword = this.proxyPassword || (this.account ? this.plugin.getProxyPassword(this.account) : undefined);

		// 先把 AppSecret 存进钥匙串，不管下面能不能连上微信。
		// 以前是「连上了才保存」：IP 还没加白名单时连不上，密钥就没存，关掉窗口后只能重填（微信又只显示一次，只好去重置）
		this.plugin.storeAccountSecrets(account, appSecret, proxyPassword);

		new Notice('已保存，正在检测能不能连上微信…');
		try {
			const token = await getAccessToken(
				account.appid,
				appSecret,
				proxyConfig ? { ...proxyConfig, password: proxyPassword } : undefined
			);
			this.plugin.setAccessToken(account, token);
			account.status = 'online';
			delete account.lastError;
			new Notice('✅ 账号已保存，连接成功，可以推送');
		} catch (error) {
			account.status = 'expired';
			account.lastError = error instanceof Error ? error.message : String(error);
			new Notice(`账号和 AppSecret 已保存，但现在连不上微信：${account.lastError}\n改好以后点「检测连接」就行，不用重填 AppSecret。`, 12000);
		}
		this.onSubmit(account);
		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
