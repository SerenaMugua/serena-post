import type { CustomThemeDef } from '../theme-editor/custom-theme';

export interface ProxyConfig {
	type: 'socks5' | 'http' | 'https';
	host: string;
	port: number;
	username?: string;
	passwordSecretId?: string;
	/** @deprecated Migrated to Obsidian SecretStorage on first load. */
	password?: string;
}

export interface WeChatAccount {
	id: string;
	name: string;
	remark?: string;
	appid: string;
	appSecretId: string;
	proxyConfig?: ProxyConfig;
	accessTokenId?: string;
	tokenExpireTime?: number;
	lastCheckTime?: string;
	status: 'online' | 'expired' | 'offline' | 'error';
	/** @deprecated Migrated to Obsidian SecretStorage on first load. */
	appsecret?: string;
	/** @deprecated Migrated to Obsidian SecretStorage on first load. */
	accessToken?: string;
}

export interface ResolvedProxyConfig extends Omit<ProxyConfig, 'passwordSecretId'> {
	password?: string;
}

export interface ResolvedWeChatAccount extends Omit<WeChatAccount, 'proxyConfig'> {
	appsecret: string;
	accessToken?: string;
	proxyConfig?: ResolvedProxyConfig;
}

export interface PublishHistory {
	time: string;
	articleTitle: string;
	accountIds: string[];
	successCount: number;
	failCount: number;
}

export interface PluginSettings {
	accounts: WeChatAccount[];
	publishHistory: PublishHistory[];
	maxConcurrent: number;
	autoCheckInterval: number;
	themesFolder: string;      // CSS主题文件夹路径
	customThemesEnabled: boolean;
	defaultTheme: string;      // 默认选中的主题名称
	excludeFrontmatter: boolean;
	defaultCoverImage: string;
	defaultAuthor: string;        // 草稿默认作者
	defaultOpenComment: boolean;  // 草稿默认开启留言
	// X 推送（Kaitox）
	relayBase: string;
	relayToken: string;
	openXAfterPush: boolean;
	xSelected: boolean;           // 侧边栏是否勾选「X 文章草稿」
	embeddedRelay: boolean;       // 是否在 Obsidian 内运行中转
	customThemes: CustomThemeDef[]; // 可视化编辑器保存的排版
	headingStyle: string;         // 章节样式，'theme' = 跟随排版
	headingAvatar: boolean;       // 二级标题前放 IP 头像
	brandAvatar: string;          // 自定义 IP 头像（data URL），空 = 内置 Serena 头像
	endMark: boolean;             // 文末 END 标记
	endMarkText: string;
	onboardingDone: boolean;      // 新手引导看过了
	collapsedCards: string[];     // 侧栏折叠的分组
}

export const DEFAULT_SETTINGS: PluginSettings = {
	accounts: [],
	publishHistory: [],
	maxConcurrent: 3,
	autoCheckInterval: 3600000, // 1 hour
	themesFolder: '',
	customThemesEnabled: false,
	defaultTheme: '绿白清简',
	excludeFrontmatter: false,
	defaultCoverImage: '',
	defaultAuthor: '',
	defaultOpenComment: false,
	relayBase: 'http://127.0.0.1:8765',
	relayToken: '',
	openXAfterPush: true,
	xSelected: false,
	embeddedRelay: true,
	customThemes: [],
	headingStyle: 'theme',
	headingAvatar: false,
	brandAvatar: '',
	endMark: false,
	endMarkText: 'END',
	onboardingDone: false,
	collapsedCards: []
};

/** 发布前确认弹窗里填写的草稿信息 */
export interface DraftMeta {
	title: string;
	author: string;
	digest: string;
	contentSourceUrl: string;
	coverBase64: string;
	openComment: boolean;
	onlyFansCanComment: boolean;
}

export interface PublishRequest {
	accountId: string;
	title: string;
	content: string;
	cover?: {
		path?: string;
		base64?: string;
	};
	appid: string;
	appsecret: string;
	proxyConfig?: ProxyConfig;
}

export interface PublishResponse {
	success: boolean;
	duration: number;
	error?: string;
	errorCode?: string;
}

export type AccountStatus = 'idle' | 'pending' | 'publishing' | 'success' | 'failed';

export interface PublishProgress {
	accountId: string;
	status: AccountStatus;
	duration?: number;
	error?: string;
}
