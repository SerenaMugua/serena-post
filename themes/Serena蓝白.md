# Serena 蓝白

Serena 木瓜 IP 配色：深蓝 #0058a3 + 亮蓝 #53a4ea + 两个近白。
章节标题带「01」序号与粗下划线；引用、代码块、表格用同一套框线：深蓝外框 + 浅色内容；表格文字左对齐。

```css
.note-to-mp {
  max-width: 677px;
  margin: 0 auto;
  padding: 0 20px 32px;
  background: #ffffff !important;
  color: #1b252d !important;
  font-family: "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 16px;
  line-height: 1.9 !important;
  letter-spacing: 1px;
  word-break: break-word;
}

.note-to-mp p {
  margin: 10px 0 15px !important;
  color: #1b252d !important;
  font-size: 16px;
  line-height: 1.9 !important;
  letter-spacing: 1px;
  text-align: left !important;
}

.note-to-mp h1 {
  margin: 8px 0 30px;
  padding: 0 0 14px;
  border-bottom: 3px solid #0058a3;
  color: #0058a3 !important;
  font-size: 24px;
  font-weight: 900;
  line-height: 1.45 !important;
  text-align: left;
}

.note-to-mp h2 {
  display: table;
  margin: 44px auto 24px !important;
  padding: 0 4px 6px;
  border-bottom: 4px solid #53a4ea;
  color: #0058a3 !important;
  font-size: 19px;
  font-weight: 900;
  line-height: 1.45 !important;
  letter-spacing: 0.5px;
  text-align: center;
}

.note-to-mp h2.sp-has-avatar:not(.sp-h) {
  padding: 0 !important;
  border-bottom: none !important;
}

.note-to-mp h2.sp-has-avatar:not(.sp-h) .sp-h-text {
  display: inline-block;
  max-width: 82%;
  padding: 0 4px 6px;
  border-bottom: 4px solid #53a4ea;
  vertical-align: middle;
}

.note-to-mp .wechatpb-heading-label {
  display: inline-block;
  margin: 0 10px 0 0;
  color: #0058a3 !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 19px;
  font-weight: 900;
}

.note-to-mp h3 {
  margin: 32px 0 13px;
  padding: 0 0 0 12px;
  border-left: 5px solid #53a4ea;
  color: #0058a3 !important;
  font-size: 17px;
  font-weight: 800;
  line-height: 1.5 !important;
}

.note-to-mp h4 {
  margin: 26px 0 10px;
  color: #0058a3 !important;
  font-size: 16px;
  font-weight: 800;
}

.note-to-mp strong {
  color: #53a4ea !important;
  font-weight: 800;
}

.note-to-mp em {
  color: #0058a3 !important;
}

.note-to-mp a {
  color: #0058a3 !important;
  text-decoration: none;
  border-bottom: 2px solid #53a4ea;
}

.note-to-mp blockquote {
  margin: 27px 0;
  padding: 16px 18px 16px 18px;
  border: 1px solid #c7d8e8;
  border-left: 4px solid #0058a3;
  background: #f5f9fc !important;
  color: #1b252d !important;
}

.note-to-mp blockquote p {
  margin: 0 !important;
  color: #1b252d !important;
}

.note-to-mp ul,
.note-to-mp ol {
  margin: 18px 0 24px;
  padding-left: 22px;
  color: #1b252d !important;
}

.note-to-mp li {
  margin: 12px 0;
  line-height: 1.9 !important;
}

.note-to-mp li::marker {
  color: #0058a3;
  font-weight: 800;
}

.note-to-mp code {
  padding: 2px 5px;
  border-radius: 3px;
  background: #eff3f6 !important;
  color: #0058a3 !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 14px;
}

.note-to-mp .code-section {
  margin: 25px 0;
  padding: 0;
  border: 2px solid #0058a3;
  border-radius: 0;
  background: #f5f9fc !important;
  overflow-x: hidden;
}

.note-to-mp .code-window-bar {
  display: block;
  padding: 6px 11px;
  border-bottom: 2px solid #0058a3;
  background: #0058a3 !important;
  line-height: 1.2 !important;
}

.note-to-mp .code-window-dot {
  display: inline-block;
  margin-right: 5px;
  font-size: 10px;
  line-height: 1 !important;
}

.note-to-mp .code-window-dot-1 { color: #53a4ea !important; }
.note-to-mp .code-window-dot-2 { color: #fffdf6 !important; }
.note-to-mp .code-window-dot-3 { color: #83b4d7 !important; }

.note-to-mp .code-window-label {
  margin-left: 8px;
  color: rgba(255, 255, 255, 0.72) !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  line-height: 1.6 !important;
}

.note-to-mp .code-section pre {
  margin: 0;
  padding: 16px 18px 18px;
  border-radius: 0;
  background: #f5f9fc !important;
  white-space: pre-wrap !important;
  word-break: break-all !important;
}

.note-to-mp .code-section code {
  display: block;
  padding: 0;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none;
  color: #0b3a66 !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.6 !important;
  letter-spacing: 0;
}

.note-to-mp table {
  width: 100%;
  margin: 28px 0;
  border-collapse: collapse;
  border: 4px solid #53a4ea;
  font-size: 14.5px;
  line-height: 1.65 !important;
}

.note-to-mp th {
  padding: 10px 10px;
  border: 2px solid #53a4ea;
  border-bottom: 4px solid #53a4ea;
  background: #eff3f6 !important;
  color: #0058a3 !important;
  font-weight: 800;
  text-align: left !important;
}

.note-to-mp td {
  padding: 10px 10px;
  border: 2px solid #53a4ea;
  color: #1b252d !important;
  text-align: left !important;
  vertical-align: top;
}

.note-to-mp img {
  width: 100%;
  max-width: 100%;
  height: auto;
  display: block;
  margin: 28px auto 10px;
  border-radius: 3px;
}

.note-to-mp hr {
  height: 2px;
  margin: 36px 0;
  border: none;
  background: linear-gradient(90deg, rgba(83, 164, 234, 0), #53a4ea, rgba(83, 164, 234, 0));
}
```
