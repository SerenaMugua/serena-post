/**
 * 内置中转：Obsidian 启动时在本机 127.0.0.1 上运行 Kaitox 兼容的 relay，
 * 用户不用再装 npm / 敲 `kaitox relay --daemon`。
 *
 * - 端口已被占用且那边是健康的 relay（例如用户自己跑着 Kaitox CLI）→ 直接复用；
 * - 草稿存放在 ~/.kaitox（与原版一致），所以原版 Kaitox Chrome 扩展无需任何改动。
 */
import { startRelay, type RelayServerHandle } from '../../vendor/kaitox/relay/server';
import { pidPath } from '../../vendor/kaitox/relay/config';
import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { DEFAULT_RELAY_BASE, isRelayUp, type XSettings } from './xpush';

export type RelayMode = 'embedded' | 'external' | 'off' | 'error';

export class EmbeddedRelay {
	private handle: RelayServerHandle | null = null;
	mode: RelayMode = 'off';
	error = '';

	private portOf(base: string): number {
		try {
			const u = new URL(base || DEFAULT_RELAY_BASE);
			return u.port ? parseInt(u.port, 10) : 80;
		} catch {
			return 8765;
		}
	}

	async start(s: XSettings): Promise<RelayMode> {
		if (this.handle) return this.mode;
		if (await isRelayUp(s)) {
			this.mode = 'external';
			return this.mode;
		}
		try {
			this.handle = await startRelay(this.portOf(s.relayBase));
			this.mode = 'embedded';
			this.error = '';
		} catch (e) {
			// 端口被其他程序占用等：再确认一次是不是已有 relay
			if (await isRelayUp(s)) {
				this.mode = 'external';
			} else {
				this.mode = 'error';
				this.error = e instanceof Error ? e.message : String(e);
				console.error('[SerenaPost] 内置中转启动失败', e);
			}
		}
		return this.mode;
	}

	/**
	 * 接管：停止外部的 Kaitox 命令行中转（等同 `kaitox relay stop`），再启动内置中转。
	 * 优先按 ~/.kaitox/relay.pid 结束进程；没有 pidfile 时按端口查找监听进程（不会结束 Obsidian 自身）。
	 */
	async takeOver(s: XSettings): Promise<RelayMode> {
		if (this.mode === 'embedded') return this.mode;
		const port = this.portOf(s.relayBase);
		let filePid = 0;
		try {
			filePid = parseInt((await readFile(pidPath(), 'utf8')).trim(), 10) || 0;
		} catch { /* 没有 pidfile */ }
		const portPids = (await pidsOnPort(port)).filter(p => p !== process.pid);
		// 只结束真正监听中转端口的进程；pidfile 里的进程号可能已被别的程序复用，不单独信任它
		let pids = portPids;
		if (portPids.length === 0 && filePid > 0 && filePid !== process.pid) pids = [filePid];
		for (const pid of pids) {
			try { process.kill(pid); } catch { /* 已退出 */ }
		}
		await rm(pidPath(), { force: true }).catch(() => {});
		// 等端口释放
		const deadline = Date.now() + 4000;
		while (Date.now() < deadline && (await isRelayUp(s))) await new Promise(r => setTimeout(r, 150));
		this.mode = 'off';
		return this.start(s);
	}

	async stop(): Promise<void> {
		const h = this.handle;
		this.handle = null;
		this.mode = 'off';
		if (h) await h.close().catch(() => {});
	}

	async restart(s: XSettings): Promise<RelayMode> {
		await this.stop();
		return this.start(s);
	}
}

/** 监听指定端口的进程 pid（Windows 解析 netstat，其他系统用 lsof）。 */
function pidsOnPort(port: number): Promise<number[]> {
	return new Promise(resolve => {
		const win = process.platform === 'win32';
		const cmd = win ? 'netstat' : 'lsof';
		const args = win ? ['-ano', '-p', 'tcp'] : ['-ti', `tcp:${port}`, '-sTCP:LISTEN'];
		execFile(cmd, args, (err, stdout) => {
			if (err && !stdout) return resolve([]);
			const lines = String(stdout).split('\n');
			const pids = win
				? lines.filter(l => l.includes(`:${port} `) && /LISTENING/i.test(l)).map(l => parseInt(l.trim().split(/\s+/).pop() ?? '', 10))
				: lines.map(l => parseInt(l.trim(), 10));
			resolve([...new Set(pids.filter(n => Number.isFinite(n) && n > 0))]);
		});
	});
}
