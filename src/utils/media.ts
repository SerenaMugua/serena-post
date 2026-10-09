/**
 * 动图和视频：公众号接口只收静态图，X 文章收到动图会整篇建不成，两个平台都不能自动上传视频。
 * 推送前在正文里给它们留一行醒目的提示，推完到编辑器里手动补上。
 */

export const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;
export const GIF_EXT = /\.gif$/i;

export const gifPlaceholder = (name: string) => `【这里换成动图：${name}】`;
export const videoPlaceholder = (name: string) => `【这里插入视频：${name}】`;

export interface MediaMarks {
	text: string;
	gifs: string[];
	videos: string[];
}

/** 从图片引用里取出文件名（去掉路径、#锚点、|别名、URL 参数） */
export function mediaName(ref: string): string {
	let s = ref.split('|')[0].split('#')[0].split('?')[0].trim();
	try { s = decodeURIComponent(s); } catch { /* 保持原样 */ }
	return s.split(/[\\/]/).pop() || s;
}

/**
 * 给正文里的动图和视频加提示：
 * - GIF：图片保留（推送时变成第一帧静态图），后面另起一行「【这里换成动图：xx.gif】」
 * - 视频：整个嵌入换成「【这里插入视频：xx.mp4】」
 * 代码块里的不动。
 */
export function markMedia(markdown: string): MediaMarks {
	const gifs: string[] = [];
	const videos: string[] = [];
	const re = /(```[\s\S]*?```|~~~[\s\S]*?~~~)|!\[\[([^\]\n]+?)\]\]|!\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
	const text = markdown.replace(re, (whole, code, wiki, src) => {
		if (code) return whole;
		const name = mediaName(wiki ?? src ?? '');
		if (VIDEO_EXT.test(name)) {
			videos.push(name);
			return `\n\n${videoPlaceholder(name)}\n\n`;
		}
		if (GIF_EXT.test(name)) {
			gifs.push(name);
			return `${whole}\n\n${gifPlaceholder(name)}\n\n`;
		}
		return whole;
	});
	return { text, gifs, videos };
}
