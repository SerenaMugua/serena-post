// 测试用的 obsidian 替身：只实现被测代码用到的几样东西
export function sanitizeHTMLToDom(html: string): DocumentFragment {
	const t = document.createElement('template');
	t.innerHTML = html;
	return t.content;
}
export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}
export class Notice { constructor(public message?: string) {} }
export class TFile {}
export class TFolder {}
export class Modal {}
export class Plugin {}
// 只允许访问本机（测试里的中转），不联网
export async function requestUrl(o: { url: string; method?: string; headers?: Record<string, string>; body?: any }) {
	if (!/^http:\/\/127\.0\.0\.1[:/]/.test(o.url)) throw new Error('测试里不联网');
	const r = await fetch(o.url, { method: o.method ?? 'GET', headers: o.headers, body: o.body });
	const buf = await r.arrayBuffer();
	const text = new TextDecoder().decode(buf);
	let json: any;
	try { json = JSON.parse(text); } catch { json = undefined; }
	return { status: r.status, text, json, arrayBuffer: buf, headers: Object.fromEntries(r.headers) };
}
export function setIcon() {}
