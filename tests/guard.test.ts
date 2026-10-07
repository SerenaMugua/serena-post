// 守门测试：项目文档「五、禁区」里的东西，改了这里会报错提醒
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/types/index';
import { DEFAULT_RELAY_BASE, DEFAULT_RELAY_PORT } from '../vendor/kaitox/relay-protocol/index';

// npm test 在仓库根目录运行
const read = (p: string) => readFileSync(p, 'utf8');
const json = (p: string) => JSON.parse(read(p));

test('插件 id 和「只支持电脑版」不能改', () => {
	const m = json('manifest.json');
	assert.equal(m.id, 'serena-post');
	assert.equal(m.isDesktopOnly, true);
});

test('三处版本号一致，versions.json 里有当前版本', () => {
	const m = json('manifest.json');
	const p = json('package.json');
	const v = json('versions.json');
	assert.equal(p.version, m.version, 'package.json 和 manifest.json 版本不一致');
	assert.ok(v[m.version], 'versions.json 里没有当前版本');
	assert.doesNotMatch(m.version, /^v/, '版本号不要带 v');
});

test('设置字段只能加不能删（老用户的设置靠这些名字）', () => {
	const required = [
		'accounts', 'publishHistory', 'defaultTheme', 'defaultCoverImage', 'defaultAuthor', 'defaultOpenComment',
		'relayBase', 'relayToken', 'openXAfterPush', 'xSelected', 'embeddedRelay', 'customThemes',
		'headingStyle', 'headingAvatar', 'brandAvatar', 'endMark', 'endMarkText',
		'onboardingDone', 'collapsedCards', 'previewSyncScroll', 'writeBackMeta',
	];
	for (const k of required) assert.ok(k in DEFAULT_SETTINGS, `设置字段 ${k} 不见了`);
});

test('X 中转地址和原版 Kaitox 扩展保持一致', () => {
	assert.equal(DEFAULT_RELAY_PORT, 8765);
	assert.equal(DEFAULT_RELAY_BASE, 'http://127.0.0.1:8765');
	assert.equal(DEFAULT_SETTINGS.relayBase, 'http://127.0.0.1:8765');
});

test('AppSecret 的保存键名不能改（改了所有人要重填密钥）', () => {
	assert.match(read('src/main.ts'), /`wechat-multi-publisher-\$\{safeAccountId\}-\$\{kind\}`/);
});

test('老 WeChatPB 用户的设置迁移还在', () => {
	const src = read('src/main.ts');
	assert.match(src, /migrateFromWeChatPB/);
	assert.match(src, /plugins\/wechat-multi-publisher\/data\.json/);
	assert.match(src, /migrateLegacySecrets/);
});

test('笔记属性名不能改（写回和读取用的是同一套）', () => {
	const src = read('src/views/publisher-view.ts');
	for (const k of ['wx_author', 'digest', 'source_url', 'sp_theme', 'sp_heading_style', 'sp_published']) {
		assert.ok(src.includes(k), `笔记属性 ${k} 不见了`);
	}
});

test('图片上传不用 form-data 包（打包后会坏）', () => {
	const src = read('src/services/weixin-api.ts');
	assert.doesNotMatch(src, /from ['"]form-data['"]|require\(['"]form-data['"]\)/);
});

test('公众号图片会把 GIF / WebP 转成 JPG', () => {
	const src = read('src/utils/image.ts');
	assert.match(src, /export async function toUploadable/);
	assert.match(read('src/views/publisher-view.ts'), /toUploadable\(/);
});

test('开源致谢和许可文件都在', () => {
	assert.match(read('LICENSE'), /MIT/);
	const n = read('THIRD_PARTY_NOTICES.md');
	assert.match(n, /WeChatPB|wechatPB/i);
	assert.match(n, /Kaitox/i);
});

test('Release 流程：推标签自动发布，文件名不变', () => {
	const wf = read('.github/workflows/release.yml');
	for (const f of ['main.js', 'manifest.json', 'styles.css']) assert.ok(wf.includes(f), `Release 少了 ${f}`);
	assert.match(wf, /serena-post-/);
});
