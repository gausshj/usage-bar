# Usage-Bar

> LLM API Usage Dashboard — 多模型供应商用量采集与可视化

## 简介

Usage-Bar 是一个轻量级的 LLM API 用量仪表盘，聚合 OpenAI、智谱 (GLM)、MiniMax、DeepSeek、通义千问 (Qwen) 等多家供应商的调用量、Token 消耗和费用数据，以可视化进度条和图表展示。

## 特性

- 📊 **Usage Bar 可视化** — 直观的进度条展示各供应商配额使用
- 🏠 **国产优先** — v1 首批支持 OpenAI、智谱 GLM、MiniMax，后续覆盖 20+ 供应商
- 🔒 **安全透明** — API Key 加密存储，数据不外传
- ⚡ **轻量部署** — SQLite 存储，单机零依赖部署

## 快速开始

> ⚠️ 项目处于 v1 开发阶段，尚未发布

```bash
# 克隆仓库
git clone git@github.com:gausshj/usage-bar.git
cd usage-bar

# 安装依赖
npm install

# 开发模式
npm run dev
```

## 技术栈

- **Frontend**: React + TypeScript + ECharts
- **Backend**: Node.js + Fastify
- **Database**: SQLite (better-sqlite3)
- **Build**: Vite

## 贡献流程

所有变更通过 feature branch 和 Pull Request 合并到 main。

## License

MIT
