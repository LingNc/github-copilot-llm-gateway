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
- [x] 多厂商配置系统
- [x] 配置文件支持和热重载
- [x] 中英双语支持
- [x] Anthropic API 支持
- [x] 模型 thinking 配置支持
- [ ] Copilot 上下文 token 显示修复（需进一步研究）
- [ ] 完整测试和 bug 修复

### 最新进度
项目已重构为支持多厂商配置系统：
- 支持配置多个不同 baseURL 的厂商
- 支持自定义模型详细信息（上下文、输出、模态、推理能力等）
- 支持不支持 `/v1/models` 的 API 节点（纯配置模式）
- 多厂商实例同时注册到 VS Code
- 中英双语界面支持
- 向后兼容旧配置
- **新增**: Anthropic API 格式支持（apiFormat: 'anthropic'）

### 文件清单
| 文件 | 说明 |
|------|------|
| `src/extension.ts` | 扩展入口，使用 ProviderManager 管理多厂商 |
| `src/provider.ts` | GatewayProvider 类，支持 ConfigMode 模型获取 |
| `src/client.ts` | GatewayClient 类，处理 HTTP 请求和 SSE 流解析 |
| `src/anthropic-client.ts` | AnthropicClient 类，处理 Anthropic Messages API |
| `src/types.ts` | TypeScript 类型定义，包含多厂商配置类型和 Anthropic 类型 |
| `src/config/types.ts` | 配置专用类型定义 |
| `src/config/ConfigManager.ts` | 配置管理器，支持加载、验证、热重载 |
| `src/config/validator.ts` | 配置验证工具 |
| `src/config/migration.ts` | 旧配置迁移工具 |
| `src/manager/ProviderManager.ts` | 多厂商管理器 |
| `src/commands/configCommands.ts` | 配置管理命令（添加/编辑/删除厂商） |
| `schemas/config-schema.json` | 配置验证的 JSON Schema |
| `package.nls.json` | 英文翻译 |
| `package.nls.zh-cn.json` | 简体中文翻译 |
| `package.json` | 扩展配置、命令、设置项定义 |

### 参考文档
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [Anthropic Messages API](https://docs.anthropic.com/en/api/messages)

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
GatewayClient (client.ts) / AnthropicClient (anthropic-client.ts)
        |
        v
OpenAI/Anthropic Compatible Server (vLLM/Ollama/Anthropic/etc)
```

### 关键特性
1. **流式响应处理**: 使用 SSE (Server-Sent Events) 解析流式响应，支持实时显示 AI 回复
2. **工具调用支持**: 完整支持 OpenAI 格式的 function/tool_calls，包括并行调用
3. **Anthropic API 支持**: 自动检测 apiFormat 并使用 Anthropic Messages API 格式
4. **容错机制**: JSON 修复、缺失参数自动填充、上下文截断
5. **灵活配置**: 服务器地址、API Key、超时、Token 限制等均可配置

---

## 配置说明

### 多厂商配置

扩展现在支持多厂商配置，通过 `github.copilot.llm-gateway.providers` 设置：

```json
{
  "github.copilot.llm-gateway.providers": {
    "bailian-coding": {
      "name": "阿里云百炼",
      "baseURL": "https://coding.dashscope.aliyuncs.com/apps/anthropic/v1",
      "apiKey": "YOUR_API_KEY",
      "apiFormat": "openai",
      "models": {
        "qwen3.5-plus": {
          "name": "Qwen3.5 Plus",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "options": { "thinking": { "type": "enabled", "budgetTokens": 8192 } },
          "limit": { "context": 1000000, "output": 65536 },
          "capabilities": { "toolCalling": true, "vision": true }
        }
      }
    },
    "anthropic": {
      "name": "Anthropic",
      "baseURL": "https://api.anthropic.com/v1",
      "apiKey": "YOUR_API_KEY",
      "apiFormat": "anthropic",
      "models": {
        "claude-3-5-sonnet-20241022": {
          "name": "Claude 3.5 Sonnet",
          "limit": { "context": 200000, "output": 8192 },
          "capabilities": { "toolCalling": true, "vision": true }
        }
      }
    }
  },
  "github.copilot.llm-gateway.showProviderPrefix": true,
  "github.copilot.llm-gateway.providerNameStyle": "slash",
  "github.copilot.llm-gateway.configMode": "config-priority"
}
```

### apiFormat 说明

| 格式 | 说明 |
|------|------|
| `openai` | 使用 OpenAI 兼容 API 格式（默认） |
| `anthropic` | 使用 Anthropic Messages API 格式 |

### 配置模式

| 模式 | 说明 |
|------|------|
| `config-only` | 仅使用配置文件中的模型，不调用 /v1/models |
| `config-priority` | 优先使用配置，同时合并 API 返回的模型 |
| `api-priority` | 优先使用 API 返回的模型，配置作为补充 |

### 向后兼容

旧配置（单厂商）会自动迁移到新格式：
- `serverUrl` → 映射到 default provider
- `apiKey` → 映射到 default provider
- 其他设置 → 作为全局默认值

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
