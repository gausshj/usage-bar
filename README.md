# Usage-Bar

> Coding Plan 配额看板 — Codex / GLM Coding Plan / Kimi Code 的本地用量监控

## 简介

Usage-Bar 是一个本地优先的 Web Dashboard，帮助同时订阅多个 AI 编程服务的开发者，在一个页面查看当前配额、剩余额度、重置时间和用量明细。

v1 首发支持三个产品：

1. **Codex**（ChatGPT / Codex 账户配额）
2. **GLM Coding Plan**
3. **Kimi Code**

> 产品规格见内部 PRD 文档（不公开）。

## 特性

- 📊 **三卡配额看板** — 固定显示 Codex / GLM / Kimi 三张卡片，含已用/剩余百分比、重置倒计时
- 🔌 **多数据源等级** — 区分官方协议（Codex App Server）、官方兼容（GLM/Kimi）、本地估算（降级）
- 🧯 **容错降级** — 单个供应商失败不影响其他家；失败时保留上次有效数据并标记 Stale
- 🔒 **本地优先** — 默认仅监听 `127.0.0.1`，凭据不经过数据库、不外传
- 📈 **Codex Activity (Beta)** — 从本地 session 文件估算近 7 天 token 用量

## 快速开始

> ⚠️ 项目处于 v1 开发阶段（Local Alpha）

```bash
git clone git@github.com:gausshj/usage-bar.git
cd usage-bar
npm install
npm run dev          # 默认绑定 127.0.0.1:3000
```

打开 `http://127.0.0.1:3000`。

## 凭据配置

凭据通过环境变量注入（受 `.gitignore` 保护），在项目根目录创建 `.env.local`：

```bash
# 智谱 GLM Coding Plan token（裸 token，非 Bearer）
GLM_CODING_PLAN_TOKEN=你的-glm-coding-plan-token
GLM_CODING_PLAN_REGION=bigmodel   # 可选: bigmodel (默认, open.bigmodel.cn) | zai (api.z.ai)

# Kimi Code（可选；不配则自动读取 ~/.kimi-code/credentials/kimi-code.json）
KIMI_CODE_ACCESS_TOKEN=你的-kimi-code-access-token
```

| Provider | 数据来源 | 凭据 | 数据源等级 |
|---|---|---|---|
| **Codex** | Codex App Server（`account/rateLimits/read`） | 无需（复用本地 Codex 登录态） | Official Protocol |
| **GLM** | `open.bigmodel.cn/api/monitor/usage/quota/limit` | `GLM_CODING_PLAN_TOKEN` | Official Compatibility |
| **Kimi** | `api.kimi.com/coding/v1/usages` | kimi-cli 登录态 / `KIMI_CODE_ACCESS_TOKEN` | Official Compatibility |

- Codex 在 App Server 不可用时，降级为解析本地 `~/.codex/sessions` 文件（标注 Local Estimate）。
- 未配置或失败的供应商显示对应状态卡片（unconfigured / stale / error），不影响其他卡片。
- **注意**：Kimi Code 用量 ≠ Moonshot Open Platform 余额，二者不可混用。

## 技术栈

- **框架**: Next.js 15（App Router，前后端一体）
- **前端**: React 19 + TypeScript + Tailwind CSS
- **后端**: Next.js Route Handlers（`/api/v1/quota`）
- **测试**: Vitest（86 个单元测试）
- **校验**: ESLint + tsc

## 项目结构

```
src/
├── quota/           配额模块（PRD 数据契约 + 三家 adapter + 聚合 service）
│   ├── contract.ts      统一数据契约（ProviderStatus / QuotaSnapshot …）
│   ├── providers/       codex / glm / kimi 各自的 adapter
│   ├── service.ts       聚合：缓存 + singleflight + stale 降级
│   └── http.ts          共享 HTTP helper（timeout / retry / redaction）
├── usage/           Codex Activity（Beta）本地 token 明细
└── app/             页面 + API 路由
```

## 贡献流程

所有变更通过 feature branch 和 Pull Request 合并到 main。

## License

MIT
