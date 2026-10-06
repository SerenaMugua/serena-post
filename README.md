<div align="center">

<img src="assets/serena-avatar.png" width="96" alt="SerenaPost">

# SerenaPost

### 一稿双发：在 Obsidian 里把一篇笔记推到「公众号草稿箱」和「X 文章草稿」

</div>

---

## 它能做什么

| 能力 | 说明 |
| --- | --- |
| 公众号排版 | 内置 14 套主题，实时预览，可导出长图 |
| 推到公众号草稿箱 | 走微信官方接口，正文图片、网络图片、封面自动上传；支持多个公众号 |
| 推到 X 文章草稿 | 通过 Kaitox Chrome 扩展，在你已登录的 X 页面里自动建好文章草稿 |
| 一键双发 | 勾选公众号和 X，确认一次，两边同时进草稿箱 |
| 自动封面 | 默认用笔记属性 `cover`，没有就用正文第一张图，可随时更换 |
| 发布前确认 | 统一确认标题、作者、摘要、封面、留言；X 的格式检查结果也在这里 |
| 内置中转 | 推 X 所需的本地中转程序已内置，Obsidian 开着就自动运行 |

## 安装

1. 从 Releases 下载 `main.js`、`manifest.json`、`styles.css`，放进仓库的 `.obsidian/plugins/serena-post/`。
2. Obsidian → 设置 → 第三方插件，启用 **SerenaPost**。
3. 左侧点 Serena 头像图标打开发布面板。

## 推送到公众号：准备

1. 设置 → SerenaPost → 添加账号，填公众号 AppID 和 AppSecret（「微信开发者平台 → 我的业务与服务 → 公众号 → 基础信息」，网址 developers.weixin.qq.com）。
2. 把插件提示的出口 IP 加进同一页开发信息里的 **IP 白名单**。
3. 账号需要有「草稿箱 / 素材管理」接口权限（未认证的个人号可能没有）。

AppSecret 保存在 Obsidian 的 SecretStorage，不会写进 `data.json`。

## 推送到 X：准备

只需要在 Chrome 里装好 **Kaitox 扩展** 并登录 X。

- 中转程序已内置在插件里，不需要再装 npm、敲命令。
- 如果你本来就在运行 Kaitox 的中转（`kaitox relay`），SerenaPost 会自动复用它。
- 推送后插件会打开 X 文章编辑器，扩展在那里接力创建草稿。

## 笔记属性（可选）

```yaml
title: 文章标题        # 不写用文件名
cover: "[[封面.png]]"  # 不写用正文第一张图
wx_author: Serena木瓜  # 公众号作者，不写用设置里的默认作者
digest: 一句话摘要      # 公众号摘要，不写用 description 截断
comment: true          # 公众号是否开留言
source_url: https://…  # 公众号「阅读原文」
```

## 本地构建

```bash
npm install
npm run build
```

## 致谢与许可

SerenaPost 基于两个 MIT 开源项目修改而来，感谢原作者：

- [WeChatPB](https://github.com/Kianzzz/wechatPB)（zhouxing）—— 公众号排版、多账号与草稿发布
- [Kaitox](https://github.com/kuangjiajia/kaitox-toolkit)（kaitox）—— X 文章预览、格式检查、中转协议与 Chrome 扩展

代码以 [MIT](LICENSE) 许可发布，第三方许可全文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
Serena 木瓜 IP 头像版权归作者所有，不在 MIT 许可范围内。
