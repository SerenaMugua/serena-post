/**
 * 可视化排版编辑器：左边调参数，右边用当前笔记实时预览。
 */
import { App, Modal, Notice, Setting, sanitizeHTMLToDom } from 'obsidian';
import { MarkedFormatter } from '../utils/formatter';
import type { Theme } from '../utils/theme-manager';
import { FONT_STACKS, buildCustomCss, defaultDef, newThemeId, type CustomThemeDef } from './custom-theme';

export interface ThemeEditorOptions {
	builtins: Theme[];
	/** 正在编辑的自定义排版；为空表示新建 */
	editing?: CustomThemeDef;
	/** 新建时的初始底版 */
	startBase: string;
	/** 已有自定义排版名称（查重用） */
	existingNames: string[];
	/** 预览用的笔记 Markdown（已处理图片） */
	previewMarkdown: string;
	onSave: (def: CustomThemeDef, isNew: boolean) => Promise<void>;
	onDelete?: (def: CustomThemeDef) => Promise<void>;
	onExport?: (def: CustomThemeDef) => Promise<void>;
}

const SAMPLE_MD = `# 文章标题示例

这是一段正文示例，用来预览字号、行距和段间距的效果。**这是加粗文字**，这是普通文字。

## 二级标题示例

> 这是一段引用：好的排版让读者更愿意读完。

- 列表第一项
- 列表第二项

### 三级标题示例

再来一段正文，看看段落之间的距离是否舒服。`;

export class ThemeEditorModal extends Modal {
	private d: CustomThemeDef;
	private isNew: boolean;
	private previewEl!: HTMLElement;
	private timer: number | null = null;

	constructor(app: App, private opts: ThemeEditorOptions) {
		super(app);
		this.isNew = !opts.editing;
		if (opts.editing) {
			this.d = { ...opts.editing };
		} else {
			const base = opts.builtins.find(t => t.name === opts.startBase) ?? opts.builtins[0];
			this.d = defaultDef(base.name, base.accent ?? '');
			this.d.name = this.uniqueName(`我的${base.name}`);
		}
	}

	private uniqueName(name: string): string {
		let n = name;
		let i = 2;
		while (this.opts.existingNames.includes(n)) n = `${name} ${i++}`;
		return n;
	}

	private get base(): Theme {
		return this.opts.builtins.find(t => t.name === this.d.base) ?? this.opts.builtins[0];
	}

	onOpen() {
		this.modalEl.addClass('serena-theme-editor');
		this.titleEl.setText(this.isNew ? '新建排版' : `编辑排版：${this.opts.editing!.name}`);
		const wrap = this.contentEl.createDiv({ cls: 'ste-wrap' });
		const left = wrap.createDiv({ cls: 'ste-controls' });
		const right = wrap.createDiv({ cls: 'ste-preview-col' });
		right.createDiv({ cls: 'ste-preview-label', text: '实时预览（当前笔记）' });
		const phone = right.createDiv({ cls: 'ste-phone' });
		this.previewEl = phone.createDiv({ cls: 'ste-preview' });
		this.renderControls(left);
		this.renderFooter();
		this.refresh();
	}

	onClose() {
		if (this.timer) window.clearTimeout(this.timer);
		this.contentEl.empty();
	}

