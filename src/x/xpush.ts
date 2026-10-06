/**
 * X（Twitter）文章草稿推送 —— 移植自 Kaitox for Obsidian（MIT）。
 *
 * 流程：解析笔记 → POST 到本地 Kaitox relay 队列 → Chrome 里的 Kaitox 扩展
 * 在已登录的 x.com 会话中接力创建文章草稿。插件本身不碰 X 账号和密钥。
 */
import { App, TFile, requestUrl } from 'obsidian';
import { HttpRelayClient, DEFAULT_RELAY_BASE } from '../../vendor/kaitox/relay-protocol/index';
import type { DraftAssetInput, StyleReport } from '../../vendor/kaitox/relay-protocol/index';
import { checkMarkdownStyle, makeCoverAsset } from '../../vendor/kaitox/x-article/index';
import { resolveActiveNote, type Resolved } from './resolve';

export { DEFAULT_RELAY_BASE };

export interface XSettings {
	relayBase: string;
	relayToken: string;
	openXAfterPush: boolean;
}

export const X_ARTICLE_COMPOSE_URL = 'https://x.com/compose/articles';

export function xArticleComposeUrl(draftId?: string): string {
	if (!draftId) return X_ARTICLE_COMPOSE_URL;
	const url = new URL(X_ARTICLE_COMPOSE_URL);
	url.searchParams.set('kaitoxAutoUpload', '1');
	url.searchParams.set('kaitoxDraftId', draftId);
	return url.toString();
}

/** 在系统浏览器里打开 X 文章编辑器（扩展会在那里接力创建草稿）。 */
export function openXComposer(draftId?: string): void {
	window.open(xArticleComposeUrl(draftId), '_blank');
}

/** 走 Obsidian requestUrl 的 relay 客户端（绕过 CORS）。 */
export function makeRelayClient(s: XSettings): HttpRelayClient {
	const relayFetch = async (url: string, init: any = {}) => {
		const res = await requestUrl({
			url: String(url),
			method: init.method ?? 'GET',
			headers: init.headers,
			body: init.body,
			throw: false,
		});
		return {
			ok: res.status >= 200 && res.status < 300,
			status: res.status,
			async text() { return res.text; },
			async json() { return res.json; },
			async arrayBuffer() { return res.arrayBuffer; },
		};
	};
	return new HttpRelayClient(s.relayBase || DEFAULT_RELAY_BASE, {
		fetchImpl: relayFetch as any,
		token: s.relayToken || undefined,
	});
}

/** relay 是否在运行（GET /health）。 */
export async function isRelayUp(s: XSettings): Promise<boolean> {
	try {
		const base = (s.relayBase || DEFAULT_RELAY_BASE).replace(/\/+$/, '');
		const res = await requestUrl({ url: `${base}/health`, method: 'GET', throw: false });
		return res.status === 200 && res.json?.ok === true;
	} catch {
		return false;
	}
}

export interface XPrepared {
	resolved: Resolved;
	report: StyleReport;
}

/** 解析笔记并做 X 样式检查（推送和预览共用）。 */
export async function prepareXDraft(app: App, file: TFile): Promise<XPrepared> {
	const resolved = await resolveActiveNote(app, file);
	const report = checkMarkdownStyle(resolved.body, { assetMap: resolved.assetMap });
	return { resolved, report };
}

/** data URL → X 封面资产（与公众号共用同一张封面）。 */
export function coverFromDataUrl(dataUrl: string, taken: Set<string>): DraftAssetInput | undefined {
	const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
	if (!m) return undefined;
	const bin = atob(m[2]);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const ext = m[1].includes('png') ? 'png' : 'jpg';
	return makeCoverAsset(bytes, m[1], `cover.${ext}`, taken);
}

/** 推送到 relay 队列，返回草稿 id。 */
export async function pushXDraft(
	app: App,
	s: XSettings,
	file: TFile,
	prepared: XPrepared,
	opts: { title: string; coverDataUrl?: string }
): Promise<string> {
	const client = makeRelayClient(s);
	try {
		await client.health();
	} catch {
		throw new Error('中转程序没有运行：请在 SerenaPost 设置里打开「内置中转」');
	}
	const taken = new Set(prepared.resolved.assets.map(a => a.fileName));
	const cover = opts.coverDataUrl ? coverFromDataUrl(opts.coverDataUrl, taken) : prepared.resolved.cover;
	const { id } = await client.postDraft({
		kind: 'x-article',
		title: opts.title,
		markdown: prepared.resolved.body,
		mode: 'rich',
		source: 'obsidian',
		sourceMeta: { notePath: file.path, vault: app.vault.getName() },
		styleReport: prepared.report,
		assets: prepared.resolved.assets,
		cover,
	});
	if (s.openXAfterPush) openXComposer(id);
	return id;
}
