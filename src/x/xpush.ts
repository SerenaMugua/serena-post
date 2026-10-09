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
import { convertToJpeg } from '../utils/image';
import type { DraftBundle } from '../../vendor/kaitox/relay-protocol/index';

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
	await staticGifs(resolved);
	// Obsidian 高亮 ==文字== 在 X 文章里没有对应格式，改成加粗（代码块里的不动）
	resolved.body = resolved.body.replace(/(```[\s\S]*?```)|==(?=\S)([^=\n]*?\S)==/g, (m, code, text) => code ?? `**${text}**`);
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

/**
 * X 文章只收 JPG / PNG / WebP 静态图：收到 GIF 动图会整篇草稿建不成（Kaitox 扩展把它当静态图上传）。
 * 推送前把 GIF（第一帧）、SVG、BMP、AVIF 转成 JPG；GIF 原位置已有「【这里换成动图】」提示，推完到 X 编辑器里换回动图。
 */
export async function staticGifs(resolved: Resolved): Promise<void> {
	const taken = new Set(resolved.assets.map(a => a.fileName));
	for (const a of resolved.assets) {
		const isGif = /^image\/gif$/i.test(a.mime) || /\.gif$/i.test(a.fileName);
		const unsupported = /^image\/(svg\+xml|bmp|avif)$/i.test(a.mime) || /\.(svg|bmp|avif)$/i.test(a.fileName);
		if (!isGif && !unsupported) continue;
		try {
			const buf = a.bytes.buffer.slice(a.bytes.byteOffset, a.bytes.byteOffset + a.bytes.byteLength) as ArrayBuffer;
			const jpg = new Uint8Array(await convertToJpeg(buf, a.mime || 'image/gif'));
			const base = a.fileName.replace(/\.[^.]+$/, '');
			let name = `${base}.jpg`;
			for (let i = 2; taken.has(name); i++) name = `${base}-${i}.jpg`;
			taken.add(name);
			const oldSrc = a.src;
			resolved.body = resolved.body.split(`](${oldSrc})`).join(`](${name})`);
			delete resolved.assetMap[oldSrc];
			resolved.assetMap[name] = { bytesLen: jpg.byteLength, mime: 'image/jpeg', resolved: true };
			a.bytes = jpg;
			a.mime = 'image/jpeg';
			a.fileName = name;
			a.src = name;
		} catch (e) {
			console.error('[SerenaPost] 图片转 JPG 失败', a.fileName, e);
		}
	}
}

export type XWatchResult =
	| { kind: 'ok'; restId: string }
	| { kind: 'no-id' }
	| { kind: 'failed'; error: string }
	| { kind: 'timeout'; status: string }
	| { kind: 'lost' };

/**
 * 推送后盯着 Kaitox 扩展的回报（扩展建完草稿会告诉中转：成功 + 草稿编号，或失败 + 原因）。
 * 返回最终结果；超时还没回报就返回 timeout。
 */
export async function watchXDraft(
	s: XSettings,
	id: string,
	opts: { timeoutMs?: number; intervalMs?: number; cancelled?: () => boolean } = {},
): Promise<XWatchResult> {
	const client = makeRelayClient(s);
	const timeout = opts.timeoutMs ?? 180000;
	const interval = opts.intervalMs ?? 3000;
	const start = Date.now();
	let last = 'pending';
	let misses = 0;
	while (Date.now() - start < timeout) {
		await new Promise(r => setTimeout(r, interval));
		if (opts.cancelled?.()) return { kind: 'lost' };
		let d: DraftBundle;
		try {
			d = await client.getDraft(id);
			misses = 0;
		} catch {
			if (++misses >= 5) return { kind: 'lost' };
			continue;
		}
		last = d.status ?? 'pending';
		if (d.status === 'failed') return { kind: 'failed', error: d.error || '' };
		if (d.status === 'done') return d.restId ? { kind: 'ok', restId: d.restId } : { kind: 'no-id' };
	}
	return { kind: 'timeout', status: last };
}
