# Usage-Bar

> Coding Plan 配额看板 — Codex / GLM Coding Plan / Kimi Code 的本地用量监控

[English](./README.en.md) | 简体中文

## 简介

Usage-Bar 是一个本地优先的 Web Dashboard，帮助同时订阅多个 AI 编程服务的开发者，在一个页面查看当前配额、剩余额度、重置时间和用量明细。

v1 支持三个产品：

1. **Codex**（ChatGPT / Codex 账户配额）
2. **GLM Coding Plan**
3. **Kimi Code**

> 产品规格见内部 PRD 文档（不公开）。

## 特性

- 📊 **三卡配额看板** — 固定显示 Codex / GLM / Kimi 三张卡片，含已用/剩余百分比、重置倒计时、用量明细
- 🔌 **多数据源等级** — 区分官方协议（Codex App Server）、官方兼容（GLM/Kimi）、本地估算（降级）
- 🧯 **容错降级** — 单个供应商失败不影响其他家；失败时保留上次有效数据并标记 Stale
- 🔒 **本地优先** — 默认仅监听 `127.0.0.1`。凭据不会发送给 Usage-Bar 自有后端或遥测，只会发送到你配置的 provider endpoint
- 📈 **Codex Activity (Beta)** — 从本地 session 文件估算近 7 天 token 用量

## 快速开始

> ⚠️ 项目处于 v1 开发阶段（Local Alpha）

### 零配置直接跑

```bash
git clone https://github.com/gausshj/usage-bar.git
cd usage-bar
npm install
npm run dev          # 默认绑定 127.0.0.1:3000
```

打开 `http://127.0.0.1:3000`。

**此时不做任何配置，页面也能打开**，会看到三张卡片分别显示各自状态：
- 如果你本地装过对应的 agent CLI 且已登录，卡片会显示真实配额数据
- 如果没有，卡片显示"未配置"提示（不影响其他卡片）
- **注意**：GLM 不一样——它没有本地登录态可读，必须显式配置 token（见下文）

## 让三家显示真实数据

Usage-Bar 的原理是**读取你本地 agent CLI 的登录态/凭据**。所以激活方式因 provider 而异——Codex 和 Kimi 通常不用配（CLI 已登录过就行），**GLM 必须显式配置 token**。

### Codex —— 无需配置

只要你在本机装过 Codex 并登录过（`~/.codex/` 存在），Usage-Bar 会自动通过 Codex App Server 读取配额，**无需任何配置**。

```bash
# 验证：登录态是否存在
ls ~/.codex/auth.json   # 存在即可
```

> Codex 在 App Server 不可用时，自动降级为解析本地 session 文件（卡片标注 Local Estimate）。

### GLM Coding Plan —— 需要配置 token

GLM 需要你在智谱开放平台创建一个 Coding Plan 的 API key：

