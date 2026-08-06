# 定制版发布流程

## 仓库角色

- `upstream`: `rullerzhou-afk/clawd-on-desk`，只读官方来源。
- `origin`: `ZhongShiJie-Code/clawd-on-desk`，保存个人定制分支。
- `main`: 官方快照，不直接混入定制代码。
- `custom/v0.14.0-source`: 可构建、可回溯的定制源码分支。

## 升级原则

1. 新建独立工作树，以 `upstream/main` 为新版基线。
2. 先移植独立模块和小范围补丁，不把旧版 `src/main.js`、`src/state.js`、`src/session-hud.js` 整文件覆盖新版。
3. 每移植一类功能就运行对应测试；图标必须通过官方导出器更新来源清单和输出 hash。
4. 通过 `verify:release`、`verify:custom`、定向测试后再提交。
5. 推送到 Fork 的独立分支；确认分支内容后，再决定是否制作 GitHub Release 或本机安装包。

## 当前功能归属

数据模块：`src/deepseek-balance.js`、`src/deepseek-export.js`、`src/deepseek-usage.js`；Codex 配额由官方 v0.14 quota ring 提供。

显示接入：`src/session-hud.js`、`src/session-hud-renderer.js`、`src/session-hud.html`。

Claude Desktop：`agents/claude-desktop.js`、`src/claude-desktop-cowork-bridge.js`、`hooks/clawd-hook.js`。

## 回滚

本机安装和 GitHub 源码分开处理。升级失败时只切回上一条 `custom/*` 分支或上一版安装包，不回滚用户原工作目录的未提交改动。
