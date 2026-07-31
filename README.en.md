# Usage-Bar

> A local-first quota dashboard for Codex / GLM Coding Plan / Kimi Code

English | [简体中文](./README.md)

## Overview

Usage-Bar is a local-first web dashboard for developers who subscribe to multiple AI coding services. It shows your current quota, remaining allowance, reset times, and usage breakdown in a single page.

v1 supports three products:

1. **Codex** (ChatGPT / Codex account quota)
2. **GLM Coding Plan**
3. **Kimi Code**

> The product spec lives in an internal PRD (not public).

## Features

- 📊 **Three-card quota board** — fixed cards for Codex / GLM / Kimi with used/remaining percentage, reset countdown, and usage breakdown
- 🔌 **Data-source levels** — distinguishes Official Protocol (Codex App Server), Official Compatibility (GLM/Kimi), and Local Estimate (fallback)
- 🧯 **Graceful degradation** — one provider failing never blocks the others; on failure the last good data is kept and marked Stale
- 🔒 **Local-first** — binds to `127.0.0.1` only; credentials never hit a database or leave your machine
- 📈 **Codex Activity (Beta)** — estimates the last 7 days of token usage from local session files

## Quick start

> ⚠️ v1 is in development (Local Alpha)

### Run with zero config

```bash
git clone git@github.com:gausshj/usage-bar.git
cd usage-bar
npm install
npm run dev          # binds to 127.0.0.1:3000
```

Open `http://127.0.0.1:3000`.

**The page loads with no configuration at all.** Each card shows a status based on which agent CLIs you've logged into locally:
- If you've installed and logged into the corresponding agent CLI, the card shows real quota data.
- If not, the card shows a "not configured" hint (without affecting the others).

## Getting real data for each provider

Usage-Bar works by reading the login state / credentials of your local agent CLIs. So activation differs per provider — **in most cases you configure nothing**, as long as the CLI is logged in.

### Codex — no config needed

As long as you've installed and logged into Codex on this machine (`~/.codex/` exists), Usage-Bar reads the quota via the Codex App Server automatically. **Nothing to configure.**

```bash
# Verify the login state exists:
ls ~/.codex/auth.json   # present = good
```

> If the App Server is unavailable, Codex falls back to parsing local session files (the card shows "Local Estimate").

### GLM Coding Plan — requires a token

GLM needs an API key from the Zhipu open platform:

1. Log into [bigmodel.cn](https://bigmodel.cn/) → 个人编程套餐 → 套餐概览 → create an API Key.
2. Create `.env.local` in the project root:

```bash
GLM_CODING_PLAN_TOKEN=your-glm-coding-plan-token
# Optional: region, defaults to bigmodel (open.bigmodel.cn)
GLM_CODING_PLAN_REGION=bigmodel   # or zai (api.z.ai, global)
```

3. Restart `npm run dev`. The GLM card then shows real data (5-hour token window + monthly MCP tool-call quota).

### Kimi Code — usually no config

As long as you've installed and logged into the Kimi CLI, Usage-Bar reads `~/.kimi-code/credentials/` automatically and refreshes the token when it expires (tokens last 15 minutes and auto-renew). **Nothing to configure.**

```bash
# If you haven't logged in:
kimi login
```

> If auto-read doesn't work (e.g. non-default path), set it explicitly in `.env.local`:
> ```bash
> KIMI_CODE_ACCESS_TOKEN=your-kimi-code-access-token
> ```

### Configuration summary

| Provider | Needs config? | How |
|---|---|---|
| **Codex** | ❌ No | Just be logged into Codex (auto-reads App Server) |
| **GLM** | ✅ Yes | Set `GLM_CODING_PLAN_TOKEN` in `.env.local` |
| **Kimi** | ❌ Usually no | `kimi login` (auto-read + auto-refresh) |

**Note**: Kimi Code usage ≠ Moonshot Open Platform balance — they are not interchangeable.

## Advanced configuration (optional)

<details>
<summary>Expand: credentialId integration, custom endpoints, etc.</summary>

Instead of a raw token, credentials can be injected via a credential store (with scope validation):

```bash
# Use a credentialId instead of a raw token (requires a credential store)
GLM_CREDENTIAL_ID=your-credential-id
KIMI_CREDENTIAL_ID=your-credential-id
```

Custom endpoints (usually unnecessary):

```bash
GLM_CODING_PLAN_BASE_URL=...    # custom GLM base URL
KIMI_CODE_BASE_URL=...          # custom Kimi base URL
CODEX_BINARY_PATH=...           # custom path to the codex binary
```

</details>

## FAQ

<details>
<summary><b>GLM shows "not configured" even though I set the token</b></summary>

Check:
- The variable is `GLM_CODING_PLAN_TOKEN` (not the legacy `GLM_QUOTA_TOKEN`, though that still works).
- `.env.local` is in the project root, and you **restarted** `npm run dev` after editing it.
- The token is a Coding Plan key, not a pay-as-you-go key.
</details>

<details>
<summary><b>Kimi shows token_expired</b></summary>

Normally Usage-Bar auto-refreshes (tokens last 15 minutes and auto-renew). If it keeps failing, run `kimi login` again.
</details>

<details>
<summary><b>Codex shows "Local Estimate" instead of official data</b></summary>

The Codex App Server failed to start. Make sure the codex binary is available (Codex desktop app or the VS Code extension installed). Local Estimate is a fallback approximation.
</details>

## Verify real connections (smoke test)

To confirm all three real-account connections work:

```bash
npm run smoke
```

It verifies Codex / GLM (both regions) / Kimi against real credentials and writes a **redacted** report to `docs/smoke-test-report.md`. It never uploads or records any token, account, or raw response.

## Tech stack

- **Framework**: Next.js 15 (App Router, full-stack in one process)
- **Frontend**: React 19 + TypeScript + Tailwind CSS
- **Backend**: Next.js Route Handlers (`/api/v1/quota`)
- **Tests**: Vitest (123 unit tests + opt-in smoke test)
- **Checks**: ESLint + tsc

## Project structure

```
src/
├── quota/           quota module (PRD data contract + 3 adapters + aggregation service)
│   ├── contract.ts      unified contract (ProviderStatus / QuotaSnapshot …)
│   ├── providers/       codex / glm / kimi adapters
│   ├── service.ts       aggregation: cache + singleflight + stale fallback
│   ├── credentials.ts   credentialId resolution + scope validation
│   ├── schemas.ts       zod runtime schema validation
│   └── http.ts          shared HTTP helper (timeout / retry / redaction)
└── app/             pages + API routes
tests/
├── quota/           per-provider unit tests
└── smoke/           real-account smoke test (opt-in)
```

## Contributing

All changes go through feature branches and Pull Requests into main.

## License

MIT