1. 登录 [bigmodel.cn](https://bigmodel.cn/) → 个人编程套餐 → 套餐概览 → 新建 API Key
2. 在项目根目录创建 `.env.local`：

```bash
GLM_CODING_PLAN_TOKEN=你的-glm-coding-plan-token
# 可选：区域，默认 bigmodel（open.bigmodel.cn）
GLM_CODING_PLAN_REGION=bigmodel   # 或 zai（api.z.ai 全球站）
```

3. 重启 `npm run dev`，GLM 卡片即显示真实数据（5 小时 token 窗口 + MCP 工具月度调用量）。

### Kimi Code —— 通常无需配置

只要你在本机装过 Kimi CLI 并登录过，Usage-Bar 会自动读取 `~/.kimi-code/credentials/` 的登录态，并在 token 过期时自动刷新（Kimi token 15 分钟过期，自动 renew），**无需配置**。

```bash
# 如果没登录过，先登录：
kimi login
```

> ⚠️ **KIMI_CODE_ACCESS_TOKEN 不会自动续期**。自动刷新（refresh）只有当你使用 CLI 的 credential 文件路径时才有效。如果你显式设置了 `KIMI_CODE_ACCESS_TOKEN`，它过期后不会再自动更新，需要你手动换新的。
> ```bash
> # 仅在 credential 文件路径不可用时的备选（不自动续期）：
> KIMI_CODE_ACCESS_TOKEN=你的-kimi-code-access-token
> ```

### 配置一览

| Provider | 需要配置吗 | 怎么做 |
|---|---|---|
| **Codex** | ❌ 不用 | 登录过 Codex 即可（自动读 App Server） |
| **GLM** | ✅ 需要 | `.env.local` 设 `GLM_CODING_PLAN_TOKEN` |
| **Kimi** | ❌ 通常不用 | `kimi login` 即可（自动读 + 自动刷新） |

**注意**：Kimi Code 用量 ≠ Moonshot Open Platform 余额，二者不可混用。

## 高级配置（可选）

<details>
<summary>展开：自定义端点等</summary>

自定义端点（一般不需要）：

```bash
GLM_CODING_PLAN_BASE_URL=...    # GLM 自定义 base URL
KIMI_CODE_BASE_URL=...          # Kimi 自定义 base URL
CODEX_BINARY_PATH=...           # 指定 codex 二进制路径
```

> ⚠️ **注意**：如果你配置了自定义 base URL，你的 token 会被发送到那个 URL。
> 只有在你信任该 endpoint 时才设置它。

</details>

## 常见问题

<details>
<summary><b>GLM 卡片显示"未配置"，但我设了 token</b></summary>

确认：
- 变量名是 `GLM_CODING_PLAN_TOKEN`（不是 `GLM_QUOTA_TOKEN`，旧的已废弃但仍兼容）
- `.env.local` 在项目根目录，且改了之后**重启了** `npm run dev`
- token 是 Coding Plan 的 key，不是普通按量付费的 key
</details>

<details>
<summary><b>Kimi 卡片显示 token_expired</b></summary>

正常情况下 Usage-Bar 会自动刷新（token 15 分钟过期自动 renew）。如果持续报错，重新 `kimi login` 即可。
</details>

<details>
<summary><b>Codex 显示 Local Estimate 而非官方数据</b></summary>

说明 Codex App Server 没能启动。确认本机 codex 二进制可用（装了 Codex 桌面版或 VS Code 插件）。Local Estimate 是降级估算，数字仅供参考。
</details>

## 验证真实数据（smoke test）

想确认三家的真实账户连接都正常？跑一次 smoke test：

```bash
npm run smoke
```

它会逐一验证 Codex / GLM（两站）/ Kimi 的真实连接，并把脱敏结果写入 `docs/smoke-test-report.md`。**不会**上传或记录任何 token、账号或原始响应。

## 技术栈

- **框架**: Next.js 15（App Router，前后端一体）
- **前端**: React 19 + TypeScript + Tailwind CSS
- **后端**: Next.js Route Handlers（`/api/v1/quota`）
- **测试**: Vitest（123 个单元测试 + opt-in smoke test）
- **校验**: ESLint + tsc

## 项目结构

```
src/
├── quota/           配额模块（PRD 数据契约 + 三家 adapter + 聚合 service）
│   ├── contract.ts      统一数据契约（ProviderStatus / QuotaSnapshot …）
│   ├── providers/       codex / glm / kimi 各自的 adapter
│   ├── service.ts       聚合：缓存 + singleflight + stale 降级
│   ├── credentials.ts   credentialId 解析 + scope 校验
│   ├── schemas.ts       zod runtime schema 校验
│   └── http.ts          共享 HTTP helper（timeout / retry / redaction）
└── app/             页面 + API 路由
tests/
├── quota/           各 provider 单元测试
└── smoke/           真实账户 smoke test（opt-in）
```

## 贡献流程

所有变更通过 feature branch 和 Pull Request 合并到 main。

## License

MIT
