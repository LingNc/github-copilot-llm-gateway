# 实施计划：多厂商配置系统重构

**日期**: 2025-03-29
**分支**: develop

---

## 阶段划分

### 阶段 1：基础类型定义和配置结构
**目标**: 建立新的类型系统和配置接口

1. 更新 `src/types.ts`
   - 添加 Provider 和 Model 配置类型
   - 添加 ConfigMode 枚举
   - 保留向后兼容的旧类型

2. 创建 `src/config/types.ts`
   - 定义完整的配置类型层次
   - 定义 JSON Schema 类型

3. 创建 `src/config/schema.json`
   - 提供配置验证的 JSON Schema

**验收标准**: TypeScript 编译通过，类型定义完整

---

### 阶段 2：配置管理器
**目标**: 实现配置的加载、验证和迁移

1. 创建 `src/config/ConfigManager.ts`
   - 从 VS Code Settings 加载配置
   - 验证配置格式（使用 JSON Schema）
   - 处理旧配置迁移
   - 支持不同 ConfigMode

2. 创建 `src/config/validator.ts`
   - 配置验证函数
   - 错误信息生成

3. 创建 `src/config/migration.ts`
   - 旧配置到新配置的迁移逻辑

**验收标准**:
- ConfigManager 能正确加载和验证配置
- 旧配置能自动迁移
- 配置错误能给出清晰的提示

---

### 阶段 3：多厂商管理器
**目标**: 管理多个 GatewayProvider 实例

1. 创建 `src/manager/ProviderManager.ts`
   - 管理多个 GatewayProvider 实例
   - 处理配置变更（热重载）
   - 注册/注销提供程序到 VS Code

2. 修改 `src/extension.ts`
   - 使用 ProviderManager 替代直接注册
   - 添加配置变更监听

**验收标准**:
- ProviderManager 能正确管理多个厂商
- 配置变更后能自动重载
- 提供程序能正确注册到 VS Code

---

### 阶段 4：修改 GatewayProvider
**目标**: 适配新的配置系统

1. 修改 `src/provider.ts`
   - 接受单个 Provider 配置
   - 使用配置的模型信息而非 /v1/models
   - 根据 ConfigMode 决定是否调用 /v1/models
   - 支持厂商前缀显示选项

2. 更新模型信息获取逻辑
   - 实现 config-only 模式
   - 实现 config-priority 模式
   - 实现 api-priority 模式

**验收标准**:
- GatewayProvider 能使用配置的模型信息
- 不同 ConfigMode 行为正确
- 模型显示名称遵循 showProviderPrefix 设置

---

### 阶段 5：新增命令
**目标**: 提供友好的配置交互

1. 在 `package.json` 中定义新命令
   - openConfig
   - reloadConfig
   - addProvider
   - editProvider
   - removeProvider

2. 创建 `src/commands/configCommands.ts`
   - 实现配置相关命令
   - 添加交互式输入对话框

3. 修改 `src/extension.ts`
   - 注册新命令

**验收标准**:
- 所有命令能在 VS Code 命令面板中找到
- 命令能正确执行
- addProvider 有交互式引导

---

### 阶段 6：双语支持
**目标**: 提供中英双语界面

1. 创建 `package.nls.json`
   - 英文配置描述和命令标题

2. 创建 `package.nls.zh-cn.json`
   - 简体中文配置描述和命令标题

3. 修改 `package.json`
   - 使用 %key% 语法引用翻译
   - 更新配置项描述

**验收标准**:
- VS Code UI 显示正确的语言
- 配置项描述有中英文
- 命令标题有中英文

---

### 阶段 7：更新文档
**目标**: 更新项目文档

1. 更新 `README.md`
   - 新的配置说明
   - 多厂商配置示例
   - 迁移指南

2. 更新 `AGENTS.md`
   - 更新项目状态和进度

**验收标准**:
- 文档准确反映新功能
- 配置示例可用

---

### 阶段 8：测试和修复
**目标**: 确保功能稳定

1. 向后兼容测试
   - 不配置 providers，验证旧配置工作

2. 多厂商测试
   - 配置多个厂商，验证模型列表
   - 测试厂商切换

3. 热重载测试
   - 修改配置，验证自动重载

4. 边界测试
   - 无效配置处理
   - 空配置处理

**验收标准**:
- 所有测试通过
- 无明显 bug

---

## 提交计划

每个阶段完成后提交一次，提交信息格式：

```
🛠️ Phase X: 简短描述

- 详细变更 1
- 详细变更 2
```

**提交时间表**:
1. 阶段 1 完成后: `🛠️ Phase 1: Add type definitions for multi-provider config`
2. 阶段 2 完成后: `🛠️ Phase 2: Implement ConfigManager with validation`
3. 阶段 3 完成后: `🛠️ Phase 3: Add ProviderManager for multi-provider support`
4. 阶段 4 完成后: `🛠️ Phase 4: Update GatewayProvider for config-based models`
5. 阶段 5 完成后: `🛠️ Phase 5: Add configuration commands`
6. 阶段 6 完成后: `🛠️ Phase 6: Add Chinese/English bilingual support`
7. 阶段 7 完成后: `🛠️ Phase 7: Update documentation`
8. 阶段 8 完成后: `🛠️ Phase 8: Fix issues and finalize`

---

## 依赖关系

```
Phase 1 (Types)
    |
    v
Phase 2 (ConfigManager)
    |
    v
Phase 3 (ProviderManager) <---> Phase 4 (Provider Update)
    |                              |
    v                              v
Phase 5 (Commands) <-------------> Phase 6 (Bilingual)
    |
    v
Phase 7 (Docs)
    |
    v
Phase 8 (Test)
```

阶段 3 和 4 可以并行开发。
阶段 5 和 6 可以并行开发。

---

## 当前状态

- [x] 创建设计文档
- [x] 创建实施计划
- [ ] 阶段 1: 基础类型定义
- [ ] 阶段 2: 配置管理器
- [ ] 阶段 3: 多厂商管理器
- [ ] 阶段 4: 修改 GatewayProvider
- [ ] 阶段 5: 新增命令
- [ ] 阶段 6: 双语支持
- [ ] 阶段 7: 更新文档
- [ ] 阶段 8: 测试和修复

---

## 备注

- 开发在 `develop` 分支进行
- 每个阶段完成后需要提交
- 注意向后兼容性
- 配置变更需要热重载支持

