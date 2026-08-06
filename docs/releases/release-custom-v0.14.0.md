# ZhongShiJie-Code 定制版 v0.14.0

## 基线

本版本以官方 `v0.14.0` 为基线，定制源码位于分支 `custom/v0.14.0-source`。
官方仓库使用 `upstream`，个人 Fork 使用 `origin`；官方 `main` 不被定制提交覆盖。

## 保留的定制功能

- Claude Desktop Cowork 会话映射、桌面端点击唤回和独立头像。
- DeepSeek 余额读取、官网导出数据读取、模型消耗和缓存命中率展示。
- DeepSeek 导出数据按 10 分钟检查一次，并以临时目录和 staging 目录避免半成品覆盖。
- Codex 订阅配额保持官方 v0.14 的 quota ring，不再叠加旧版自定义配额读取。
- Claude Desktop 和 Claude Desktop MCP 头像经过统一 64x64 资源导出，避免 HUD 裁切。

## 明确不带回的功能

- 手机端/PWA 控制能力。
- OpenClaw 主会话/子代理停止控制和相关远程控制逻辑。
- Hermes/其他旧版整文件替换；新版官方 Agent 注册表和会话恢复逻辑优先。

## 安全边界

- 不提交 API Key、Cookie、登录资料、token、Chrome 用户数据、`app.asar` 或本机备份。
- DeepSeek 导出使用现有浏览器登录态的临时副本，不直接改写浏览器原始 profile。
- GitHub `main` 保持官方快照，定制版本通过独立分支发布和测试。

## 验证

```sh
npm run verify:release
npm run verify:custom
node --test test/deepseek-export.test.js test/deepseek-usage.test.js test/claude-desktop-cowork-bridge.test.js test/session-focus.test.js test/state-agent-icons.test.js test/session-hud-style.test.js
```

完整测试若卡在移动预览服务器测试，应记录为测试基础设施/生命周期问题，不把它误报为定制功能通过。
