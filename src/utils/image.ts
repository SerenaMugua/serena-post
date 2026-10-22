export interface CompressedImage {
	data: ArrayBuffer;
	mimeType: string;
}

export async function compressImage(
	data: ArrayBuffer,
	mimeType: string,
	maxSizeKB = 500
): Promise<CompressedImage> {
	if (data.byteLength <= maxSizeKB * 1024 || !/^image\/(png|jpe?g|webp)$/i.test(mimeType)) {
		return { data, mimeType };
	}

	const blobUrl = URL.createObjectURL(new Blob([data], { type: mimeType }));
	try {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error('无法读取图片'));
			image.src = blobUrl;
		});

		const scale = Math.min(1, 2048 / image.naturalWidth, 2048 / image.naturalHeight);
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.floor(image.naturalWidth * scale));
		canvas.height = Math.max(1, Math.floor(image.naturalHeight * scale));
		const context = canvas.getContext('2d');
		if (!context) throw new Error('无法创建图片压缩画布');
		context.drawImage(image, 0, 0, canvas.width, canvas.height);

		const outputMime = mimeType === 'image/png' ? 'image/jpeg' : mimeType;
		let quality = 0.9;
		let output = await canvasToBlob(canvas, outputMime, quality);
		while (output.size > maxSizeKB * 1024 && quality > 0.2) {
			quality -= 0.1;
			output = await canvasToBlob(canvas, outputMime, quality);
		}
		return { data: await output.arrayBuffer(), mimeType: outputMime };
	} finally {
		URL.revokeObjectURL(blobUrl);
	}
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片压缩失败')), mimeType, quality);
	});
}

/** 把头像裁成居中正方形并缩到 240px，PNG data URL（体积小，发布时只上传一次） */
export async function squareAvatar(file: File): Promise<string> {
	const url = URL.createObjectURL(file);
	try {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error('不是有效的图片'));
			el.src = url;
		});
		const side = Math.min(img.naturalWidth, img.naturalHeight);
		const size = Math.min(240, side);
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = size;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
		return canvas.toDataURL('image/png');
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** 画到画布上转成 JPG（白底）；GIF 动图会变成第一帧的静态图 */
export async function convertToJpeg(data: ArrayBuffer, mimeType: string, maxSide = 2048): Promise<ArrayBuffer> {
	const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('无法读取图片'));
			img.src = url;
		});
		const w = img.naturalWidth || 800;
		const h = img.naturalHeight || 600;
		const scale = Math.min(1, maxSide / w, maxSide / h);
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(w * scale));
		canvas.height = Math.max(1, Math.round(h * scale));
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('无法创建画布');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return await (await canvasToBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer();
	} finally {
		URL.revokeObjectURL(url);
	}
}

export function isSvg(mimeType: string, fileName = ''): boolean {
	return /^image\/svg\+xml$/i.test(mimeType) || /\.svg$/i.test(fileName);
}

/** SVG 的设计尺寸：优先 viewBox，其次绝对单位的 width / height；都没有返回 null */
function svgSize(root: Element): { w: number; h: number } | null {
	const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
	if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
	const len = (v: string | null) => (v && /^\s*[\d.]+\s*(px)?\s*$/i.test(v) ? parseFloat(v) : 0);
	const w = len(root.getAttribute('width'));
	const h = len(root.getAttribute('height'));
	return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * SVG 转高清 PNG（白底）。直接 new Image() 画 SVG 时，没写 width/height（或写成 100%）的 SVG
 * 会被浏览器当成 300×150，转出来的图又小又糊；这里先按 viewBox 把尺寸钉死，
 * 再放大到宽至少 minWidth（长边不超过 maxSide）后画，文字图用 PNG 不会有 JPG 的噪点。
 */
export async function svgToPng(data: ArrayBuffer, minWidth = 2400, maxSide = 4096): Promise<ArrayBuffer> {
	const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'image/svg+xml');
	if (doc.querySelector('parsererror')) throw new Error('SVG 不是合法 XML');
	const root = doc.documentElement;
	const size = svgSize(root) ?? { w: 800, h: 600 };
	root.setAttribute('width', String(size.w));
	root.setAttribute('height', String(size.h));
	const scale = Math.min(Math.max(1, minWidth / size.w), maxSide / Math.max(size.w, size.h));
	const xml = new XMLSerializer().serializeToString(root);
	const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('无法读取 SVG'));
			img.src = url;
		});
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(size.w * scale));
		canvas.height = Math.max(1, Math.round(size.h * scale));
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('无法创建画布');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return await (await canvasToBlob(canvas, 'image/png', 1)).arrayBuffer();
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** 公众号正文图片只收 JPG / PNG、1MB 以内：先压缩，其他格式（WebP、GIF）转成 JPG，SVG 先转高清 PNG */
export async function toUploadable(data: ArrayBuffer, mimeType: string): Promise<CompressedImage> {
	if (isSvg(mimeType)) {
		data = await svgToPng(data, 2048, 2048);
		mimeType = 'image/png';
	}
	let out = await compressImage(data, mimeType, 900);
	if (!/^image\/(jpeg|png)$/i.test(out.mimeType)) {
		out = await compressImage(await convertToJpeg(out.data, out.mimeType), 'image/jpeg', 900);
	}
	return out;
}

/** 按比例居中裁剪（封面用），输出 JPG data URL */
export async function cropToRatio(dataUrl: string, ratio: number, width = 900): Promise<string> {
	const img = new Image();
	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () => reject(new Error('无法读取封面'));
		img.src = dataUrl;
	});
	const w = img.naturalWidth, h = img.naturalHeight;
	let sw = w, sh = Math.round(w / ratio);
	if (sh > h) { sh = h; sw = Math.round(h * ratio); }
	const sx = Math.round((w - sw) / 2), sy = Math.round((h - sh) / 2);
	const outW = Math.min(width, sw);
	const outH = Math.round(outW / ratio);
	const canvas = document.createElement('canvas');
	canvas.width = outW;
	canvas.height = outH;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('无法创建画布');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, outW, outH);
	ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
	return canvas.toDataURL('image/jpeg', 0.9);
}

/** 读取图片宽高 */
export function imageSize(dataUrl: string): Promise<{ w: number; h: number }> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
		img.onerror = () => reject(new Error('无法读取图片'));
		img.src = dataUrl;
	});
}
