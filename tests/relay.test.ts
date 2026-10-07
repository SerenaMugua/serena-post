// 内置 X 中转：真的启动一次，推一篇草稿，确认原版 Kaitox 扩展能读到
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

function freePort(): Promise<number> {
	return new Promise(res => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}

test('中转能启动、收草稿、列出草稿、删除草稿', async () => {
	const home = mkdtempSync(join(tmpdir(), 'sp-kaitox-'));
	process.env.KAITOX_HOME = home; // 不碰真实的 ~/.kaitox
	const { startRelay } = await import('../vendor/kaitox/relay/server');
	const { HttpRelayClient } = await import('../vendor/kaitox/relay-protocol/index');
	const relay = await startRelay(await freePort());
	try {
		const client = new HttpRelayClient(`http://127.0.0.1:${relay.port}`);
		const h = await client.health();
		assert.equal(h.ok, true);

		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const { id } = await client.postDraft({
			kind: 'x-article', title: '测试标题', markdown: '# 测试\n\n正文 ![](a.png)', mode: 'rich', source: 'obsidian',
			assets: [{ key: 'img-0', src: 'a.png', fileName: 'a.png', mime: 'image/png', bytes: png }],
		});
		assert.ok(id);
		assert.ok(existsSync(join(home, 'x-article', 'outbox')), '草稿没有放进 ~/.kaitox/x-article/outbox');
		assert.equal(readdirSync(join(home, 'x-article', 'outbox')).length, 1);

		const list = await client.listDrafts();
		assert.ok(list.some(d => d.id === id && d.title === '测试标题'));
		const draft = await client.getDraft(id);
		assert.match(draft.markdown, /正文/);
		assert.deepEqual([...await client.getAsset(id, 'a.png')], [...png]);

		await client.deleteDraft(id);
		assert.ok(!(await client.listDrafts()).some(d => d.id === id));
	} finally {
		await relay.close();
		rmSync(home, { recursive: true, force: true });
	}
});
