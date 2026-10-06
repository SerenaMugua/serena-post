export const CUSTOM_THEME_AI_GUIDE = `请为 SerenaPost 设计一套微信公众号长文 CSS 排版。

请严格遵守以下规范：
1. 只输出一个 \`\`\`css 代码块，不要输出 HTML、JavaScript 或解释文字。
2. 所有选择器必须以 .note-to-mp 开头，避免影响 Obsidian 的其他界面。
3. 至少覆盖：.note-to-mp、h1、h2、h3、p、strong、em、a、blockquote、ul、ol、li、code、.code-section、.code-section pre、.code-section code、img、hr。
4. 正文建议 16px，行高 1.75-1.9；h1 建议 24-28px，h2 建议 19-22px，h3 建议 16-18px。
5. 内容宽度不超过 677px，图片 max-width: 100%，长链接和代码必须允许换行。
6. 使用系统字体，不使用 @import、外部字体、外链背景图、动画、hover 依赖、CSS 变量、CSS counter 或复杂 @media。
7. 微信最终使用内联样式，因此装饰要尽量依靠颜色、边框、圆角、背景和留白完成。
8. 保证白底下正文和标题有足够对比度，避免过浅文字、过强阴影和大面积高饱和背景。

请以这份兼容示例为基础设计，而不是改变选择器结构：

\`\`\`css
.note-to-mp {
  max-width: 677px;
  margin: 0 auto;
  padding: 0 20px 32px;
  background: #ffffff !important;
  color: #334155 !important;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 16px;
  line-height: 1.85 !important;
  word-break: break-word;
}

.note-to-mp p {
  margin: 0 0 20px !important;
  color: #334155 !important;
  font-size: 16px;
  line-height: 1.85 !important;
  text-align: justify !important;
}

.note-to-mp h1 {
  margin: 0 0 32px;
  color: #0f172a !important;
  font-size: 26px;
  line-height: 1.4 !important;
}

.note-to-mp h2 {
  margin: 44px 0 22px !important;
  padding-left: 12px;
  border-left: 4px solid #2563eb;
  color: #0f172a !important;
  font-size: 20px;
  line-height: 1.45 !important;
}

.note-to-mp h3 {
  margin: 30px 0 16px !important;
  color: #1e293b !important;
  font-size: 17px;
  line-height: 1.5 !important;
}

.note-to-mp strong { color: #0f172a !important; font-weight: 700; }
.note-to-mp em { color: #2563eb !important; font-style: normal; }
.note-to-mp a { color: #2563eb !important; text-decoration: none; }

.note-to-mp blockquote {
  margin: 0 0 24px !important;
  padding: 16px 18px;
  border-left: 4px solid #2563eb;
  background: #eff6ff !important;
  color: #475569 !important;
}

.note-to-mp ul,
.note-to-mp ol { margin: 0 0 24px; padding-left: 24px; }
.note-to-mp li { margin: 7px 0; line-height: 1.8 !important; }

.note-to-mp code {
  padding: 2px 6px;
  border-radius: 4px;
  background: #eff6ff !important;
  color: #1d4ed8 !important;
  font-family: Menlo, Monaco, Consolas, monospace;
}

.note-to-mp .code-section {
  margin: 0 0 24px;
  padding: 18px;
  border-radius: 10px;
  background: #0f172a !important;
  overflow-x: auto;
}

.note-to-mp .code-section pre { margin: 0; padding: 0; background: transparent !important; }
.note-to-mp .code-section code { display: block; padding: 0; background: transparent !important; color: #dbeafe !important; }
.note-to-mp img { max-width: 100%; height: auto; display: block; margin: 28px auto; border-radius: 10px; }
.note-to-mp hr { margin: 44px 0 30px; border: none; border-top: 1px solid #e2e8f0; }
\`\`\`

请保持这些兼容规则，再根据我接下来提供的参考图片、品牌颜色或文章类型完成视觉设计。`;
