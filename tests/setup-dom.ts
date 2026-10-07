// 给 Node 装一个假的浏览器环境（document、DOMParser 等）
import { Window } from 'happy-dom';
const w = new Window();
const g = globalThis as any;
for (const k of ['window', 'document', 'DOMParser', 'Node', 'NodeFilter', 'Element', 'HTMLElement', 'DocumentFragment', 'Text']) {
	g[k] = k === 'window' ? w : (w as any)[k];
}
