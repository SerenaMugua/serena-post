// 动图 / 视频：推送前留提示；推 X 后盯着 Kaitox 扩展的回报，没建成要报警
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { markMedia, mediaName } from '../src/utils/media';
import { xAlertMessage, xAlertReasons } from '../src/modals/x-alert-modal';

test('文件名：去掉路径、别名、锚点、URL 参数', () => {
	assert.equal(mediaName('附件/配图22.gif|300'), '配图22.gif');
	assert.equal(mediaName('https://a.com/x/demo.mp4?t=1'), 'demo.mp4');
	assert.equal(mediaName('%E9%85%8D%E5%9B%BE.gif'), '配图.gif');
});

test('动图保留图片，后面加「【这里换成动图】」', () => {
	const r = markMedia('第一段\n\n![[配图22.gif]]\n\n第二段 ![](附件/b.GIF)');
	assert.deepEqual(r.gifs, ['配图22.gif', 'b.GIF']);
	assert.match(r.text, /!\[\[配图22\.gif\]\]\n\n【这里换成动图：配图22\.gif】/);
	assert.match(r.text, /!\[\]\(附件\/b\.GIF\)\n\n【这里换成动图：b\.GIF】/);
});

test('视频整个换成「【这里插入视频】」', () => {
	const r = markMedia('看演示：\n![[录屏.mp4]]\n![](https://x.com/v.mov)');
	assert.deepEqual(r.videos, ['录屏.mp4', 'v.mov']);
	assert.doesNotMatch(r.text, /!\[\[录屏\.mp4\]\]/);
	assert.match(r.text, /【这里插入视频：录屏\.mp4】/);
	assert.match(r.text, /【这里插入视频：v\.mov】/);
});

test('普通图片和代码块里的不动', () => {
	const src = '![[a.png]]\n\n```\n![[b.gif]]\n```\n';
	const r = markMedia(src);
	assert.equal(r.text, src);
	assert.deepEqual(r.gifs, []);
});

test('报警文案：没拿到草稿编号 / 失败 / 超时', () => {
	assert.match(xAlertMessage({ kind: 'no-id' }), /没有建成/);
	assert.match(xAlertMessage({ kind: 'failed', error: 'boom' }), /boom/);
	assert.match(xAlertMessage({ kind: 'timeout', status: 'pending' }), /没有确认/);
	const withGif = xAlertReasons({ result: { kind: 'no-id' }, gifs: ['配图22.gif'], videos: ['a.mp4'] });
	assert.match(withGif[0], /1 张动图（配图22\.gif） 和 1 个视频（a\.mp4）/);
	const plain = xAlertReasons({ result: { kind: 'no-id' }, gifs: [], videos: [] });
	assert.doesNotMatch(plain.join(''), /动图/);
	assert.match(xAlertReasons({ result: { kind: 'timeout', status: 'pending' }, gifs: [], videos: [] })[0], /Chrome/);
});

function freePort(): Promise<number> {
	return new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}

test('盯回报：成功 / 没拿到编号 / 失败 / 超时都能分辨', async () => {
	const home = mkdtempSync(join(tmpdir(), 'sp-watch-'));
	process.env.KAITOX_HOME = home;
	const { startRelay } = await import('../vendor/kaitox/relay/server');
	const { HttpRelayClient } = await import('../vendor/kaitox/relay-protocol/index');
	const { watchXDraft } = await import('../src/x/xpush');
	const relay = await startRelay(await freePort());
	const base = `http://127.0.0.1:${relay.port}`;
	const s = { relayBase: base, relayToken: '', openXAfterPush: false };
	const ext = new HttpRelayClient(base); // 假装是 Chrome 里的 Kaitox 扩展
	const post = async () => (await ext.postDraft({ kind: 'x-article', title: 't', markdown: '正文', mode: 'rich', source: 'obsidian', assets: [] })).id;
	const fast = { intervalMs: 50, timeoutMs: 1500 };
	try {
		let id = await post();
		setTimeout(() => ext.ack(id, { status: 'done', restId: '123' }), 120);
		assert.deepEqual(await watchXDraft(s, id, fast), { kind: 'ok', restId: '123' });

		id = await post();
		setTimeout(() => ext.ack(id, { status: 'done' }), 120);
		assert.deepEqual(await watchXDraft(s, id, fast), { kind: 'no-id' });

		id = await post();
		setTimeout(() => ext.ack(id, { status: 'failed', error: 'X 拒绝了' }), 120);
		assert.deepEqual(await watchXDraft(s, id, fast), { kind: 'failed', error: 'X 拒绝了' });

		id = await post();
		assert.deepEqual(await watchXDraft(s, id, { intervalMs: 50, timeoutMs: 300 }), { kind: 'timeout', status: 'pending' });

		let stop = false;
		id = await post();
		setTimeout(() => { stop = true; }, 100);
		assert.deepEqual(await watchXDraft(s, id, { ...fast, cancelled: () => stop }), { kind: 'lost' });
	} finally {
		await relay.close();
		rmSync(home, { recursive: true, force: true });
	}
});
