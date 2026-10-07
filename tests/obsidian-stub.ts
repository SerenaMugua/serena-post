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
export async function requestUrl(): Promise<never> { throw new Error('测试里不联网'); }
export function setIcon() {}
