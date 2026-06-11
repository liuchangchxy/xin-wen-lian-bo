import fetch from './fetch.js';
import jsdom from 'jsdom';
const { JSDOM } = jsdom;
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 得到当前日期 (UTC+8)
 * @returns 当前日期, 格式如: 20220929
 */
const getDate = () => {
	const add0 = num => num < 10 ? ('0' + num) : num;
	const now = new Date();
	// 转 UTC+8
	const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000);
	return '' + utc8.getUTCFullYear() + add0(utc8.getUTCMonth() + 1) + add0(utc8.getUTCDate());
}

// 允许通过命令行参数指定日期 (用于补抓历史)
const DATE = process.argv[2] || getDate();
const NEWS_PATH = path.join(__dirname, 'news');
const NEWS_MD_PATH = path.join(NEWS_PATH, DATE + '.md');
const README_PATH = path.join(__dirname, 'README.md');
const CATALOGUE_JSON_PATH = path.join(NEWS_PATH, 'catalogue.json');

console.log('DATE:', DATE);
console.log('NEWS_PATH:', NEWS_PATH);

const readFile = p => new Promise((resolve, reject) => {
	fs.readFile(p, {}, (err, data) => {
		if (err) reject(err);
		resolve(data);
	});
});

const writeFile = (p, data) => new Promise((resolve, reject) => {
	fs.writeFile(p, data, err => {
		if (err) reject(err);
		resolve(true);
	});
});

/**
 * 获取新闻列表
 * 从列表页提取所有新闻链接和标题
 */
const getNewsList = async date => {
	const HTML = await fetch(`http://tv.cctv.com/lm/xwlb/day/${date}.shtml`);
	const fullHTML = `<!DOCTYPE html><html><head></head><body>${HTML}</body></html>`;
	const dom = new JSDOM(fullHTML);
	const nodes = dom.window.document.querySelectorAll('a');
	var items = [];
	nodes.forEach(node => {
		let link = node.href;
		if (!link || items.some(i => i.link === link)) return;
		let title = (node.getAttribute('alt') || node.textContent || '').trim();
		// 跳过完整版视频页面 (没有文字内容, 标题含"《新闻联播》"且不含"[视频]")
		if (title.includes('《新闻联播》') && !title.includes('[视频]')) return;
		// 清理标题
		title = title.replace(/^\[视频\]/, '').trim();
		if (title && link) items.push({ link, title });
	});
	console.log('成功获取新闻列表, 共', items.length, '则');
	return items;
}

/**
 * 获取单条新闻内容
 */
const getArticle = async url => {
	const html = await fetch(url);
	const dom = new JSDOM(html);
	const doc = dom.window.document;
	const content = doc.querySelector('#content_area')?.innerHTML || '';
	// 清理 HTML 标签为纯文本, 保留段落
	const text = content
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&ldquo;/g, '\u201C')
		.replace(/&rdquo;/g, '\u201D')
		.replace(/&mdash;/g, '\u2014')
		.replace(/&hellip;/g, '\u2026')
		.trim();
	return text;
}

/**
 * 生成 Markdown
 */
const toMarkdown = ({ date, items, articles }) => {
	let md = `# 《新闻联播》 (${date})\n\n`;
	md += `## 新闻目录\n\n`;
	items.forEach((item, i) => {
		md += `${i + 1}. [${item.title}](#${i + 1})\n`;
	});
	md += `\n---\n\n`;
	items.forEach((item, i) => {
		md += `## ${i + 1}. ${item.title}\n\n`;
		md += `${articles[i] || '(获取失败)'}\n\n`;
		md += `[查看原文](${item.link})\n\n---\n\n`;
	});
	md += `(更新时间: ${new Date().toISOString()})\n`;
	return md;
};

/**
 * 更新 catalogue.json 和 README.md
 */
const updateCatalogue = async ({ date, firstTitle }) => {
	// catalogue.json
	try {
		const data = await readFile(CATALOGUE_JSON_PATH);
		let catalogue = JSON.parse(data.toString() || '[]');
		// 去重
		if (!catalogue.some(c => c.date === date)) {
			catalogue.unshift({ date, title: firstTitle });
			await writeFile(CATALOGUE_JSON_PATH, JSON.stringify(catalogue, null, 2));
		}
	} catch (e) {
		await writeFile(CATALOGUE_JSON_PATH, JSON.stringify([{ date, title: firstTitle }], null, 2));
	}
	console.log('更新 catalogue.json 完成');

	// README.md
	try {
		const data = await readFile(README_PATH);
		let text = data.toString();
		if (!text.includes(`./news/${date}.md`)) {
			text = text.replace('<!-- INSERT -->', `<!-- INSERT -->\n- [${date}](./news/${date}.md)`);
			await writeFile(README_PATH, text);
		}
	} catch (e) {
		// README 不存在就算了
	}
	console.log('更新 README.md 完成');
};

// --- 主流程 ---
try {
	// 如果文件已存在且非空, 跳过 (避免重复抓取)
	try {
		const existing = await readFile(NEWS_MD_PATH);
		if (existing.toString().trim().length > 100) {
			console.log(`${DATE}.md 已存在且有内容, 跳过`);
			process.exit(0);
		}
	} catch (e) {
		// 文件不存在, 继续
	}

	const items = await getNewsList(DATE);
	if (items.length === 0) {
		console.log('没有找到新闻, 可能当天未更新');
		process.exit(0);
	}

	console.log('开始获取新闻详情...');
	const articles = [];
	for (let i = 0; i < items.length; i++) {
		try {
			const text = await getArticle(items[i].link);
			articles.push(text);
			console.count('已获取');
		} catch (e) {
			console.error(`获取失败: ${items[i].title}`, e.message);
			articles.push('');
		}
	}

	const md = toMarkdown({ date: DATE, items, articles });
	await writeFile(NEWS_MD_PATH, md);
	console.log('保存 Markdown 完成');

	await updateCatalogue({ date: DATE, firstTitle: items[0]?.title });
	console.log('全部成功, 程序结束');
} catch (e) {
	console.error('程序出错:', e);
	process.exit(1);
}
