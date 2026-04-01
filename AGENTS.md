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
- [x] Copilot 上下文 token 显示修复（通过 progress.usage() 报告）
- [x] Claude 3.7 Thinking 内容支持
- [ ] 模型思考等级配置支持（Kimi/Qwen）
- [ ] 完整测试和 bug 修复

### Token 统计计划（按顺序）

- [x] **计划 1**: Token 分类统计完善（Files 和 Tool Results）
- [ ] **计划 2**: Token 估算算法优化（precise/fast-estimate/none 模式）
- [ ] **计划 3**: 切换模型时自动隐藏 Token 状态栏
- [ ] **计划 4**: 模型上下文长度显示异常问题排查
- [ ] **计划 5**: 整理上下文按钮样式优化

### 未来计划（暂不实装）

#### 计划 1: Token 分类统计完善（Files 和 Tool Results）

**当前状态**:
已实现 5 个分类：
- **System**: System Instructions, Tool Definitions
- **User Context**: Messages, Files, Tool Results

**实现内容**:
1. ✅ Files 分类: 通过 `LanguageModelDataPart` 识别图片附件
2. ✅ Tool Results 分类: 通过 `LanguageModelToolResultPart` 识别工具返回结果
3. ✅ Tooltip 显示优化: 垂直列表形式，与 Copilot Chat 一致

**相关代码位置**:
- `src/provider.ts`: `convertMessagesWithCategories()` 方法
- `src/provider.ts`: `updateTokenStatusBar()` 方法

---

#### 计划 2: Token 估算算法优化

**目标**: 提供可配置的 Token 计算模式，平衡精确度和性能

**背景**: 当前使用 `js-tiktoken` 进行精确的 Token 计算，但在大量文本处理时可能有性能开销。需要提供一个快速估算模式作为选项。

**方案**:
添加配置项 `tokenCalculationMode`，支持三种模式：

1. **`precise`** (默认): 使用 `js-tiktoken` 精确计算
   - 优点: 最准确
   - 缺点: 可能有轻微性能开销

2. **`fast-estimate`**: 使用字符数快速估算
   - 中文: 1 Token ≈ 1.6 个汉字
   - 英文: 1 Token ≈ 3.5 个字符
   - 公式: `tokens = chineseChars / 1.6 + englishChars / 3.5`
   - 优点: 速度最快，无依赖
   - 缺点: 估算误差约 ±20%

3. **`none`**: 不进行 Token 计算
   - 仅使用消息数量估算
   - 适用于完全不关心 Token 统计的用户

**配置示例**:
```json
{
  "github.copilot.llm-gateway.tokenCalculationMode": "fast-estimate"
}
```

**实现位置**: `src/provider.ts` 中的 `countTokens()` 方法

**预估工作量**: 2-3 小时

**优先级**: 中（性能优化选项）

---

#### 计划 3: 切换模型时自动隐藏 Token 状态栏

**需求描述**: 当用户在 Copilot Chat 中切换到非 LLM Gateway 提供的模型时，自动隐藏当前显示的 Token 状态栏

**背景**:
- 目前 Token 状态栏只在当前会话中显示
- 当用户切换到其他模型（如 GitHub Copilot 官方模型或其他扩展提供的模型）时，状态栏仍然显示，但数据已过期
- 这会造成误导，显示的是之前模型的 Token 使用情况

**实现思路**:
1. 监听模型切换事件（如果有 VS Code API 支持）
2. 或通过检测当前活动的 Chat Participant 来判断
3. 当检测到切换到非当前 GatewayProvider 的模型时，调用 `tokenStatusBarItem.hide()`
4. 当再次切换回 GatewayProvider 的模型时，恢复显示

**相关 API 调研**:
- `vscode.chat.onDidChangeActiveChatParticipant` (如果有)
- `vscode.window.onDidChangeActiveTextEditor` (辅助判断)
- 在 `provideLanguageModelResponse` 中记录当前 session 的 provider

**相关代码位置**:
- `src/provider.ts`: `updateTokenStatusBar()` 方法
- `src/extension.ts`: 添加事件监听

**预估工作量**: 2-3 小时

