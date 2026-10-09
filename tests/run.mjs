// npm test：把 tests/*.test.ts 打包后用 Node 自带的测试工具跑
import esbuild from 'esbuild';
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.out');
// 删不掉也没关系（有的环境不允许删除文件），esbuild 会直接覆盖；tests/.out 已在 .gitignore 里
const clean = () => { try { rmSync(out, { recursive: true, force: true }); } catch { /* 忽略 */ } };
clean();
mkdirSync(out, { recursive: true });

const files = readdirSync(here).filter(f => f.endsWith('.test.ts'));
await esbuild.build({
	entryPoints: files.map(f => join(here, f)),
	outdir: out,
	bundle: true,
	platform: 'node',
	format: 'esm',
	outExtension: { '.js': '.mjs' },
	loader: { '.md': 'text' },
	alias: { obsidian: join(here, 'obsidian-stub.ts') },
	inject: [join(here, 'setup-dom.ts')],
	external: ['happy-dom'],
	banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
	logLevel: 'error',
});

const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files.map(f => join(out, f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
clean();
process.exit(r.status ?? 1);
