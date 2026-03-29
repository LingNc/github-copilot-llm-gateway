# GitHub Copilot LLM Gateway - 多厂商配置系统设计文档

**日期**: 2025-03-29
**作者**: LingNc
**状态**: 已批准，准备实施

---

## 1. 设计目标

将当前单一 API 配置扩展为**多厂商配置系统**，解决以下问题：

1. 支持配置多个不同 baseURL 的厂商
2. 支持自定义模型详细信息（上下文、输出、模态、推理能力等）
3. 支持不支持 `/v1/models` 的 API 节点
4. 保持向后兼容
5. 提供友好的配置体验（中英双语支持）

---

## 2. 架构设计

### 2.1 整体架构

```
VS Code Copilot Chat
        |
        v
GatewayManager (管理多厂商)
        |
        |---> GatewayProvider (厂商A)
        |       |
        |       v
        |   GatewayClient (厂商A 的 API)
        |
        |---> GatewayProvider (厂商B)
        |       |
        |       v
        |   GatewayClient (厂商B 的 API)
        |
        v
各厂商 OpenAI 兼容服务器
```

### 2.2 核心组件

| 组件 | 职责 | 变更 |
|------|------|------|
| `GatewayManager` | 管理多个 GatewayProvider 实例，处理配置加载和热重载 | 新增 |
| `GatewayProvider` | 实现 LanguageModelChatProvider，为单个厂商提供服务 | 修改 |
| `GatewayClient` | 处理 HTTP 请求和 SSE 流解析 | 最小修改 |
| `ConfigManager` | 配置验证、加载、模式处理 | 新增 |

---

## 3. 配置格式

### 3.1 完整配置示例

配置存储在 VS Code Settings 中，键名为 `github.copilot.llm-gateway.providers`。

```json
{
  "github.copilot.llm-gateway.providers": {
    "bailian-coding": {
      "name": "阿里云百炼",
      "baseURL": "https://coding.dashscope.aliyuncs.com/apps/anthropic/v1",
      "apiKey": "YOUR_API_KEY",
      "models": {
        "qwen3.5-plus": {
          "name": "Qwen3.5 Plus",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "options": {
            "thinking": {
              "type": "enabled",
              "budgetTokens": 8192
            }
          },
          "limit": {
            "context": 1000000,
            "output": 65536
          },
          "capabilities": {
            "toolCalling": true,
            "vision": true
          }
        },
        "qwen3-max-2026-01-23": {
          "name": "Qwen3 Max 2026-01-23",
          "modalities": {
            "input": ["text"],
            "output": ["text"]
          },
          "limit": {
            "context": 262144,
            "output": 32768
          }
        }
      }
    },
    "local-vllm": {
      "name": "本地 vLLM",
      "baseURL": "http://localhost:8000",
      "models": {
        "llama3": {
          "name": "Llama 3",
          "modalities": {
            "input": ["text"],
            "output": ["text"]
          },
          "limit": {
            "context": 8192,
            "output": 4096
          },
          "capabilities": {
            "toolCalling": false,
            "vision": false
          }
        }
      }
    }
  },
  "github.copilot.llm-gateway.showProviderPrefix": false,
  "github.copilot.llm-gateway.configMode": "config-priority"
}
```

### 3.2 字段说明

**Provider 级别：**

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 厂商显示名称（支持中文） |
| `baseURL` | string | 是 | API 基础 URL |
| `apiKey` | string | 否 | API 认证密钥 |
| `models` | object | 是 | 该厂商下的模型配置 |

**Model 级别：**

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 模型显示名称 |
| `modalities` | object | 否 | 支持的模态 |
| `modalities.input` | string[] | 否 | 输入模态：["text", "image"] |
| `modalities.output` | string[] | 否 | 输出模态：["text"] |
| `options` | object | 否 | 额外选项 |
| `options.thinking` | object | 否 | 推理配置 |
| `options.thinking.type` | string | 否 | "enabled" / "disabled" |
| `options.thinking.budgetTokens` | number | 否 | 推理预算 Token 数 |
| `limit` | object | 是 | 限制配置 |
| `limit.context` | number | 是 | 最大上下文 Token |
| `limit.output` | number | 是 | 最大输出 Token |
| `capabilities` | object | 否 | 能力配置 |
| `capabilities.toolCalling` | boolean | 否 | 是否支持工具调用 |
| `capabilities.vision` | boolean | 否 | 是否支持视觉 |

