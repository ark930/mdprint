/**
 * 批量渲染：所有文件共用一个浏览器和一个本地静态服务。
 *
 * 不走 md-to-pdf 自带的 CLI，原因有三：
 *  1. 它的 CLI 在 stdin 不是 TTY 时会去读 stdin，非交互式 shell 里直接挂起；
 *  2. 它只能把 PDF 写在源文件旁边，不支持输出目录；
 *  3. 它的静态服务监听所有网卡，把整个工作目录暴露到局域网。
 * 所以这里直接调用它的内部 convertMdToPdf（md-to-pdf 版本已精确锁定）。
 */

import { createServer, type Server } from 'node:http';
import { mkdir, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join, parse, resolve, sep } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import serveHandler from 'serve-handler';
import { defaultConfig, type PdfConfig } from 'md-to-pdf/dist/lib/config';
import { convertMdToPdf } from 'md-to-pdf/dist/lib/md-to-pdf';
import mdprintConfig = require('./config');

export interface RenderOptions {
	/** PDF 输出目录；不给则写在各自源文件旁边 */
	outDir?: string;
	/** 每份文件完成（成功或失败）时回调，CLI 用来打印进度 */
	onResult?: (result: RenderResult) => void;
}

export interface RenderResult {
	source: string;
	dest: string;
	error?: Error;
	ms: number;
}

/** puppeteer 找不到 Chrome——通常是 npm 跳过了它的安装脚本 */
export class BrowserNotFoundError extends Error {}

/** 同时打开的页面数。每页都要等 500ms 网络空闲，并发能把这段等待叠起来 */
const CONCURRENCY = 4;

export async function render(files: string[], options: RenderOptions = {}): Promise<RenderResult[]> {
	const sources = files.map((f) => resolve(f));
	await assertFilesExist(sources);

	const outDir = options.outDir === undefined ? undefined : resolve(options.outDir);
	const dests = sources.map((src) => join(outDir ?? dirname(src), `${parse(src).name}.pdf`));
	assertNoCollisions(sources, dests);
	if (outDir) {
		await mkdir(outDir, { recursive: true });
	}

	// md 里的相对路径（图片等）靠静态服务解析，服务根必须罩住所有输入文件
	const basedir = commonDir(sources);
	const server = await serve(basedir);
	const port = (server.address() as AddressInfo).port;

	const base: PdfConfig = {
		...defaultConfig,
		...mdprintConfig,
		pdf_options: { ...defaultConfig.pdf_options, ...mdprintConfig.pdf_options },
		basedir,
		port,
	} as PdfConfig;

	let browser: Browser | undefined;
	try {
		browser = await launch(base);
		const results: RenderResult[] = new Array(sources.length);
		let next = 0;
		const worker = async () => {
			while (next < sources.length) {
				const i = next++;
				const started = Date.now();
				const result: RenderResult = { source: sources[i], dest: dests[i], ms: 0 };
				try {
					// 每份文件一个新对象：convertMdToPdf 会就地改 config 和 pdf_options
					await convertMdToPdf(
						{ path: sources[i] },
						{ ...base, pdf_options: { ...base.pdf_options }, dest: dests[i] },
						{ browser },
					);
				} catch (error) {
					result.error = error instanceof Error ? error : new Error(String(error));
				}
				result.ms = Date.now() - started;
				results[i] = result;
				options.onResult?.(result);
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));
		return results;
	} finally {
		await browser?.close();
		await new Promise((done) => server.close(done));
	}
}

async function assertFilesExist(paths: string[]): Promise<void> {
	const missing: string[] = [];
	for (const p of paths) {
		const s = await stat(p).catch(() => undefined);
		if (!s?.isFile()) {
			missing.push(p);
		}
	}
	if (missing.length > 0) {
		throw new Error(`File not found:\n  ${missing.join('\n  ')}`);
	}
}

/** 输出到同一目录时，不同目录下的同名文件会互相覆盖 */
function assertNoCollisions(sources: string[], dests: string[]): void {
	const seen = new Map<string, string>();
	for (const [i, dest] of dests.entries()) {
		const prev = seen.get(dest);
		if (prev !== undefined && prev !== sources[i]) {
			throw new Error(`Both ${prev} and ${sources[i]} would be written to ${dest}`);
		}
		seen.set(dest, sources[i]);
	}
}

/** 所有文件所在目录的最长公共前缀 */
function commonDir(paths: string[]): string {
	const dirs = paths.map((p) => dirname(p).split(sep));
	let n = dirs[0].length;
	for (const parts of dirs) {
		let i = 0;
		while (i < n && parts[i] === dirs[0][i]) {
			i++;
		}
		n = i;
	}
	const dir = dirs[0].slice(0, n).join(sep);
	// POSIX 下只剩根目录时是空串；Windows 下只剩盘符时是 "C:"（那是盘符相对路径）
	return dir === '' || dir.endsWith(':') ? dir + sep : dir;
}

/** 只监听回环地址，端口由系统分配 */
function serve(basedir: string): Promise<Server> {
	const server = createServer((req, res) => serveHandler(req, res, { public: basedir }));
	return new Promise((done, fail) => {
		server.once('error', fail);
		server.listen(0, '127.0.0.1', () => done(server));
	});
}

async function launch(config: PdfConfig): Promise<Browser> {
	try {
		return await puppeteer.launch({ ...config.launch_options });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/could not find (chrome|chromium)/i.test(message)) {
			throw new BrowserNotFoundError(message);
		}
		throw error;
	}
}