	private schedule() {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.refresh(), 150);
	}

	private refresh() {
		const base = this.base;
		const css = buildCustomCss(base.css, base.accent ?? '', this.d);
		const md = this.opts.previewMarkdown.trim() ? this.opts.previewMarkdown : SAMPLE_MD;
		try {
			const html = MarkedFormatter.markdownToHtmlSync(md, css, {
				headingLabel: this.d.h2Style === 'theme' ? base.headingLabel : undefined
			});
			this.previewEl.replaceChildren(sanitizeHTMLToDom(html));
		} catch (e) {
			this.previewEl.setText(`预览失败：${e instanceof Error ? e.message : e}`);
		}
	}

	private section(el: HTMLElement, title: string) {
		el.createEl('div', { cls: 'ste-section', text: title });
	}

	private renderControls(el: HTMLElement) {
		el.empty();
		const d = this.d;
		const set = (fn: () => void) => { fn(); this.schedule(); };

		new Setting(el).setName('排版名称').addText(t => t
			.setValue(d.name)
			.onChange(v => { d.name = v.trim(); }));

		new Setting(el).setName('底版').setDesc('在哪套内置排版的基础上修改').addDropdown(dd => {
			for (const t of this.opts.builtins) dd.addOption(t.name, t.name);
			dd.setValue(d.base).onChange(v => {
				const oldAccent = this.base.accent ?? '';
				d.base = v;
				// 主色没改过就跟着新底版走
				if (!d.accent || d.accent.toLowerCase() === oldAccent.toLowerCase()) d.accent = this.base.accent ?? d.accent;
				this.renderControls(el);
				this.schedule();
			});
		});

		this.section(el, '颜色');
		new Setting(el).setName('主色').setDesc('标题、强调、引用线等会一起换色')
			.addColorPicker(c => c.setValue(d.accent || this.base.accent || '#07c160').onChange(v => set(() => { d.accent = v; })))
			.addExtraButton(b => b.setIcon('rotate-ccw').setTooltip('恢复底版主色').onClick(() => {
				d.accent = this.base.accent ?? '';
				this.renderControls(el);
				this.schedule();
			}));
		new Setting(el).setName('正文颜色')
			.addColorPicker(c => c.setValue(d.textColor || '#333333').onChange(v => set(() => { d.textColor = v; })))
			.addExtraButton(b => b.setIcon('rotate-ccw').setTooltip('跟随底版').onClick(() => {
				d.textColor = '';
				this.renderControls(el);
				this.schedule();
			}));
		new Setting(el).setName('加粗文字颜色').addDropdown(dd => dd
			.addOptions({ theme: '跟随底版', accent: '主色', text: '和正文一样' })
			.setValue(d.boldColor).onChange(v => set(() => { d.boldColor = v as CustomThemeDef['boldColor']; })));

		this.section(el, '文字');
		new Setting(el).setName('字体').addDropdown(dd => {
			for (const [k, v] of Object.entries(FONT_STACKS)) dd.addOption(k, v.label);
			dd.setValue(d.fontFamily).onChange(v => set(() => { d.fontFamily = v as CustomThemeDef['fontFamily']; }));
		});
		this.slider(el, '字号', d.fontSize, 13, 20, 0.5, v => `${v}px`, v => { d.fontSize = v; });
		this.slider(el, '行距', d.lineHeight, 1.4, 2.4, 0.05, v => `${v.toFixed(2)} 倍`, v => { d.lineHeight = v; });
		this.slider(el, '字间距', d.letterSpacing, 0, 0.12, 0.01, v => `${v.toFixed(2)}em`, v => { d.letterSpacing = v; });
		this.slider(el, '段落间距', d.paragraphSpacing, 0, 40, 1, v => `${v}px`, v => { d.paragraphSpacing = v; });
		new Setting(el).setName('正文对齐').addDropdown(dd => dd
			.addOptions({ theme: '跟随底版', justify: '两端对齐', left: '左对齐' })
			.setValue(d.textAlign).onChange(v => set(() => { d.textAlign = v as CustomThemeDef['textAlign']; })));

		this.section(el, '组件');
		new Setting(el).setName('二级标题样式').addDropdown(dd => dd
			.addOptions({ theme: '跟随底版', bar: '左侧色条', underline: '下划线', pill: '色块胶囊', plain: '纯文字' })
			.setValue(d.h2Style).onChange(v => set(() => { d.h2Style = v as CustomThemeDef['h2Style']; })));
		new Setting(el).setName('标题对齐').addDropdown(dd => dd
			.addOptions({ theme: '跟随底版', left: '左对齐', center: '居中' })
			.setValue(d.headingAlign).onChange(v => set(() => { d.headingAlign = v as CustomThemeDef['headingAlign']; })));
		new Setting(el).setName('引用样式').addDropdown(dd => dd
			.addOptions({ theme: '跟随底版', bar: '左侧细线', card: '浅色卡片', plain: '纯文字斜体' })
			.setValue(d.quoteStyle).onChange(v => set(() => { d.quoteStyle = v as CustomThemeDef['quoteStyle']; })));
		new Setting(el).setName('图片圆角').addDropdown(dd => dd
			.addOptions({ '-1': '跟随底版', '0': '直角', '6': '小圆角', '12': '大圆角' })
			.setValue(String(d.imageRadius)).onChange(v => set(() => { d.imageRadius = parseInt(v, 10); })));
		new Setting(el).setName('图片阴影').addToggle(t => t
			.setValue(d.imageShadow).onChange(v => set(() => { d.imageShadow = v; })));
	}

	private slider(el: HTMLElement, name: string, value: number, min: number, max: number, step: number,
		fmt: (v: number) => string, apply: (v: number) => void) {
		const s = new Setting(el).setName(name);
		const label = s.controlEl.createSpan({ cls: 'ste-value', text: fmt(value) });
		s.addSlider(sl => sl.setLimits(min, max, step).setValue(value).onChange(v => {
			apply(v);
			label.setText(fmt(v));
			this.schedule();
		}));
		s.controlEl.appendChild(label);
	}

	private renderFooter() {
		const footer = this.contentEl.createDiv({ cls: 'ste-footer' });
		const left = footer.createDiv({ cls: 'ste-footer-left' });
		const right = footer.createDiv({ cls: 'ste-footer-right' });

		if (!this.isNew) {
			if (this.opts.onExport) {
				left.createEl('button', { text: '导出分享' }).onclick = () => void this.opts.onExport!(this.d);
			}
			if (this.opts.onDelete) {
				const del = left.createEl('button', { text: '删除', cls: 'mod-warning' });
				del.onclick = async () => {
					if (del.dataset.confirm !== '1') {
						del.dataset.confirm = '1';
						del.setText('再点一次确认删除');
						return;
					}
					await this.opts.onDelete!(this.opts.editing!);
					this.close();
				};
			}
		}

		right.createEl('button', { text: '取消' }).onclick = () => this.close();
		if (!this.isNew) {
			right.createEl('button', { text: '另存为新排版' }).onclick = () => void this.save(true);
		}
		const main = right.createEl('button', { text: this.isNew ? '保存为新排版' : '保存修改', cls: 'mod-cta' });
		main.onclick = () => void this.save(this.isNew);
	}

	private async save(asNew: boolean) {
		const name = this.d.name.trim();
		if (!name) { new Notice('请给排版起个名字'); return; }
		if (name.length > 30) { new Notice('名字最多 30 个字'); return; }
		const others = this.opts.existingNames.filter(n => asNew || n !== this.opts.editing?.name);
		if (others.includes(name)) { new Notice(`已经有叫「${name}」的排版了，换个名字吧`); return; }
		const def: CustomThemeDef = { ...this.d, name };
		if (asNew) {
			def.id = newThemeId();
			def.createdAt = new Date().toISOString();
		}
		await this.opts.onSave(def, asNew);
		this.close();
	}
}