**优先级**: 低（功能增强，非必要）

---

#### 计划 4: 模型上下文长度显示异常问题排查

**问题描述**: 在 Copilot Chat 模型选择界面中，LLM Gateway 配置的模型上下文长度显示比实际值偏大
- 示例 1: 实际 1M (1,000,000) → 显示 1.1M
- 示例 2: 实际 262K (262,144) → 显示 295K

**可能原因**:
1. **格式转换问题**: `formatNumber()` 函数在处理大数字时可能存在精度问题
2. **单位换算问题**: K/M 换算逻辑可能有误（1000 vs 1024）
3. **VS Code 内部处理**: Copilot Chat 可能对模型信息进行了额外的格式化
4. **配置读取问题**: 模型配置读取时可能发生了数值转换错误

**排查步骤**:
1. 检查 `src/provider.ts` 中的 `formatNumber()` 方法实现
2. 添加调试日志输出原始值和格式化后的值
3. 对比 `provideLanguageModelChatInformation()` 返回的 `model.info` 数据
4. 检查 `package.json` 中 `languageModelChatProviders` 的模型注册信息

**相关代码位置**:
- `src/provider.ts`: `formatNumber()` 方法
- `src/provider.ts`: `provideLanguageModelChatInformation()`
- `src/manager/ProviderManager.ts`: 模型注册逻辑

**预估工作量**: 1-2 小时

**优先级**: 中（影响用户体验，但不影响功能）

---

#### 计划 5: 整理上下文按钮样式优化

**当前状态**:
当前 tooltip 底部的"整理对话上下文"显示为 Markdown 超链接 `[整理对话上下文](command:...)`

**目标**: 改为 Copilot Chat 风格的按钮样式

**Copilot Chat 实现方式**:
使用 VS Code 的按钮控件而不是 Markdown 链接

**实现思路**:
1. 在 tooltip 中使用 HTML button 元素（如果支持）
2. 或者使用 `MarkdownString` 的 `isTrusted` 和命令链接，配合样式使其看起来像按钮
3. 参考 Copilot Chat 源码中的实现方式

**参考样式**:
```
┌─────────────────────┐
│  整理对话上下文     │  ← 按钮样式，居中显示，有背景色
└─────────────────────┘
```

**相关代码位置**:
- `src/provider.ts`: `updateTokenStatusBar()` 方法中的 tooltip 构建

**预估工作量**: 1-2 小时

**优先级**: 低（UI 美化）

---

### 最新进度
项目已重构为支持多厂商配置系统：
- 支持配置多个不同 baseURL 的厂商
- 支持自定义模型详细信息（上下文、输出、模态、推理能力等）
- 支持不支持 `/v1/models` 的 API 节点（纯配置模式）
- 多厂商实例同时注册到 VS Code
- 中英双语界面支持
- 向后兼容旧配置
- **新增**: Anthropic API 格式支持（apiFormat: 'anthropic'）
- **新增**: Token 使用量显示修复（通过 progress.usage() 报告给 VS Code）
- **新增**: Claude 3.7 Thinking 内容支持（处理 thinking 类型 content block）

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

### Git 提交规范
- **格式**: `🛠️ 文件路径 -> 简短描述`
- **前缀**: 使用锤子表情符号 `🛠️` 开头
- **文件路径**: 列出主要修改的文件（用逗号分隔），放在 `->` 前面
- **描述**: 简短描述修改内容，放在 `->` 后面
- **语言**: 中文或英文均可，保持简洁
- **不要包含**: Co-Authored-By、Signed-off-by 等信息

**示例**:
```
🛠️ src/client.ts,src/provider.ts -> 实现 Token 使用量显示功能
🛠️ AGENTS.md -> 添加 Git 提交规范
🛠️ src/provider.ts -> 修复栈溢出问题
```

### 维护责任
- 每次会话开始前，AI 工具应优先读取 AGENTS.md 了解项目状态。
- 每次重要变更后，AI 应及时更新此文档。
- 保持 AGENTS.md 与其余部分的描述一致性。

### 必须做的事
- 完成用户的任务后，必须回复："我已严格遵守AGENTS.md。"
