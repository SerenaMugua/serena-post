/**
 * 发布前体检：扫描正文图片（太大、动图、网络图片、找不到的图）。
 * 标题 / 作者 / 摘要 / 封面在确认弹窗里实时检查。
 */
import { App, TFile } from 'obsidian';

export interface ImageScan {
	/** 超过 1MB 的本地图片（发布时会自动压缩） */
	large: { name: string; kb: number }[];
	/** GIF 动图（公众号接口只收 JPG/PNG，会变成静态图） */
	animated: string[];
	/** 网络图片（发布时自动下载再上传） */
	remote: string[];
	/** 笔记里引用了但库里找不到的图片 */
	missing: string[];
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

export function scanImages(app: App, file: TFile, markdown: string): ImageScan {
	const scan: ImageScan = { large: [], animated: [], remote: [], missing: [] };
	const seen = new Set<string>();
	const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').replace(/```[\s\S]*?```/g, '');
	const re = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(<?([^)\s>]+)>?[^)]*\)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(body)) !== null) {
		const raw = (m[1] ?? m[2] ?? '').split('|')[0].split('#')[0].trim();
		if (!raw || seen.has(raw)) continue;
		seen.add(raw);
		if (/^data:/i.test(raw)) continue;
		if (/^https?:\/\//i.test(raw)) {
			scan.remote.push(raw);
			continue;
		}
		let link = raw;
		try { link = decodeURIComponent(raw); } catch { /* 保持原样 */ }
		// ![[笔记]] 这类不是图片的嵌入不管
		if (m[1] && !IMG_EXT.test(link)) continue;
		const f = app.metadataCache.getFirstLinkpathDest(link, file.path) ?? app.vault.getAbstractFileByPath(link);
		if (!(f instanceof TFile)) {
			scan.missing.push(link);
			continue;
		}
		if (f.extension.toLowerCase() === 'gif') scan.animated.push(f.name);
		const kb = Math.round(f.stat.size / 1024);
		if (kb > 1024) scan.large.push({ name: f.name, kb });
	}
	return scan;
}
