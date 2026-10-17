#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { BrowserNotFoundError, render, type RenderResult } from './render';

const { version } = require('../package.json') as { version: string };

const USAGE = `Usage: mdprint [options] <file.md ...>

Render Markdown to PDF, with mermaid diagrams, KaTeX math and CJK-friendly typography.

Options:
  -o, --out-dir <dir>   write PDFs into <dir> (default: next to each source file)
      --install-browser download the headless Chrome that mdprint renders with
  -h, --help            show this help
  -v, --version         show version

Examples:
  mdprint README.md
  mdprint docs/*.md -o pdf/
`;

async function main(): Promise<number> {
	let args;
	try {
		args = parseArgs({
			allowPositionals: true,
			options: {
				'out-dir': { type: 'string', short: 'o' },
				'install-browser': { type: 'boolean' },
				help: { type: 'boolean', short: 'h' },
				version: { type: 'boolean', short: 'v' },
			},
		});
	} catch (error) {
		console.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);
		return 2;
	}
	const { values, positionals: files } = args;

	if (values.version) {
		console.log(version);
		return 0;
	}
	if (values['install-browser']) {
		return installBrowser();
	}
	if (values.help || files.length === 0) {
		console.log(USAGE);
		return values.help ? 0 : 2;
	}

	const started = Date.now();
	let results: RenderResult[];
	try {
		results = await render(files, { outDir: values['out-dir'], onResult: report });
	} catch (error) {
		if (error instanceof BrowserNotFoundError) {
			console.error(
				'mdprint could not find the headless Chrome it renders with.\n' +
					'npm probably skipped puppeteer\'s install script. Download it once with:\n\n' +
					'  mdprint --install-browser\n\n' +
					'or point PUPPETEER_EXECUTABLE_PATH at an existing Chrome.',
			);
		} else {
			console.error(error instanceof Error ? error.message : error);
		}
		return 1;
	}

	const failed = results.filter((r) => r.error).length;
	if (results.length > 1) {
		const secs = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`\n${results.length - failed} succeeded, ${failed} failed (${secs}s)`);
	}
	return failed > 0 ? 1 : 0;
}

function report({ source, dest, error, ms }: RenderResult): void {
	if (error) {
		console.error(`✗ ${display(source)}\n    ${error.message}`);
	} else {
		console.log(`✓ ${display(source)} → ${display(dest)}  (${(ms / 1000).toFixed(1)}s)`);
	}
}

/** 当前目录之下显示相对路径，之外显示绝对路径——免得出现一长串 ../../ */
function display(path: string): string {
	const rel = relative(process.cwd(), path);
	return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

/** 用 mdprint 自带的那份 puppeteer 去下载，版本才和它锁定的 Chrome 对得上 */
function installBrowser(): number {
	const cli = require.resolve('puppeteer/lib/puppeteer/node/cli.js');
	const { status } = spawnSync(process.execPath, [cli, 'browsers', 'install', 'chrome'], { stdio: 'inherit' });
	return status ?? 1;
}

main().then((code) => {
	process.exitCode = code;
});