### 3.3 全局设置

| 设置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `showProviderPrefix` | boolean | false | 模型列表是否显示厂商前缀 |
| `configMode` | enum | "config-priority" | "config-only" / "config-priority" / "api-priority" |

---

## 4. 向后兼容策略

### 4.1 旧配置迁移

如果 `providers` 未配置，自动使用旧配置创建默认厂商：

```typescript
// 伪代码
if (!config.providers) {
  providers = {
    "default": {
      "name": "Default Provider",
      "baseURL": config.serverUrl || "http://localhost:8000",
      "apiKey": config.apiKey || "",
      "models": {} // 从 /v1/models 获取或使用默认值
    }
  };
}
```

### 4.2 旧设置项保留

以下设置项继续保留但标记为 deprecated：
- `serverUrl` → 映射到 default provider
- `apiKey` → 映射到 default provider
- `defaultMaxTokens` → 作为模型默认值
- `defaultMaxOutputTokens` → 作为模型默认值
- `enableToolCalling` → 作为模型默认能力
- `parallelToolCalling` → 作为请求选项
- `agentTemperature` → 作为请求选项

---

## 5. 用户交互设计

### 5.1 配置方式

| 配置项 | 配置方式 | 说明 |
|--------|----------|------|
| 基础设置 | VS Code UI + JSON | 支持双语描述 |
| 厂商配置 | 命令引导 + JSON 编辑 | 复杂配置使用 JSON |

### 5.2 新增命令

| 命令 ID | 标题 | 功能 |
|---------|------|------|
| `openConfig` | LLM Gateway: Open Configuration | 打开 settings.json 并定位到配置 |
| `reloadConfig` | LLM Gateway: Reload Configuration | 手动刷新配置 |
| `addProvider` | LLM Gateway: Add Provider | 交互式添加新厂商 |
| `editProvider` | LLM Gateway: Edit Provider | 选择并编辑厂商配置 |
| `removeProvider` | LLM Gateway: Remove Provider | 移除厂商配置 |

### 5.3 热重载机制

- 监听 `onDidChangeConfiguration` 事件
- 检测 `github.copilot.llm-gateway` 相关配置变更
- 自动注销旧提供程序，注册新提供程序

---

## 6. 实现细节

### 6.1 模型 ID 命名规则

- **内部 ID**：`厂商ID/模型ID`（如 `bailian-coding/qwen3.5-plus`）
- **显示名称**：
  - `showProviderPrefix: true` → `bailian-coding/qwen3.5-plus`
  - `showProviderPrefix: false` → `Qwen3.5 Plus`

### 6.2 ConfigMode 行为

| 模式 | 行为 |
|------|------|
| `config-only` | 仅使用配置文件中的模型 |
| `config-priority` | 优先使用配置，同时合并 API 返回的模型（配置覆盖 API） |
| `api-priority` | 优先使用 API 返回的模型，配置中的模型作为补充 |

### 6.3 JSON Schema 验证

提供 JSON Schema 用于配置验证：`schemas/config-schema.json`

---

## 7. 双语支持

### 7.1 NLS 文件结构

```
package.nls.json          (英文)
package.nls.zh-cn.json    (简体中文)
```

### 7.2 翻译内容

- 所有配置项的 `description` 和 `markdownDescription`
- 所有命令的 `title`
- 输出频道日志（保持英文，便于调试）

---

## 8. 测试策略

1. **向后兼容测试**：不配置 providers，验证旧配置工作正常
2. **配置加载测试**：验证不同 configMode 的行为
3. **热重载测试**：修改配置后验证自动重载
4. **多厂商测试**：同时配置多个厂商，验证模型列表正确
5. **边界测试**：模型能力覆盖、无效配置处理

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 配置格式复杂，用户出错 | 高 | 提供 JSON Schema 验证、命令引导、详细文档 |
| 向后兼容性问题 | 高 | 保留旧设置项，自动迁移，充分测试 |
| 多厂商性能问题 | 中 | 延迟加载模型信息，缓存配置 |
| 热重载异常 | 中 | 添加错误处理和回滚机制 |

---

## 10. 后续工作

1. 实现核心配置系统
2. 添加命令和热重载
3. 添加双语支持
4. 更新文档和 README
5. 添加配置迁移向导（可选）

