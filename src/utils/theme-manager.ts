import { App, TFile, TFolder, Notice, normalizePath } from 'obsidian';
import { BUILTIN_THEME_DOCUMENTS, BUILTIN_THEME_REFINEMENT, DEFAULT_BUILTIN_THEME } from '../builtin-themes';
import { buildCustomCss, type CustomThemeDef } from '../theme-editor/custom-theme';

export interface Theme {
	name: string;           // 显示名称
	filename: string;       // 文件名（不含扩展名）
	css: string;           // CSS内容
	path: string;          // 完整路径
	builtin?: boolean;
	description?: string;
	accent?: string;
	aliases?: string[];
	headingLabel?: string;
	headingNumbers?: boolean;
	codeWindow?: boolean;
	/** SerenaPost 可视化编辑器做的排版 */
	customDef?: CustomThemeDef;
}

export const CUSTOM_THEME_PREFIX = '★ ';

export class ThemeManager {
	app: App;
	themes: Theme[] = [];
	themesFolder: string = '';
	customThemesEnabled: boolean = false;
	customDefs: CustomThemeDef[] = [];

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * 设置CSS文件夹路径
	 */
	setThemesFolder(folderPath: string) {
		this.themesFolder = folderPath;
	}

	setCustomThemesEnabled(enabled: boolean) {
		this.customThemesEnabled = enabled;
	}

	setCustomDefs(defs: CustomThemeDef[]) {
		this.customDefs = defs;
	}

	/** 内置排版（作为自定义排版的底） */
	getBuiltinThemes(): Theme[] {
		return this.themes.filter(t => t.builtin);
	}

	/** 把一条自定义排版定义变成可用的 Theme */
	buildFromDef(def: CustomThemeDef): Theme {
		const base = this.themes.find(t => t.builtin && (t.name === def.base || t.aliases?.includes(def.base)))
			?? this.themes.find(t => t.builtin)!;
		return {
			name: CUSTOM_THEME_PREFIX + def.name,
			filename: def.id,
			css: buildCustomCss(base.css, base.accent ?? '', def),
			path: `custom:${def.id}`,
			builtin: false,
			description: `基于「${base.name}」的自定义排版`,
			accent: def.accent || base.accent,
			headingLabel: def.h2Style === 'theme' ? base.headingLabel : undefined,
			headingNumbers: def.h2Style === 'theme' ? base.headingNumbers : undefined,
			codeWindow: base.codeWindow,
			customDef: def
		};
	}

	/**
	 * 加载所有CSS主题
	 */
	async loadThemes(): Promise<Theme[]> {
		this.themes = BUILTIN_THEME_DOCUMENTS.map(({ name, content, description, accent, legacyNames, headingLabel, headingNumbers, codeWindow }) => ({
			name,
			filename: name,
			css: `${this.extractCss(content)}\n\n${BUILTIN_THEME_REFINEMENT}`,
			path: `builtin:${name}`,
			builtin: true,
			description,
			accent,
			aliases: legacyNames,
			headingLabel,
			headingNumbers,
			codeWindow
		})).filter(theme => theme.css.length > 0);

		for (const def of this.customDefs) {
			try {
				this.themes.push(this.buildFromDef(def));
			} catch (e) {
				console.error('[SerenaPost] 自定义排版加载失败', def.name, e);
			}
		}

		if (!this.customThemesEnabled || !this.themesFolder) {
			return this.themes;
		}

		try {
			// 清理路径：移除开头的斜杠
			const cleanPath = normalizePath(this.themesFolder.trim());

			// 获取文件夹
			const folder = this.app.vault.getAbstractFileByPath(cleanPath);

			if (!folder) {
				// 显示更详细的错误信息
				new Notice(`找不到文件夹: ${cleanPath}\n\n提示：请使用相对于 vault 根目录的路径\n例如：wechat-styles 或 styles/wechat`, 8000);
				return this.themes;
			}

			if (!(folder instanceof TFolder)) {
				new Notice(`"${cleanPath}" 不是一个文件夹`, 5000);
				return this.themes;
			}

			// 遍历文件夹中的所有CSS文件和包含CSS的MD文件
			for (const file of folder.children) {
				if (file instanceof TFile) {
					try {
						let css = '';
						let themeName = file.basename;

						// 处理 .css 文件
						if (file.extension === 'css') {
							css = await this.app.vault.read(file);
						}
						// 处理 .md 文件（可能包含 CSS 代码块）
						else if (file.extension === 'md') {
							const content = await this.app.vault.read(file);
							// 提取 ```css 或 ```CSS 代码块中的内容
							css = this.extractCss(content);
							if (!css) {
								// 如果没有找到 CSS 代码块，跳过这个文件
								continue;
							}
						} else {
							// 其他文件类型跳过
							continue;
						}

						if (css) {
							const theme: Theme = {
								name: themeName,
								filename: themeName,
								css: css,
								path: file.path
							};
							this.themes.push(theme);
						}
					} catch (error) {
						console.error(`Failed to load theme: ${file.path}`, error);
					}
				}
			}

			const customThemeCount = this.themes.filter(theme => !theme.builtin && !theme.customDef).length;
			if (customThemeCount > 0) {
				new Notice(`已加载 ${customThemeCount} 个自定义主题`, 3000);
			} else {
				new Notice(`文件夹 "${cleanPath}" 中没有找到 CSS 文件或包含 CSS 代码块的 MD 文件`, 5000);
			}
		} catch (error) {
			console.error('Failed to load themes:', error);
			new Notice(`加载主题失败: ${error.message}`, 5000);
		}

		return this.themes;
	}

	private extractCss(content: string): string {
		const matches = Array.from(content.matchAll(/```css\s*\n([\s\S]*?)```/gi));
		return matches.map(match => match[1].trim()).filter(Boolean).join('\n\n');
	}

	/**
	 * 根据名称获取主题
	 */
	getTheme(name: string): Theme | undefined {
		return this.themes.find(t => t.name === name || t.filename === name || t.aliases?.includes(name));
	}

	/**
	 * 获取所有主题名称列表
	 */
	getThemeNames(): string[] {
		return this.themes.map(t => t.name);
	}

	getThemes(): readonly Theme[] {
		return this.themes;
	}

	/**
	 * 获取默认主题
	 */
	getDefaultTheme(): Theme {
		return this.getTheme(DEFAULT_BUILTIN_THEME) ?? this.themes[0];
	}
}

/** 主题 → 渲染选项（标题序号、代码窗口） */
export function formatterOptionsFor(theme: Theme) {
	return { headingLabel: theme.headingLabel, headingNumbers: theme.headingNumbers, codeWindow: theme.codeWindow };
}
