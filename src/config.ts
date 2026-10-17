/**
 * mdprint 的 md-to-pdf 配置
 *
 * 由 render.ts 和默认配置合并后交给 md-to-pdf。本文件保持 `export =`，
 * 编译产物 dist/config.js 也能直接当 `md-to-pdf --config-file` 用。
 *
 * ── mermaid 渲染原理 ────────────────────────────────────────────
 *  1. marked 扩展把 ```mermaid 代码块转成 <div class="mermaid">
 *  2. 从 node_modules 注入 mermaid（require.resolve 定位，不走 CDN）
 *  3. 调用 mermaid.init() 完成渲染
 *
 *  ⚠️ mermaid 锁定在 9.x，不要升级到 10/11：
 *     v9 的 init() 是**同步**的，会在 puppeteer 的 addScriptTag 返回前
 *     渲染完毕；v10 起改为异步（mermaid.run() 返回 Promise），而 md-to-pdf
 *     在注入脚本后只等 networkidle0（500ms 无网络请求）就直接 page.pdf()，
 *     异步渲染会和它竞速，表现为「有时出图、有时空白」的间歇性失败。
 *
 * ── LaTeX 数学公式 ──────────────────────────────────────────────
 *  $...$ 行内、$$...$$ 独立成块，由 KaTeX 在 **Node 端**（marked 扩展里）
 *  渲染成 HTML。和 mermaid 不同，这里**没有浏览器端脚本**，也就没有
 *  竞速问题——公式在 setContent 之前就已经是静态 HTML 了。
 *
 *  ⚠️ KaTeX 的字体必须内联成 data URI：
 *     md-to-pdf 用 page.addStyleTag({path}) 注入样式表，puppeteer 读取
 *     文件内容后当作 <style> 插入，CSS 里的相对路径 url(fonts/*.woff2)
 *     会相对**页面** base URL 解析而不是 CSS 文件，必然 404、公式退化成
 *     无衬线字符。所以下面在构建期把 woff2 转成 base64 塞进 CSS。
 * ───────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PdfConfig } from 'md-to-pdf/dist/lib/config';

const katex = require('katex') as typeof import('katex');

/** mermaid UMD 包在 node_modules 中的绝对路径 */
const MERMAID_JS = require.resolve('mermaid/dist/mermaid.min.js');

/**
 * 统一的语义配色（Bootstrap 语义色系）。
 * 改这里等于改所有图——不要在单份文档里另起一套 hex。
 * 各类名的语义见 README「Diagram colours」一节。
 */
const PALETTE = {
	/** 正常主流程 / 进行中 */
	run:  { fill: '#cfe2ff', stroke: '#0d6efd' },
	/** 成功 / 已完成 / 目标态 */
	ok:   { fill: '#d4edda', stroke: '#28a745' },
	/** 判断分支 / 待定 / 需人工确认 */
	wait: { fill: '#fff3cd', stroke: '#d39e00' },
	/** 失败 / 放弃 / 阻塞 / 硬约束 */
	bad:  { fill: '#f8d7da', stroke: '#c82333' },
	/** 范围外 / MVP 之后 / 已归档 */
	out:  { fill: '#f1f3f5', stroke: '#adb5bd' },
	/** 外部系统 / 第三方 / 人 */
	ext:  { fill: '#e2d9f3', stroke: '#6f42c1' },
} as const;

/** 中文字体栈，正文与图表共用 */
const CJK_FONTS = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,"Segoe UI",sans-serif';

// ---------- KaTeX 样式表：字体内联为 data URI ----------
const KATEX_CSS_PATH = require.resolve('katex/dist/katex.min.css');
const KATEX_FONT_DIR = join(dirname(KATEX_CSS_PATH), 'fonts');

