/**
 * 新手引导：第一次打开 SerenaPost 时弹出，一步步带用户把公众号、X、品牌设置好。
 * 每一步都会检测当前状态（已完成会打勾），可以随时关掉，之后在侧栏「新手引导」里再打开。
 */
import { App, Modal, Notice, setIcon } from 'obsidian';
import type WeChatPublisherPlugin from '../main';
import { AccountModal } from './account-modal';
import { checkDraftPermission, checkProxyIP, getAccessToken } from '../services/weixin-api';
import { isRelayUp } from '../x/xpush';
import { AVATAR_DATA_URI } from '../brand';
import { squareAvatar } from '../utils/image';

const MP_URL = 'https://developers.weixin.qq.com/console/product/mp';
export const KAITOX_STORE_URL = 'https://chromewebstore.google.com/detail/kaitox/ljefnciiojdefgpnphihcijfdmbdomll';

type StepState = 'done' | 'todo' | 'warn' | 'optional';

export class OnboardingModal extends Modal {
	private ip = '';
	private accountCheck: { ok: boolean; message: string } | null = null;
	/** 草稿箱接口权限：null = 还没检测 */
	private draftPerm: { ok: boolean; message: string } | null = null;
	private relayOnline: boolean | null = null;

	constructor(app: App, private plugin: WeChatPublisherPlugin) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass('sp-onboarding');
		this.titleEl.setText('欢迎使用 SerenaPost');
		this.render();
		void this.probe();
	}

	onClose() {
		this.contentEl.empty();
		if (!this.plugin.settings.onboardingDone) {
			this.plugin.settings.onboardingDone = true;
			void this.plugin.saveSettings();
		}
	}

	/** 后台检测：出口 IP、账号能否连通、X 中转是否在运行 */
	private async probe() {
		const st = this.plugin.settings;
		const [ip, relay] = await Promise.all([
			checkProxyIP().catch(() => ''),
			isRelayUp(st).catch(() => false)
		]);
		this.ip = ip && ip !== 'unknown' ? ip : '';
		this.relayOnline = relay;
		if (st.accounts.length > 0 && !this.accountCheck) await this.testAccount(false);
		this.render();
	}

	private async testAccount(rerender = true) {
		const account = this.plugin.settings.accounts[0];
		if (!account) return;
		try {
			const resolved = this.plugin.resolveAccount(account);
			if (!resolved.appsecret) throw new Error('缺少 AppSecret，请编辑账号重新填写');
			const token = await getAccessToken(account.appid, resolved.appsecret, resolved.proxyConfig);
			this.plugin.setAccessToken(account, token);
			account.status = 'online';
			await this.plugin.saveSettings();
			this.accountCheck = { ok: true, message: `「${account.name}」连接成功` };
			try {
				const perm = await checkDraftPermission(token, resolved.proxyConfig);
				this.draftPerm = perm.ok
					? { ok: true, message: '有草稿箱权限，可以一键推送草稿' }
					: perm.errcode === '48001'
						? { ok: false, message: '这个号没有草稿箱接口权限（未认证的个人号常见），不能自动推草稿。但可以先用预览里的「复制到公众号」，再到公众号编辑器里粘贴，排版会保留。' }
						: { ok: false, message: perm.message ?? '检查草稿箱权限失败' };
			} catch (e) {
				this.draftPerm = null;
			}
		} catch (e) {
			this.accountCheck = { ok: false, message: e instanceof Error ? e.message : String(e) };
			this.draftPerm = null;
		}
		if (rerender) this.render();
	}

	private render() {
		const st = this.plugin.settings;
		const el = this.contentEl;
		el.empty();
		const hero = el.createDiv({ cls: 'sp-ob-hero' });
		hero.createEl('img', { cls: 'sp-ob-hero-avatar', attr: { src: AVATAR_DATA_URI, alt: '' } });
		const heroText = hero.createDiv();
		heroText.createDiv({ cls: 'sp-ob-hero-title', text: '3 分钟设置好，之后一键发布' });
		rich(heroText.createDiv({ cls: 'sp-ob-intro' }),
			'设置一次，写完笔记就能推到**公众号草稿箱**和 **X 文章草稿**。只用一个平台也可以，跳过另一个就好。');

		// 1. 添加公众号
		const hasAccount = st.accounts.length > 0;
		const s1 = this.step(1, '添加公众号', hasAccount ? 'done' : 'todo',
			hasAccount
				? `已添加：${st.accounts.map(a => a.name).join('、')}`
				: '需要公众号的 **AppID** 和 **AppSecret**：登录**微信开发者平台**，点顶部「**我的业务与服务 → 公众号**」，在「**基础信息**」里就能看到。AppSecret 只保存在你的电脑上。');
		const b1 = s1.createDiv({ cls: 'sp-ob-actions' });
		this.button(b1, hasAccount ? '再添加一个' : '添加公众号', !hasAccount, () => {
			new AccountModal(this.app, this.plugin, null, async account => {
				this.plugin.settings.accounts.push(account);
				await this.plugin.saveSettings();
				this.plugin.refreshPublisherSidebar();
				new Notice(`账号「${account.name}」添加成功`);
				this.accountCheck = null;
				await this.testAccount(false);
				this.render();
			}).open();
		});
		this.button(b1, '打开微信开发者平台', false, () => { window.open(MP_URL); });

		// 2. IP 白名单
		const check = this.accountCheck;
		const s2state: StepState = !hasAccount ? 'todo' : check?.ok ? (this.draftPerm && !this.draftPerm.ok ? 'warn' : 'done') : check ? 'warn' : 'todo';
		const s2 = this.step(2, '把本机 IP 加进公众号白名单', s2state,
			'微信只接受**白名单里的电脑**推送。在微信开发者平台同一个「**基础信息**」页的开发信息里找到「**IP 白名单**」，把下面这个 IP 加进去，等几分钟再点「**检测连接**」。');
		const ipRow = s2.createDiv({ cls: 'sp-ob-ip' });
		ipRow.createSpan({ text: '本机出口 IP：' });
		ipRow.createEl('strong', { cls: 'sp-ob-ip-value', text: this.ip || '检测中…' });
		const b2 = s2.createDiv({ cls: 'sp-ob-actions' });
		this.button(b2, '复制 IP', !check?.ok, async () => {
			if (!this.ip) { new Notice('还没检测到 IP，稍等一下'); return; }
			await navigator.clipboard.writeText(this.ip);
			new Notice(`已复制 ${this.ip}`);
		});
		if (hasAccount) {
			this.button(b2, '检测连接', false, async btn => {
				btn.setText('检测中…');
				btn.disabled = true;
				await this.testAccount();
			});
		}
		if (check) s2.createDiv({ cls: `sp-ob-result ${check.ok ? 'is-ok' : 'is-bad'}`, text: check.message });
		const perm = this.draftPerm;
		if (check?.ok && perm) {
			const box = s2.createDiv({ cls: `sp-ob-result ${perm.ok ? 'is-ok' : 'is-bad'}` });
			box.setText(perm.message);
			if (!perm.ok) {
				const b = s2.createDiv({ cls: 'sp-ob-actions' });
				this.button(b, '打开预览（复制到公众号）', true, async () => {
					this.close();
					await this.plugin.openLivePreview('wechat');
				});
			}
		}
		s2.createDiv({ cls: 'sp-ob-tip', text: '家里的网络 IP 可能会变；开了代理的话，以这里显示的 IP 为准。' });

		// 3. X（可选）
		const relay = this.relayOnline;
		const s3 = this.step(3, '推到 X 文章（可选）', relay ? 'done' : 'optional',
			'在 Chrome 应用商店安装 **Kaitox 扩展**（点下面的按钮，再点「添加至 Chrome」），然后在 Chrome 里登录 X 就行。本地中转已经**内置**在插件里，Obsidian 开着就会自动运行。');
		s3.createDiv({
			cls: `sp-ob-result ${relay ? 'is-ok' : 'is-muted'}`,
			text: relay === null ? '正在检测中转…' : relay ? '中转已就绪' : '中转还没运行：可以到「设置 → SerenaPost → X 推送」打开「内置中转」'
		});
		const b3 = s3.createDiv({ cls: 'sp-ob-actions' });
		this.button(b3, '去 Chrome 应用商店安装 Kaitox', false, () => { window.open(KAITOX_STORE_URL); });

		// 4. 品牌
		const branded = Boolean(st.brandAvatar) || st.headingAvatar || st.endMark;
		const s4 = this.step(4, '换上你的 IP（可选）', branded ? 'done' : 'optional',
			'上传你的**头像**，章节标题前会显示它；文末还可以加一句**结束标记**，比如「你的名字 · END」。');
		const brandRow = s4.createDiv({ cls: 'sp-ob-brand' });
		const img = brandRow.createEl('img', { cls: 'sp-ob-avatar' });
		img.src = st.brandAvatar || AVATAR_DATA_URI;
		const input = brandRow.createEl('input', { type: 'file', cls: 'hidden-input' });
		input.accept = 'image/png,image/jpeg';
		this.button(brandRow, st.brandAvatar ? '换一张头像' : '上传头像', false, () => input.click());
		input.onchange = async () => {
			const f = input.files?.[0];
			if (!f) return;
			try {
				st.brandAvatar = await squareAvatar(f);
				st.headingAvatar = true;
				await this.plugin.saveSettings();
				this.plugin.refreshPublisherSidebar();
				this.render();
			} catch (e) {
				new Notice(`头像读取失败：${e instanceof Error ? e.message : e}`);
			}
		};
		const endRow = s4.createDiv({ cls: 'sp-ob-end' });
		endRow.createSpan({ text: '结束标记：' });
		const endInput = endRow.createEl('input', { type: 'text' });
		endInput.placeholder = '你的名字 · END';
		endInput.value = st.endMark ? st.endMarkText : '';
		endInput.onchange = async () => {
			const v = endInput.value.trim();
			st.endMark = Boolean(v);
			if (v) st.endMarkText = v.slice(0, 40);
			await this.plugin.saveSettings();
			this.plugin.refreshPublisherSidebar();
		};

		// 5. 试一下
		const s5 = this.step(5, '打开一篇笔记试试', 'optional',
			'点「**打开预览**」，右边会实时显示文章在公众号 / X 上的样子；选中文字还能一键设成**章节标题**、**表格**。满意了就点侧栏底部的「**发布到草稿箱**」。');
		const b5 = s5.createDiv({ cls: 'sp-ob-actions' });
		this.button(b5, '打开预览', true, async () => {
			this.close();
			await this.plugin.openLivePreview('wechat');
		});

		const foot = el.createDiv({ cls: 'sp-ob-foot' });
		foot.createSpan({ cls: 'sp-ob-foot-tip', text: '以后可以在侧栏顶部的「新手引导」再打开这里。' });
		this.button(foot, '完成', false, () => this.close());
	}

	private step(n: number, title: string, state: StepState, desc: string): HTMLElement {
		const box = this.contentEl.createDiv({ cls: `sp-ob-step is-${state}` });
		const head = box.createDiv({ cls: 'sp-ob-step-head' });
		const badge = head.createSpan({ cls: 'sp-ob-badge' });
		if (state === 'done') setIcon(badge, 'check');
		else if (state === 'warn') setIcon(badge, 'alert-triangle');
		else badge.setText(String(n));
		head.createSpan({ cls: 'sp-ob-step-title', text: title });
		if (state === 'optional') head.createSpan({ cls: 'sp-ob-tag', text: '可选' });
		rich(box.createDiv({ cls: 'sp-ob-desc' }), desc);
		return box;
	}

	private button(parent: HTMLElement, text: string, cta: boolean, onClick: (btn: HTMLButtonElement) => void | Promise<void>) {
		const btn = parent.createEl('button', { text, cls: cta ? 'mod-cta' : '' });
		btn.onclick = () => void onClick(btn);
		return btn;
	}
}

/** 简单富文本：**加粗** 显示成 Serena 蓝色重点 */
function rich(el: HTMLElement, text: string) {
	text.split(/(\*\*[^*]+\*\*)/).forEach(part => {
		if (part.startsWith('**') && part.endsWith('**')) el.createEl('strong', { cls: 'sp-ob-em', text: part.slice(2, -2) });
		else if (part) el.appendText(part);
	});
}
