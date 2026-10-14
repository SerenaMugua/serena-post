// X 推送动图和视频：跟着 Kaitox 0.6.2，GIF / 视频原样交给中转，由扩展按 GIF / 视频分类上传
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { markdownToContentState, mediaKindFromMime, guessMimeFromName } from '../vendor/kaitox/x-article/index';
import { staticGifs } from '../src/x/xpush';
import { isMediaExt } from '../src/x/resolve';
import type { Resolved } from '../src/x/resolve';
import { gifFrameCount } from '../src/utils/media';

test('文件类型：GIF、视频、普通图片分得清', () => {
	assert.equal(mediaKindFromMime('image/gif'), 'gif');
	assert.equal(mediaKindFromMime('video/mp4'), 'video');
	assert.equal(mediaKindFromMime('image/png'), 'image');
	assert.equal(guessMimeFromName('录屏.mp4'), 'video/mp4');
	assert.equal(guessMimeFromName('a.MOV'), 'video/quicktime');
	assert.ok(isMediaExt('mp4') && isMediaExt('gif') && !isMediaExt('md'));
});

test('X 正文里动图 / 视频用对应的类型（不再一律当静态图）', () => {
	const md = '![](a.png)\n\n![](b.gif)\n\n![](c.mp4)';
	const { contentState } = markdownToContentState(md, { 'a.png': '1', 'b.gif': '2', 'c.mp4': '3' }, { 'b.gif': 'gif', 'c.mp4': 'video' });
	const cats = contentState.entity_map
		.map((e: any) => e.value)
		.filter((v: any) => v.type === 'MEDIA')
		.map((v: any) => v.data.media_items[0].media_category);
	assert.deepEqual(cats, ['DraftTweetImage', 'DraftTweetGif', 'DraftTweetVideo']);
});

function fakeResolved(body: string, assets: { name: string; mime: string; size: number }[]): Resolved {
	return {
		title: 't', body, unresolved: [], gifs: [], videos: [],
		assets: assets.map((a, i) => ({ key: `img-${i}`, src: a.name, fileName: a.name, mime: a.mime, bytes: new Uint8Array(a.size) })),
		assetMap: Object.fromEntries(assets.map(a => [a.name, { bytesLen: a.size, mime: a.mime, resolved: true }])),
	};
}

test('推 X：15MB 以内的动图和视频原样上传，正文不加提示', async () => {
	const r = fakeResolved('![](a.gif)\n\n![](v.mp4)', [
		{ name: 'a.gif', mime: 'image/gif', size: 1000 },
		{ name: 'v.mp4', mime: 'video/mp4', size: 1000 },
	]);
	const manual = await staticGifs(r);
	assert.deepEqual(manual, []);
	assert.equal(r.body, '![](a.gif)\n\n![](v.mp4)');
	assert.deepEqual(r.assets.map(a => a.mime), ['image/gif', 'video/mp4']);
});

function freePort(): Promise<number> {
	return new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}

test('中转收下视频和动图，类型不变（扩展靠它选上传方式）', async () => {
	const home = mkdtempSync(join(tmpdir(), 'sp-xmedia-'));
	process.env.KAITOX_HOME = home;
	const { startRelay } = await import('../vendor/kaitox/relay/server');
	const { HttpRelayClient } = await import('../vendor/kaitox/relay-protocol/index');
	const relay = await startRelay(await freePort());
	try {
		const client = new HttpRelayClient(`http://127.0.0.1:${relay.port}`);
		const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
		const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
		const { id } = await client.postDraft({
			kind: 'x-article', title: '动图视频', markdown: '![](a.gif)\n\n![](v.mp4)', mode: 'rich', source: 'obsidian',
			assets: [
				{ key: 'img-0', src: 'a.gif', fileName: 'a.gif', mime: 'image/gif', bytes: gif },
				{ key: 'img-1', src: 'v.mp4', fileName: 'v.mp4', mime: 'video/mp4', bytes: mp4 },
			],
		});
		const draft = await client.getDraft(id);
		assert.deepEqual(draft.assets.map(a => a.mime).sort(), ['image/gif', 'video/mp4']);
		assert.deepEqual([...await client.getAsset(id, 'a.gif')], [...gif]);
		assert.deepEqual([...await client.getAsset(id, 'v.mp4')], [...mp4]);
	} finally {
		await relay.close();
		rmSync(home, { recursive: true, force: true });
	}
});

/** 拼一个最小的 GIF：有全局调色板、每帧带一个图形控制扩展块 */
function makeGif(frames: number): Uint8Array {
	const out: number[] = [...'GIF89a'].map(c => c.charCodeAt(0));
	out.push(1, 0, 1, 0, 0x80, 0, 0); // 1×1，全局调色板 2 色
	out.push(0, 0, 0, 255, 255, 255);
	for (let f = 0; f < frames; f++) {
		out.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0); // 图形控制扩展（延时）
		out.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0); // 图像描述
		out.push(2, 2, 0x44, 0x01, 0); // LZW 码长 + 一个数据子块 + 结束
	}
	out.push(0x3b);
	return new Uint8Array(out);
}

test('数 GIF 帧数：1 帧是静态图，多帧才是动图，看不懂的不乱判', () => {
	assert.equal(gifFrameCount(makeGif(1)), 1);
	assert.equal(gifFrameCount(makeGif(2)), 2);
	assert.equal(gifFrameCount(makeGif(5)), 2); // 数到 2 就停
	assert.equal(gifFrameCount(new Uint8Array([1, 2, 3])), -1);
	assert.equal(gifFrameCount(new Uint8Array(1000)), -1);
});

test('推 X：多帧动图原样上传（1 帧 GIF 会转 JPG，见 staticGifs）', async () => {
	const r = fakeResolved('![](a.gif)', [{ name: 'a.gif', mime: 'image/gif', size: 0 }]);
	r.assets[0].bytes = makeGif(3);
	assert.deepEqual(await staticGifs(r), []);
	assert.equal(r.assets[0].mime, 'image/gif');
	assert.equal(r.body, '![](a.gif)');
});