const KATEX_CSS = readFileSync(KATEX_CSS_PATH, 'utf8')
	// 先丢掉 woff / ttf 备选源，只留 woff2（Chrome 一定支持），体积省三分之二
	.replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\) ?format\("(?:woff|truetype)"\)/g, '')
	// 再把剩下的 woff2 换成 base64
	.replace(/url\(fonts\/([^)]+\.woff2)\)/g, (_m, file: string) => {
		const b64 = readFileSync(join(KATEX_FONT_DIR, file)).toString('base64');
		return `url(data:font/woff2;base64,${b64})`;
	});

/** 把一段 TeX 渲成 HTML；出错时不中断整批构建，但要在 stderr 和 PDF 里都留下明显痕迹 */
function renderTex(tex: string, displayMode: boolean): string {
	try {
		return katex.renderToString(tex, {
			displayMode,
			throwOnError: true,
			// 只出 HTML，不出 MathML——PDF 不需要无障碍树，
			// 留着反而让文本选取/复制出现重影
			output: 'html',
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// KaTeX 的 ParseError 自带「KaTeX parse error:」前缀，别的异常没有
		const label = message.startsWith('KaTeX') ? message : `KaTeX error: ${message}`;
		console.error(`\n⚠️  ${label}\n    source: ${tex}\n`);
		const escaped = tex.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		return `<code style="color:#c82333;background:#f8d7da;">KaTeX error: ${escaped}</code>`;
	}
}

const config: Partial<PdfConfig> = {
	// ---------- 1. ```mermaid → <div class="mermaid"> ----------
	marked_extensions: [
		{
			renderer: {
				code(code: string, infostring: string | undefined) {
					const lang = (infostring ?? '').trim().split(/\s+/)[0];
					if (lang !== 'mermaid') {
						return false; // 其余语言交回默认渲染器
					}

					// code 已被 highlight.js 以 plaintext 转义（&lt; &gt; &amp;）。
					// 作为 innerHTML 放进 div 后浏览器还原为纯文本，
					// mermaid 读 textContent 拿到的正是原始源码（含 <br/>）。
					return `<div class="mermaid">${code}</div>`;
				},
			},
		},

		// ---------- 1b. $...$ / $$...$$ → KaTeX HTML ----------
		{
			extensions: [
				{
					// 块级必须排在行内前面：marked 先跑 block 分词，
					// $$ 独占一行的情形不能被行内规则先吃掉
					name: 'mathBlock',
					level: 'block' as const,
					start: (src: string) => src.indexOf('$$'),
					tokenizer(src: string) {
						const match = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?:\n+|$)/.exec(src);
						if (!match) {
							return undefined;
						}
						return { type: 'mathBlock', raw: match[0], text: match[1].trim() };
					},
					renderer: (token: { text: string }) =>
						`<div class="math-block">${renderTex(token.text, true)}</div>`,
				},
				{
					name: 'mathInline',
					level: 'inline' as const,
					start: (src: string) => src.indexOf('$'),
					tokenizer(src: string) {
						// 不跨行、内部不含 $，因此 $$ 不会被误当成空行内公式
						const match = /^\$([^$\n]+?)\$/.exec(src);
						if (!match) {
							return undefined;
						}
						return { type: 'mathInline', raw: match[0], text: match[1] };
					},
					renderer: (token: { text: string }) => renderTex(token.text, false),
				},
			],
		},
	],

	// ---------- 2. 注入 mermaid 并同步渲染 ----------
	script: [
		{ path: MERMAID_JS },
		{
			content: `
				mermaid.initialize({
						startOnLoad: false,
						theme: 'neutral',
						fontFamily: ${JSON.stringify(CJK_FONTS)},
						// ⚠️ 不要在这里加 themeVariables——在本管线里它不生效。
						// mermaid.mermaidAPI.getConfig() 能读回覆盖值，但渲染器仍用
						// 主题默认色（实测：primaryColor 设成 #ff00ff，节点照样是
						// 默认色）。配色统一走下面 CSS 的 !important 覆盖，
						// 那条路已逐图种验证。
						flowchart: { htmlLabels: true, useMaxWidth: false, curve: 'basis' },
						// 其余图种同样关掉 useMaxWidth。开着时 mermaid 会往 <svg> 上
						// 写内联 style="max-width:NNNpx"，内联样式压过样式表里的
						// max-width:176mm，图不缩放而是被页面右边界裁掉
						//（journey、gantt 尤其明显，它们天生比 A4 宽）。
						sequence: { useMaxWidth: false },
						gantt: { useMaxWidth: false },
						journey: { useMaxWidth: false },
						class: { useMaxWidth: false },
						state: { useMaxWidth: false },
						timeline: { useMaxWidth: false },
						pie: { useMaxWidth: false },
						er: { useMaxWidth: false },
					});
					mermaid.init(undefined, document.querySelectorAll('.mermaid'));
			`,
		},
	],

	// ---------- 3. 中文排版 ----------
	css: `
		${KATEX_CSS}

		body {
			font-family: ${CJK_FONTS};
			font-size: 10.5pt;
			line-height: 1.75;
			color: #1a1a1a;
		}
		h1 { font-size: 20pt; border-bottom: 2px solid #333; padding-bottom: .3em; }
		h2 { font-size: 15pt; margin-top: 1.6em; border-bottom: 1px solid #ddd; padding-bottom: .2em; }
		h3 { font-size: 12.5pt; margin-top: 1.3em; }
		h1, h2, h3, h4 { break-after: avoid; }

		table { border-collapse: collapse; width: 100%; font-size: 9pt; margin: 1em 0; }
		th, td { border: 1px solid #ccc; padding: 5px 8px; vertical-align: top; }
		th { background: #f2f2f2; font-weight: 600; }
		tr { break-inside: avoid; }

		blockquote {
			border-left: 3px solid #d0d0d0;
			margin: 1em 0; padding: .4em 1em;
			background: #fafafa; color: #333;
		}

		pre { background: #f6f8fa; padding: .8em; border-radius: 4px;
		      font-size: 8.5pt; overflow-x: auto; break-inside: avoid; }
		code { font-family: "SF Mono",Menlo,Consolas,monospace; font-size: .9em; }

		/* mermaid 图：整块不跨页、居中。
		   同时受页宽和页高约束——A4 去掉页边距后可用 178mm × 247mm，
		   留一点余量取 176mm × 235mm。只给 max-*，让 SVG 按原始宽高比
		   自动缩放，避免高图被裁掉半张。 */
		.mermaid { text-align: center; margin: 1.2em 0; break-inside: avoid; }
		/* !important 是必须的：部分图种（journey / gantt / sequence）即便配置了
		   useMaxWidth:false，mermaid 仍可能写内联 width/max-width，
		   内联样式优先级高于样式表，图会被裁而不是被缩放。 */
		.mermaid svg {
			width: auto !important; height: auto !important;
			max-width: 176mm !important; max-height: 235mm !important;
		}

		/* ── 语义配色类 ──
		   给 mermaid 的 cssClass / :::name 语法用。flowchart、classDiagram、
		   stateDiagram-v2 都会把类名挂到节点的 <g> 上，所以一套 CSS 通吃。
		   好处是文档里写 :::ok 就行，不用到处抄 hex——改配色只改 PALETTE。 */
		${Object.entries(PALETTE)
			.map(
				([name, c]) => `.mermaid g.${name} > rect,
		.mermaid g.${name} > polygon,
		.mermaid g.${name} > circle,
		.mermaid g.${name} > path {
			fill: ${c.fill} !important; stroke: ${c.stroke} !important;
		}`,
			)
			.join('\n\t\t')}

		/* ── pie / journey / gantt 的配色 ──
		   这三种图没有逐节点 style 语法，themeVariables 在本管线又不生效，
		   只能按 mermaid 生成的元素类名覆盖。fill 是**表现属性**，
		   CSS 一定压得过它，所以下面这些规则是可靠的。
		   选择器来自实测的 SVG 结构，升级 mermaid 前要重新核对。 */

		/* pie：切片按数据顺序排列，用 nth-of-type 上色 */
		${[PALETTE.run, PALETTE.ok, PALETTE.wait, PALETTE.bad, PALETTE.out, PALETTE.ext]
			.map(
				(c, i) => `.mermaid path.pieCircle:nth-of-type(${i + 1}) {
			fill: ${c.fill} !important; stroke: ${c.stroke} !important;
		}`,
			)
			.join('\n\t\t')}
		.mermaid .pieTitleText, .mermaid .slice { fill: #1a1a1a !important; }
		/* 图例色块要跟切片同色，否则图例失去意义 */
		${[PALETTE.run, PALETTE.ok, PALETTE.wait, PALETTE.bad, PALETTE.out, PALETTE.ext]
			.map(
				(c, i) => `.mermaid g.legend:nth-of-type(${i + 1}) rect {
			fill: ${c.fill} !important; stroke: ${c.stroke} !important;
		}`,
			)
			.join('\n\t\t')}

		/* journey：section 与 task 按类型编号交替配色；actor 圆点同理 */
		${[PALETTE.run, PALETTE.ok, PALETTE.wait, PALETTE.bad, PALETTE.ext, PALETTE.out]
			.map(
				(c, i) => `.mermaid rect.journey-section.section-type-${i},
		.mermaid rect.task.task-type-${i} {
			fill: ${c.fill} !important; stroke: ${c.stroke} !important;
		}
		.mermaid circle.actor-${i} { fill: ${c.fill} !important; stroke: ${c.stroke} !important; }`,
			)
			.join('\n\t\t')}
		/* 上面把底色改浅了，section 标题原本是白字，必须跟着改深 */
		.mermaid .journey-section text, .mermaid .task-type-0 ~ text,
		.mermaid g.section text, .mermaid text.journey-section { fill: #1a1a1a !important; }

		/* gantt：done / active / crit / 普通 四档必须一眼可分。
		   类名带 section 序号后缀（done0、done1…），用 [class*=] 匹配。
		   顺序重要——基础规则在前，三种状态在后覆盖。 */
		.mermaid rect.task {
			fill: ${PALETTE.out.fill} !important; stroke: ${PALETTE.out.stroke} !important;
		}
		.mermaid rect.task[class*="done"] {
			fill: ${PALETTE.ok.fill} !important; stroke: ${PALETTE.ok.stroke} !important;
		}
		.mermaid rect.task[class*="active"] {
			fill: ${PALETTE.run.fill} !important; stroke: ${PALETTE.run.stroke} !important;
		}
		.mermaid rect.task[class*="crit"] {
			fill: ${PALETTE.bad.fill} !important; stroke: ${PALETTE.bad.stroke} !important;
		}
		.mermaid .taskText, .mermaid .taskTextOutsideRight,
		.mermaid .taskTextOutsideLeft { fill: #1a1a1a !important; }

		/* ── KaTeX 公式 ──
		   KaTeX 默认 1.21em 在中文正文里显得过大（中文字面本来就比拉丁字母高），
		   压到 1.05em 与正文视觉等高。 */
		.katex { font-size: 1.05em; }
		/* \\text{中文} 走 KaTeX_Main，里面没有汉字字形，必须补中文回退，
		   否则公式里的中文变量名会掉成豆腐块 */
		.katex .mord.text, .katex .text { font-family: KaTeX_Main, ${CJK_FONTS}; }
		.math-block {
			text-align: center; margin: 1.1em 0;
			break-inside: avoid; overflow-x: auto;
		}
	`,

	pdf_options: {
		format: 'A4',
		margin: { top: '20mm', right: '16mm', bottom: '20mm', left: '16mm' },
		printBackground: true,
		displayHeaderFooter: true,
		headerTemplate: '<div></div>',
		footerTemplate: `
			<div style="width:100%;font-size:8pt;color:#888;text-align:center;
			            font-family:-apple-system,sans-serif;">
				<span class="pageNumber"></span> / <span class="totalPages"></span>
			</div>`,
	},

	launch_options: { args: ['--no-sandbox'] },
};

export = config;
