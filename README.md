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

GLM 需要你在对应区域的平台创建一个 Coding Plan 的 API key。**token 必须和 region 成对配置**——中国站 token 不能发给全球站，反之亦然。

**中国站（bigmodel，默认）：**
1. 登录 [bigmodel.cn](https://bigmodel.cn/) → 个人编程套餐 → 套餐概览 → 新建 API Key
2. `.env.local`：
```bash
GLM_CODING_PLAN_TOKEN=你的中国站-token
GLM_CODING_PLAN_REGION=bigmodel   # 默认值，可省略
```

**全球站（zai）：**
1. 登录 [Z.AI 开发者控制台](https://z.ai/) 获取对应 Coding Plan token
2. `.env.local`：
```bash
GLM_CODING_PLAN_TOKEN=你的全球站-token
GLM_CODING_PLAN_REGION=zai
```

> ⚠️ `GLM_CODING_PLAN_REGION` 只能是 `bigmodel` 或 `zai`。其他值会让 GLM 卡片显示配置错误（不会静默回落到默认区域，也不影响 Codex/Kimi）。

重启 `npm run dev` 后，GLM 卡片即显示真实数据（5 小时 token 窗口 + 7 天 token 周额度 + MCP 工具月度调用量）。

### Kimi Code —— API Key 或 CLI 登录均可

**方式一：Console API Key（最简单，无需安装 Kimi CLI）**

Kimi 会员可在 Kimi Code Console 创建 API Key（最多 5 个，供第三方工具使用，见[官方文档](https://www.kimi.com/code/docs/en/)）。在 `.env.local` 中设置后重启即可：

```bash
KIMI_CODE_ACCESS_TOKEN=你的-console-api-key
```

**方式二：Kimi CLI 登录态（自动刷新）**

如果你本机装过 Kimi CLI 并登录过，Usage-Bar 会自动读取 `~/.kimi-code/credentials/` 的登录态，并在 token 过期时自动刷新（Kimi OAuth token 15 分钟过期，自动 renew），无需配置。

```bash
# 如果没登录过，先登录：
kimi login
```

> ⚠️ `KIMI_CODE_ACCESS_TOKEN` 不会自动续期。API key 被吊销或失效后，卡片会显示 `api_key_invalid`，需在 Console 重新创建并手动替换。自动刷新只在 CLI credential 文件模式下有效。

### 配置一览

| Provider | 需要配置吗 | 怎么做 |
|---|---|---|
| **Codex** | ❌ 不用 | 登录过 Codex 即可（自动读 App Server） |
| **GLM** | ✅ 需要 | `.env.local` 设 `GLM_CODING_PLAN_TOKEN` |
| **Kimi** | ❌ 通常不用 | Console API Key（设 `KIMI_CODE_ACCESS_TOKEN`）或 `kimi login`（自动读 + 自动刷新） |

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
<summary><b>Kimi 卡片显示 token_expired / api_key_invalid</b></summary>

取决于你的配置方式：

- **使用 `KIMI_CODE_ACCESS_TOKEN`（Console API Key）**：显示 `api_key_invalid` 说明 key 失效或被吊销。该环境变量**不会自动续期**——到 Kimi Code Console 重新创建 key 并替换；或删除该环境变量后重启 Usage-Bar，改用 CLI credential 模式（支持自动刷新）。
- **使用 CLI credential 文件**：显示 `token_expired` 说明登录态失效，运行 `kimi login` 重新登录即可。
</details>

<details>
<summary><b>Codex 显示 Local Estimate 而非官方数据</b></summary>

说明 Codex App Server 没能启动。确认本机 codex 二进制可用（装了 Codex 桌面版或 VS Code 插件）。Local Estimate 是降级估算，数字仅供参考。
</details>

## 验证真实数据（smoke test）

```bash
npm run smoke
```

`npm run smoke` 会验证 Codex、`GLM_CODING_PLAN_REGION` 当前选择的 GLM 区域和 Kimi。报告仅保存在本地并被 gitignore，只记录允许字段，不包含 token、账号、safeMessage 或原始响应。验证请求仍会将凭据发送到相应 provider 的 API/OAuth endpoint。

## 技术栈

- **框架**: Next.js 15（App Router，前后端一体）
- **前端**: React 19 + TypeScript + Tailwind CSS
- **后端**: Next.js Route Handlers（`/api/v1/quota`）
- **测试**: Vitest 单元/集成测试 + opt-in 真实账户 smoke test
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
