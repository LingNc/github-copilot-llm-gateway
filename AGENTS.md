# GitHub Copilot LLM Gateway

---

## 项目概述

**GitHub Copilot LLM Gateway** 是一个 VS Code 扩展，允许用户将 GitHub Copilot 连接到自定义的开源 LLM 推理服务器（如 vLLM、Ollama、llama.cpp、LocalAI 等），实现通过 OpenAI 兼容 API 使用本地或私有部署的大语言模型。

- **项目名称**: github-copilot-llm-gateway
- **版本**: 1.0.0
- **技术栈**: TypeScript, VS Code Extension API, esbuild
- **许可证**: MIT
- **仓库**: https://github.com/arbs-io/github-copilot-llm-gateway

---

## 快速开始

### 环境要求
- VS Code 1.106.0 或更高版本
- Node.js 和 npm
- 一个 OpenAI API 兼容的推理服务器（如 vLLM、Ollama）

### 安装依赖
```bash
npm install
```

### 开发模式
```bash
npm run esbuild-watch
```

### 打包发布
```bash
npm run vscode:prepublish
npm run package
```

---

## 状态速览

### 任务目标
实现一个 VS Code 语言模型提供程序扩展，将 GitHub Copilot 的请求转发到用户配置的 OpenAI 兼容推理服务器。

### 任务进度
- [x] 项目基础架构搭建
- [x] 扩展激活和注册机制
- [x] OpenAI 兼容 API 客户端实现
- [x] 语言模型提供程序核心逻辑
- [x] 流式响应处理（SSE）
- [x] 工具调用（Tool Calling）支持
- [x] 配置管理（服务器地址、API Key、超时等）
- [x] Token 计算和上下文截断
- [x] JSON 修复和工具参数补全
- [x] 连接测试命令

### 最新进度
项目已完成基础功能开发，支持：
- 连接到 OpenAI 兼容的推理服务器
- 模型列表自动获取
- 流式聊天响应
- 工具/函数调用
- 并行工具调用
- 配置项动态更新

### 文件清单
| 文件 | 说明 |
|------|------|
| `src/extension.ts` | 扩展入口，注册语言模型提供程序和命令 |
| `src/provider.ts` | GatewayProvider 类，实现 VS Code LanguageModelChatProvider 接口 |
| `src/client.ts` | GatewayClient 类，处理 HTTP 请求和 SSE 流解析 |
| `src/types.ts` | TypeScript 类型定义（OpenAI API 兼容格式） |
| `package.json` | 扩展配置、命令、设置项定义 |
| `tsconfig.json` | TypeScript 编译配置 |

### 参考文档
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)

---

## 架构设计

### 核心组件关系
```
VS Code Copilot Chat
        |
        v
GatewayProvider (provider.ts)
        |
        v
GatewayClient (client.ts)
        |
        v
OpenAI Compatible Server (vLLM/Ollama/etc)
```

### 关键特性
1. **流式响应处理**: 使用 SSE (Server-Sent Events) 解析流式响应，支持实时显示 AI 回复
2. **工具调用支持**: 完整支持 OpenAI 格式的 function/tool_calls，包括并行调用
3. **容错机制**: JSON 修复、缺失参数自动填充、上下文截断
4. **灵活配置**: 服务器地址、API Key、超时、Token 限制等均可配置

---

## 配置说明

扩展提供以下配置项（在 VS Code 设置中搜索 "GitHub Copilot LLM Gateway"）：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `serverUrl` | `http://localhost:8000` | 推理服务器地址 |
| `apiKey` | `""` | API 认证密钥（可选） |
| `requestTimeout` | `60000` | 请求超时（毫秒） |
| `defaultMaxTokens` | `32768` | 模型最大上下文 Token 数 |
| `defaultMaxOutputTokens` | `4096` | 最大输出 Token 数 |
| `enableToolCalling` | `true` | 启用工具调用功能 |
| `parallelToolCalling` | `true` | 允许并行工具调用 |
| `agentTemperature` | `0.0` | Agent 模式温度参数（越低越稳定） |

---

## Agent 自举说明

本文档作为项目全局状态机与综述，能够防止代码库膨胀后上下文丢失，确保后续 AI 辅助开发时拥有完整的记忆和设计初衷。

### 实时同步要求
1. 当找到关键因素和进行关键编程时，必须如实记录。
2. 当完成一个任务时，必须更新进度清单。
3. 当添加新的技术规范时，必须补充。
4. 当功能有较大变更时，必须同步更新 README.md。
5. 每次完成一项功能需要提交git，风格仿照曾经的提交记录的模式。

### 维护责任
- 每次会话开始前，AI 工具应优先读取 AGENTS.md 了解项目状态。
- 每次重要变更后，AI 应及时更新此文档。
- 保持 AGENTS.md 与其余部分的描述一致性。

### 必须做的事
- 完成用户的任务后，必须回复："我已严格遵守AGENTS.md。"

