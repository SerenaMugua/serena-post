# 贡献指南

## 提交问题

请提供 Obsidian 版本、SerenaPost 版本、操作系统、复现步骤和相关错误信息。公开日志前，请移除 AppSecret、访问令牌、代理账号密码和未发布的文章内容。

如果怀疑与其他插件冲突，请写明插件名称和版本；条件允许时，仅启用 SerenaPost 与发生冲突的插件再次测试。

## 本地开发

1. 运行 `npm install` 安装依赖。
2. 运行 `npm run build` 完成类型检查和构建。
3. 将 `main.js`、`manifest.json` 和 `styles.css` 复制到测试仓库的 `.obsidian/plugins/serena-post/` 目录。
4. 重新加载 Obsidian，并依次测试账号迁移、主题预览、复制、图片上传、草稿创建，以及插件关闭后重新启用。

请勿提交 `data.json`、任何账号密钥、自动生成的备份文件或 `node_modules`。

> 插件标识是 `serena-post`，请勿更改。代码里的 `wechat-multi-publisher` 是为从老版 WeChatPB 升级保留的名字（旧设置迁移、密钥存储、CSS 类名），也请勿更改。
