import appleMinimal from '../themes/Apple极简-黑.md';
import nikkeiRed from '../themes/Nikkei-红.md';
import bookCenter from '../themes/书刊居中-酒红.md';
import bookmarkBlue from '../themes/层级书签-蓝.md';
import newspaperRed from '../themes/报刊夹线-红.md';
import embossedIndigo from '../themes/浮雕卡片-靛蓝.md';
import clearMinimal from '../themes/清水极简-黑.md';
import fadedLine from '../themes/渐隐底线-粉紫.md';
import capsuleGreen from '../themes/胶囊药丸-绿.md';
import markerGreen from '../themes/荧光马克-绿.md';
import markerBlue from '../themes/荧光马克-蓝.md';
import neonDark from '../themes/霓虹暗底-青紫.md';
import blueWhiteCase from '../themes/蓝白案例.md';
import greenWhiteClean from '../themes/绿白清简.md';
import serenaBlue from '../themes/Serena蓝白.md';

export const DEFAULT_BUILTIN_THEME = '绿白清简';

export interface BuiltinThemeDocument {
	name: string;
	content: string;
	description: string;
	accent: string;
	legacyNames?: string[];
	headingLabel?: string;
	headingNumbers?: boolean;
	codeWindow?: boolean;
}

/**
 * A final compatibility pass shared by every built-in theme.
 * It keeps long-form reading rhythm consistent without erasing each theme's
 * color, borders, backgrounds, or decorative identity.
 */
export const BUILTIN_THEME_REFINEMENT = `
.note-to-mp {
  width: 100%;
  max-width: 677px;
  margin-left: auto;
  margin-right: auto;
  padding-left: 20px;
  padding-right: 20px;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 16px;
  line-height: 1.8 !important;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.note-to-mp p {
  margin-top: 0;
  margin-bottom: 20px !important;
  font-size: 16px;
  line-height: 1.85 !important;
}

.note-to-mp h1 {
  margin-top: 0;
  margin-bottom: 32px;
  font-size: 26px;
  line-height: 1.4 !important;
}

.note-to-mp h2 {
  margin-top: 44px !important;
  margin-bottom: 22px !important;
  font-size: 20px;
  line-height: 1.45 !important;
}

.note-to-mp h3 {
  margin-top: 30px !important;
  margin-bottom: 16px !important;
  font-size: 17px;
  line-height: 1.5 !important;
}

.note-to-mp h4,
.note-to-mp h5,
.note-to-mp h6 {
  margin-top: 26px !important;
  margin-bottom: 14px !important;
  font-size: 16px;
  line-height: 1.55 !important;
}

.note-to-mp blockquote,
.note-to-mp ul,
.note-to-mp ol,
.note-to-mp .code-section {
  margin-top: 0;
  margin-bottom: 24px !important;
}

.note-to-mp blockquote p:last-child,
.note-to-mp li p:last-child {
  margin-bottom: 0 !important;
}

.note-to-mp img {
  max-width: 100%;
  height: auto;
  box-sizing: border-box;
}
`.trim();

export const BUILTIN_THEME_DOCUMENTS: ReadonlyArray<BuiltinThemeDocument> = [
	{
		name: 'Serena 蓝白',
		content: serenaBlue,
		description: 'Serena 木瓜 IP 配色：深蓝 + 亮蓝，章节序号标题，Mac 窗口代码块，全框线表格左对齐',
		accent: '#0058a3',
		headingNumbers: true,
		codeWindow: true
	},
	{
		name: '绿白清简',
		content: greenWhiteClean,
		description: '绿色与白色的品牌留白，适合教程、方法论与日常长文',
		accent: '#01a539',
		legacyNames: ['Zhouxing·绿白'],
		headingLabel: 'TITEL'
	},
	{
		name: '蓝白案例',
		content: blueWhiteCase,
		description: '蓝白卡片与数据感标题，适合案例拆解和工具教程',
		accent: '#1565c0',
		legacyNames: ['Tata·蓝白'],
		headingLabel: 'TITEL'
	},
	{
		name: '墨白极简',
		content: appleMinimal,
		description: '克制的黑白灰层级，适合通用观点和产品文章',
		accent: '#1d1d1f',
		legacyNames: ['Apple极简-黑']
	},
	{
		name: '赤红报刊',
		content: nikkeiRed,
		description: '高对比赤红报刊感，适合新闻、趋势和评论',
		accent: '#c41230',
		legacyNames: ['Nikkei-红']
	},
	{
		name: '酒红书刊',
		content: bookCenter,
		description: '酒红色书刊气质，适合访谈、人物和文化内容',
		accent: '#9f1239',
		legacyNames: ['书刊居中-酒红']
	},
	{
		name: '靛蓝书签',
		content: bookmarkBlue,
		description: '靛蓝层级书签，适合结构清晰的知识教程',
		accent: '#2563eb',
		legacyNames: ['层级书签-蓝']
	},
	{
		name: '赤红夹线',
		content: newspaperRed,
		description: '红色夹线与纸面感，适合观点、专栏和复盘',
		accent: '#c9302c',
		legacyNames: ['报刊夹线-红']
	},
	{
		name: '靛蓝浮雕',
		content: embossedIndigo,
		description: '靛蓝卡片与轻浮雕，适合清单、框架和步骤内容',
		accent: '#4338ca',
		legacyNames: ['浮雕卡片-靛蓝']
	},
	{
		name: '清墨留白',
		content: clearMinimal,
		description: '清淡墨色与大留白，适合随笔和长篇阅读',
		accent: '#4a4a4a',
		legacyNames: ['清水极简-黑']
	},
	{
		name: '粉紫渐隐',
		content: fadedLine,
		description: '粉紫渐变与柔和分隔，适合生活方式和轻内容',
		accent: '#db2777',
		legacyNames: ['渐隐底线-粉紫']
	},
	{
		name: '青绿胶囊',
		content: capsuleGreen,
		description: '青绿色胶囊标题，适合技巧、问答和行动清单',
		accent: '#10b981',
		legacyNames: ['胶囊药丸-绿']
	},
	{
		name: '绿荧标记',
		content: markerGreen,
		description: '绿色荧光标记，适合重点较多的教程和笔记',
		accent: '#34d399',
		legacyNames: ['荧光马克-绿']
	},
	{
		name: '蓝荧标记',
		content: markerBlue,
		description: '蓝色高亮标记，适合工具、效率和技术文章',
		accent: '#0015e4',
		legacyNames: ['荧光马克-蓝']
	},
	{
		name: '青紫霓虹',
		content: neonDark,
		description: '青紫暗色霓虹，适合科技、未来感和代码内容',
		accent: '#22d3ee',
		legacyNames: ['霓虹暗底-青紫']
	}
];
