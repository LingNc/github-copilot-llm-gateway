/**
 * Provider for multi-provider configuration support
 * Each GatewayProvider instance represents a single provider
 */

import * as vscode from 'vscode';
import { GatewayClient } from './client';
import {
  GatewayConfig,
  OpenAIChatCompletionRequest,
  ModelConfig,
} from './types';
import { ConfigManager } from './config/ConfigManager';
import { ResolvedModel, ConfigMode } from './config/types';

/**
 * Language model provider for OpenAI-compatible inference servers
 * Supports multi-provider configuration
 */
export class GatewayProvider implements vscode.LanguageModelChatProvider {
  private readonly client: GatewayClient;
  private gatewayConfig: GatewayConfig;
  private readonly outputChannel: vscode.OutputChannel;
  private configManager: ConfigManager;
  private providerId: string;
  private providerConfig: { baseURL: string; apiKey?: string };
  // Store tool schemas for the current request to fill missing required properties
  private readonly currentToolSchemas: Map<string, unknown> = new Map();
  // Track if we've shown the welcome notification this session
  private hasShownWelcomeNotification = false;

  constructor(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    providerId: string
  ) {
    this.configManager = configManager;
    this.providerId = providerId;
    this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot LLM Gateway');

    // Get provider configuration
    const provider = this.configManager.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" not found in configuration`);
    }

    this.providerConfig = {
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
    };

    // Load legacy GatewayConfig for client compatibility
    this.gatewayConfig = this.loadLegacyConfig();
    this.client = new GatewayClient(this.gatewayConfig);
  }

  /**
   * Map VS Code message role to OpenAI role string
   */
  private mapRole(role: vscode.LanguageModelChatMessageRole): string {
    if (role === vscode.LanguageModelChatMessageRole.User) {
      return 'user';
    }
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
      return 'assistant';
    }
    return 'user';
  }

  /**
   * Convert a tool result part to OpenAI format
   */
  private convertToolResultPart(part: vscode.LanguageModelToolResultPart): Record<string, unknown> {
    return {
      tool_call_id: part.callId,
      role: 'tool',
      content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
    };
  }

  /**
   * Convert a tool call part to OpenAI format
   */
  private convertToolCallPart(part: vscode.LanguageModelToolCallPart): Record<string, unknown> {
    return {
      id: part.callId,
      type: 'function',
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input),
      },
    };
  }

  /**
   * Convert messages to OpenAI format
   */
  private convertMessages(messages: readonly vscode.LanguageModelChatMessage[]): Record<string, unknown>[] {
    const openAIMessages: Record<string, unknown>[] = [];

    for (const msg of messages) {
      const role = this.mapRole(msg.role);
      const toolResults: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      let textContent = '';

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          toolResults.push(this.convertToolResultPart(part));
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(this.convertToolCallPart(part));
        }
      }

      if (toolCalls.length > 0) {
        openAIMessages.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
      } else if (toolResults.length > 0) {
        openAIMessages.push(...toolResults);
      } else if (textContent) {
        openAIMessages.push({ role, content: textContent });
      }
    }

    return openAIMessages;
  }

  /**
   * Build request options
   */
  private buildRequestOptions(
    model: vscode.LanguageModelChatInformation,
    openAIMessages: any[],
    estimatedInputTokens: number
  ): any {
    // Get model-specific limits from config
    const resolvedModel = this.configManager.getModel(this.providerId, model.id);
    const modelMaxContext = resolvedModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens;
    const bufferTokens = 128;
    let safeMaxOutputTokens = Math.min(
      resolvedModel?.limit.output ?? this.gatewayConfig.defaultMaxOutputTokens,
      Math.floor(modelMaxContext - estimatedInputTokens - bufferTokens)
    );
    if (safeMaxOutputTokens < 64) {
      safeMaxOutputTokens = Math.max(64, Math.floor((resolvedModel?.limit.output ?? 2048) / 2));
    }

    this.outputChannel.appendLine(
      `Token estimate: input=${estimatedInputTokens}, model_context=${modelMaxContext}, chosen_max_tokens=${safeMaxOutputTokens}`
    );

    const requestOptions: any = {
      model: model.id,
      messages: openAIMessages,
      max_tokens: safeMaxOutputTokens,
      temperature: 0.7,
    };

    return requestOptions;
  }

  /**
   * Add tooling configuration
   */
  private addTooling(
    requestOptions: any,
    options: vscode.ProvideLanguageModelChatResponseOptions,
    modelCapabilities?: { toolCalling?: boolean }
  ): void {
    // Check if model supports tool calling
    const supportsToolCalling = modelCapabilities?.toolCalling ?? this.gatewayConfig.enableToolCalling;

    if (supportsToolCalling && options.tools && options.tools.length > 0) {
      requestOptions.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));

      if (options.toolMode !== undefined) {
        requestOptions.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
      }

      requestOptions.parallel_tool_calls = this.gatewayConfig.parallelToolCalling;
      this.outputChannel.appendLine(`Sending ${requestOptions.tools.length} tools to model (parallel: ${this.gatewayConfig.parallelToolCalling})`);
    }
  }

  /**
   * Get default value for a JSON schema type
   */
  private getDefaultForType(schema: Record<string, unknown> | null | undefined): unknown {
    if (!schema?.type) {
      return null;
    }

    switch (schema.type) {
      case 'string':
        return schema.default ?? '';
      case 'number':
      case 'integer':
        return schema.default ?? 0;
      case 'boolean':
        return schema.default ?? false;
      case 'array':
        return schema.default ?? [];
      case 'object':
        return schema.default ?? {};
      case 'null':
        return null;
      default:
        // Handle union types like ["string", "null"]
        if (Array.isArray(schema.type)) {
          if (schema.type.includes('null')) {
            return null;
          }
          // Use first non-null type
          for (const t of schema.type) {
            if (t !== 'null') {
              return this.getDefaultForType({ ...schema, type: t });
            }
          }
        }
        return null;
    }
  }

  /**
   * Fill in missing required properties with default values
   */
  private fillMissingRequiredProperties(
    args: Record<string, unknown>,
    toolName: string,
    toolSchema: Record<string, unknown> | null | undefined
  ): Record<string, unknown> {
    if (!toolSchema?.required || !Array.isArray(toolSchema.required)) {
      return args;
    }

    const properties = (toolSchema.properties || {}) as Record<string, Record<string, unknown>>;
    const filledArgs = { ...args };
    const filledProperties: string[] = [];

    for (const requiredProp of toolSchema.required as string[]) {
      if (!(requiredProp in filledArgs)) {
        const propSchema = properties[requiredProp];
        const defaultValue = this.getDefaultForType(propSchema);
        filledArgs[requiredProp] = defaultValue;
        filledProperties.push(`${requiredProp}=${JSON.stringify(defaultValue)}`);
      }
    }

    if (filledProperties.length > 0) {
      this.outputChannel.appendLine(`  AUTO-FILLED missing required properties: ${filledProperties.join(', ')}`);
    }

    return filledArgs;
  }

  /**
   * Estimate token count for a message
   */
  private estimateMessageTokens(message: any): number {
    let text = '';
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (message.content) {
      text = JSON.stringify(message.content);
    }
    if (message.tool_calls) {
      text += JSON.stringify(message.tool_calls);
    }
    // Rough estimate: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate messages to fit within token limit
   */
  private truncateMessagesToFit(messages: any[], maxTokens: number): any[] {
    if (messages.length === 0) {
      return messages;
    }

    // Calculate total tokens
    let totalTokens = 0;
    const messageTokens: number[] = [];
    for (const msg of messages) {
      const tokens = this.estimateMessageTokens(msg);
      messageTokens.push(tokens);
      totalTokens += tokens;
    }

    // If we're within limits, return as-is
    if (totalTokens <= maxTokens) {
      return messages;
    }

    this.outputChannel.appendLine(`Context overflow: ${totalTokens} tokens > ${maxTokens} limit. Truncating...`);

    // Strategy: Keep first message (system) and as many recent messages as possible
    const result: any[] = [];
    let usedTokens = 0;

    // Always keep the first message if it exists (usually system prompt)
    if (messages.length > 0) {
      result.push(messages[0]);
      usedTokens += messageTokens[0];
    }

    // Work backwards from the end, adding messages until we hit the limit
    const recentMessages: any[] = [];
    for (let i = messages.length - 1; i > 0; i--) {
      const msgTokens = messageTokens[i];
      if (usedTokens + msgTokens <= maxTokens) {
        recentMessages.unshift(messages[i]);
        usedTokens += msgTokens;
      } else {
        // Stop when we can't fit more messages
        break;
      }
    }

    // Combine first message with recent messages
    result.push(...recentMessages);

    this.outputChannel.appendLine(`Truncated: kept ${result.length}/${messages.length} messages, ~${usedTokens} tokens`);

    return result;
  }

  /**
   * Count occurrences of a character in a string
   */
  private countChar(str: string, char: string): number {
    // Escape regex special characters in the search char
    const escapePattern = /[.*+?^${}()|[\]\\]/g;
    const escapedChar = char.replaceAll(escapePattern, String.raw`\$&`);
    const regex = new RegExp(escapedChar, 'g');
    let count = 0;
    while (regex.exec(str) !== null) {
      count++;
    }
    return count;
  }

  /**
   * Balance unclosed braces/brackets in a JSON string
   */
  private balanceBrackets(str: string): string {
    let result = str;
    const missingBrackets = this.countChar(result, '[') - this.countChar(result, ']');
    const missingBraces = this.countChar(result, '{') - this.countChar(result, '}');

    result += ']'.repeat(Math.max(0, missingBrackets));
    result += '}'.repeat(Math.max(0, missingBraces));

    return result;
  }

  /**
   * Attempt to repair truncated or malformed JSON arguments
   */
  private tryRepairJson(jsonStr: string): unknown {
    if (!jsonStr || jsonStr.trim() === '') {
      return {};
    }

    // First, try direct parse
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Continue to repair attempts
    }

    // Attempt repairs for common issues
    let repaired = jsonStr.trim();

    // Fix missing closing brackets/braces
    repaired = this.balanceBrackets(repaired);

    // Fix trailing comma before closing brace/bracket
    repaired = repaired.replaceAll(/,\s*([}\]])/g, '$1');

    // Fix truncated string value - close the string if odd number of quotes
    if (this.countChar(repaired, '"') % 2 !== 0) {
      repaired += '"';
      repaired = this.balanceBrackets(repaired);
    }

    try {
      return JSON.parse(repaired);
    } catch {
      this.outputChannel.appendLine(`JSON repair failed. Original: ${jsonStr}`);
      this.outputChannel.appendLine(`Repaired attempt: ${repaired}`);
      return null;
    }
  }

  /**
   * Stream chat completion
   */
  private async streamChatCompletion(
    requestOptions: any,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.outputChannel.appendLine(`Streaming chat completion...`);
    let totalContent = '';
    let totalToolCalls = 0;

    for await (const chunk of this.client.streamChatCompletion(requestOptions as OpenAIChatCompletionRequest, token)) {
      if (token.isCancellationRequested) {
        break;
      }

      // Report text content immediately
      if (chunk.content) {
        totalContent += chunk.content;
        progress.report(new vscode.LanguageModelTextPart(chunk.content));
      }

      // Process finished tool calls
      if (chunk.finished_tool_calls && chunk.finished_tool_calls.length > 0) {
        for (const toolCall of chunk.finished_tool_calls) {
          totalToolCalls++;
          this.outputChannel.appendLine(`Tool call received: id=${toolCall.id}, name=${toolCall.name}`);
          this.outputChannel.appendLine(`  Raw arguments: ${toolCall.arguments.substring(0, 500)}${toolCall.arguments.length > 500 ? '...' : ''}`);

          // Parse arguments with repair capability
          let args = this.tryRepairJson(toolCall.arguments) as Record<string, unknown> | null;

          if (args === null) {
            this.outputChannel.appendLine(`ERROR: Failed to parse tool call arguments for ${toolCall.name}`);
            this.outputChannel.appendLine(`  Full arguments: ${toolCall.arguments}`);
            args = {}; // Fallback to empty args
          }

          progress.report(new vscode.LanguageModelToolCallPart(
            toolCall.id,
            toolCall.name,
            args as object
          ));
        }
      }
    }

    this.outputChannel.appendLine(`Completed chat request, received ${totalContent.length} characters, ${totalToolCalls} tool calls`);
  }

  /**
   * Provide language model information
   * Fetches models based on ConfigMode
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean; },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const configMode = this.configManager.getConfigMode();
    const showProviderPrefix = this.configManager.shouldShowProviderPrefix();

    this.outputChannel.appendLine(`Fetching models for provider "${this.providerId}" (mode: ${configMode})...`);

    // Get configured models
    const configuredModels = this.configManager.getModelsForProvider(this.providerId);

    // Handle different config modes
    switch (configMode) {
      case 'config-only':
        return this.buildModelInfoFromConfig(configuredModels, showProviderPrefix);

      case 'config-priority':
        return await this.fetchModelsWithConfigPriority(configuredModels, showProviderPrefix, options, token);

      case 'api-priority':
        return await this.fetchModelsWithApiPriority(configuredModels, showProviderPrefix, options, token);

      default:
        return this.buildModelInfoFromConfig(configuredModels, showProviderPrefix);
    }
  }

  /**
   * Build model info from configuration only
   */
  private buildModelInfoFromConfig(
    models: ResolvedModel[],
    showProviderPrefix: boolean
  ): vscode.LanguageModelChatInformation[] {
    return models.map((model) => ({
      id: model.id,
      name: showProviderPrefix ? `${model.providerId}/${model.name}` : model.name,
      family: 'llm-gateway',
      maxInputTokens: model.limit.context,
      maxOutputTokens: model.limit.output,
      version: '1.0.0',
      capabilities: {
        toolCalling: model.capabilities?.toolCalling ?? true,
      },
    }));
  }

  /**
   * Fetch models with config priority (config overrides API)
   */
  private async fetchModelsWithConfigPriority(
    configuredModels: ResolvedModel[],
    showProviderPrefix: boolean,
    options: { silent: boolean; },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // First, get configured models as base
    const modelMap = new Map<string, vscode.LanguageModelChatInformation>();

    for (const model of configuredModels) {
      modelMap.set(model.id, {
        id: model.id,
        name: showProviderPrefix ? `${model.providerId}/${model.name}` : model.name,
        family: 'llm-gateway',
        maxInputTokens: model.limit.context,
        maxOutputTokens: model.limit.output,
        version: '1.0.0',
        capabilities: {
          toolCalling: model.capabilities?.toolCalling ?? true,
        },
      });
    }

    // Then try to fetch from API and merge
    try {
      const response = await this.client.fetchModels();

      for (const apiModel of response.data) {
        // If model already in config, keep config values (config priority)
        if (!modelMap.has(apiModel.id)) {
          // Use defaults for API-only models
          const defaultMaxTokens = this.gatewayConfig.defaultMaxTokens;
          const defaultMaxOutput = this.gatewayConfig.defaultMaxOutputTokens;

          modelMap.set(apiModel.id, {
            id: apiModel.id,
            name: showProviderPrefix ? `${this.providerId}/${apiModel.id}` : apiModel.id,
            family: 'llm-gateway',
            maxInputTokens: defaultMaxTokens,
            maxOutputTokens: defaultMaxOutput,
            version: '1.0.0',
            capabilities: {
              toolCalling: this.gatewayConfig.enableToolCalling,
            },
          });
        }
      }

      this.outputChannel.appendLine(`Merged ${modelMap.size} models (config + API)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`API fetch failed, using config only: ${message}`);
    }

    return Array.from(modelMap.values());
  }

  /**
   * Fetch models with API priority (API overrides config for existing models)
   */
  private async fetchModelsWithApiPriority(
    configuredModels: ResolvedModel[],
    showProviderPrefix: boolean,
    options: { silent: boolean; },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const modelMap = new Map<string, ResolvedModel>();

    // Store configured models
    for (const model of configuredModels) {
      modelMap.set(model.id, model);
    }

    try {
      const response = await this.client.fetchModels();
      const result: vscode.LanguageModelChatInformation[] = [];

      for (const apiModel of response.data) {
        const configuredModel = modelMap.get(apiModel.id);

        // API priority: use API model id, but config values if available
        result.push({
          id: apiModel.id,
          name: showProviderPrefix
            ? `${this.providerId}/${configuredModel?.name ?? apiModel.id}`
            : (configuredModel?.name ?? apiModel.id),
          family: 'llm-gateway',
          maxInputTokens: configuredModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens,
          maxOutputTokens: configuredModel?.limit.output ?? this.gatewayConfig.defaultMaxOutputTokens,
          version: '1.0.0',
          capabilities: {
            toolCalling: configuredModel?.capabilities?.toolCalling ?? this.gatewayConfig.enableToolCalling,
          },
        });
      }

      this.outputChannel.appendLine(`Fetched ${result.length} models from API (with config overrides)`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`API fetch failed, falling back to config: ${message}`);

      if (!options.silent) {
        vscode.window.showWarningMessage(
          `LLM Gateway: Failed to fetch models from API. Using configured models only.`
        );
      }

      // Fallback to config
      return this.buildModelInfoFromConfig(configuredModels, showProviderPrefix);
    }
  }

  /**
   * Process a message part using duck-typing
   */
  private processPartDuckTyped(
    part: unknown,
    toolResults: Record<string, unknown>[],
    toolCalls: Record<string, unknown>[]
  ): void {
    const anyPart = part as Record<string, unknown>;
    if ('callId' in anyPart && 'content' in anyPart && !('name' in anyPart)) {
      this.outputChannel.appendLine(`  Found tool result (duck-typed): callId=${anyPart.callId}`);
      toolResults.push({
        tool_call_id: anyPart.callId,
        role: 'tool',
        content: typeof anyPart.content === 'string' ? anyPart.content : JSON.stringify(anyPart.content),
      });
    } else if ('callId' in anyPart && 'name' in anyPart && 'input' in anyPart) {
      this.outputChannel.appendLine(`  Found tool call (duck-typed): callId=${anyPart.callId}, name=${anyPart.name}`);
      toolCalls.push({
        id: anyPart.callId,
        type: 'function',
        function: { name: anyPart.name, arguments: JSON.stringify(anyPart.input) },
      });
    }
  }

  /**
   * Convert a single VS Code message to OpenAI format with logging
   */
  private convertSingleMessageWithLogging(msg: vscode.LanguageModelChatMessage): Record<string, unknown>[] {
    const role = this.mapRole(msg.role);
    const toolResults: Record<string, unknown>[] = [];
    const toolCalls: Record<string, unknown>[] = [];
    let textContent = '';

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        this.outputChannel.appendLine(`  Found tool result: callId=${part.callId}`);
        toolResults.push(this.convertToolResultPart(part));
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        this.outputChannel.appendLine(`  Found tool call: callId=${part.callId}, name=${part.name}`);
        toolCalls.push(this.convertToolCallPart(part));
      } else {
        this.processPartDuckTyped(part, toolResults, toolCalls);
      }
    }

    const result: Record<string, unknown>[] = [];
    if (toolCalls.length > 0) {
      result.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
    } else if (toolResults.length > 0) {
      result.push(...toolResults);
    } else if (textContent) {
      result.push({ role, content: textContent });
    }
    return result;
  }

  /**
   * Calculate safe max output tokens
   */
  private calculateSafeMaxOutputTokens(estimatedInputTokens: number, toolsOverhead: number, modelId: string): number {
    const resolvedModel = this.configManager.getModel(this.providerId, modelId);
    const modelMaxContext = resolvedModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens;
    const defaultMaxOutput = resolvedModel?.limit.output ?? this.gatewayConfig.defaultMaxOutputTokens;
    const totalEstimatedTokens = estimatedInputTokens + toolsOverhead;
    const conservativeInputEstimate = Math.ceil(totalEstimatedTokens * 1.2);
    const bufferTokens = 256;

    let safeMaxOutputTokens = Math.min(
      defaultMaxOutput,
      Math.floor(modelMaxContext - conservativeInputEstimate - bufferTokens)
    );

    return Math.max(64, safeMaxOutputTokens);
  }

  /**
   * Build tools configuration for request
   */
  private buildToolsConfig(
    options: vscode.ProvideLanguageModelChatResponseOptions,
    modelCapabilities?: { toolCalling?: boolean }
  ): Record<string, unknown>[] | undefined {
    const supportsToolCalling = modelCapabilities?.toolCalling ?? this.gatewayConfig.enableToolCalling;

    if (!supportsToolCalling || !options.tools || options.tools.length === 0) {
      return undefined;
    }

    this.currentToolSchemas.clear();

    return options.tools.map((tool) => {
      this.outputChannel.appendLine(`Tool: ${tool.name}`);
      this.outputChannel.appendLine(`  Description: ${tool.description?.substring(0, 100) || 'none'}...`);

      const schema = tool.inputSchema as Record<string, unknown> | undefined;
      this.currentToolSchemas.set(tool.name, schema);

      if (schema?.required && Array.isArray(schema.required)) {
        this.outputChannel.appendLine(`  Required properties: ${(schema.required as string[]).join(', ')}`);
      }

      return {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      };
    });
  }

  /**
   * Process a single tool call from the stream
   */
  private processToolCall(
    toolCall: { id: string; name: string; arguments: string },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    this.outputChannel.appendLine(`\n=== TOOL CALL RECEIVED ===`);
    this.outputChannel.appendLine(`  ID: ${toolCall.id}`);
    this.outputChannel.appendLine(`  Name: ${toolCall.name}`);
    this.outputChannel.appendLine(`  Raw arguments: ${toolCall.arguments.substring(0, 1000)}${toolCall.arguments.length > 1000 ? '...' : ''}`);

    let args = this.tryRepairJson(toolCall.arguments) as Record<string, unknown> | null;

    if (args === null) {
      this.outputChannel.appendLine(`  ERROR: Failed to parse tool call arguments`);
      this.outputChannel.appendLine(`  Full arguments: ${toolCall.arguments}`);
      args = {};
    } else {
      const argKeys = Object.keys(args);
      this.outputChannel.appendLine(`  Parsed argument keys: ${argKeys.length > 0 ? argKeys.join(', ') : '(none)'}`);
    }

    const toolSchema = this.currentToolSchemas.get(toolCall.name) as Record<string, unknown> | undefined;
    if (toolSchema) {
      args = this.fillMissingRequiredProperties(args, toolCall.name, toolSchema);
    }

    this.outputChannel.appendLine(`=== END TOOL CALL ===\n`);
    progress.report(new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.name, args));
  }

  /**
   * Handle empty response from model
   */
  private async handleEmptyResponse(
    model: vscode.LanguageModelChatInformation,
    inputText: string,
    messageCount: number,
    toolCount: number,
    token: vscode.CancellationToken,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): Promise<void> {
    const inputTokenCount = await this.provideTokenCount(model, inputText, token);
    const resolvedModel = this.configManager.getModel(this.providerId, model.id);
    const modelMaxContext = resolvedModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens;

    this.outputChannel.appendLine(`WARNING: Model returned empty response with no tool calls.`);
    this.outputChannel.appendLine(`  Input tokens estimated: ${inputTokenCount}`);
    this.outputChannel.appendLine(`  Messages in conversation: ${messageCount}`);
    this.outputChannel.appendLine(`  Tools provided: ${toolCount}`);

    const errorHint = toolCount > 0
      ? `The model returned an empty response. This typically indicates the model failed to generate valid output with tool calling enabled. Check the inference server logs for errors.`
      : `The model returned an empty response. Check the inference server logs for details.`;

    this.outputChannel.appendLine(`  Issue: ${errorHint}`);

    const errorMessage = `I was unable to generate a response. ${errorHint}\n\n` +
      `Diagnostic info:\n- Model: ${model.id}\n- Tools provided: ${toolCount}\n` +
      `- Estimated input tokens: ${inputTokenCount}\n- Context limit: ${modelMaxContext}\n\n` +
      `Check the "GitHub Copilot LLM Gateway" output panel for detailed logs.`;

    progress.report(new vscode.LanguageModelTextPart(errorMessage));
  }

  /**
   * Handle chat request error
   */
  private handleChatError(error: unknown): never {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';

    this.outputChannel.appendLine(`ERROR: Chat request failed: ${errorMessage}`);
    if (errorStack) {
      this.outputChannel.appendLine(`Stack trace: ${errorStack}`);
    }

    const isToolError = errorMessage.includes('HarmonyError') || errorMessage.includes('unexpected tokens');

    if (isToolError) {
      this.outputChannel.appendLine('HINT: This appears to be a tool calling format error.');
      this.outputChannel.appendLine('The model may not support function calling properly.');
      this.outputChannel.appendLine('Try: 1) Using a different model, 2) Disabling tool calling in settings, or 3) Checking inference server logs');

      const resolvedModel = this.configManager.getModel(this.providerId, '');

      vscode.window.showErrorMessage(
        `LLM Gateway: Model failed to generate valid tool calls. This model may not support function calling. Check Output panel for details.`,
        'Open Output', 'Disable Tool Calling'
      ).then((selection: string | undefined) => {
        if (selection === 'Open Output') {
          this.outputChannel.show();
        }
        // Note: Disable tool calling is now per-model, would need to update config
      });
    } else {
      vscode.window.showErrorMessage(`LLM Gateway: Chat request failed. ${errorMessage}`);
    }

    throw error;
  }

  /**
   * Provide language model chat response
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.outputChannel.appendLine(`Sending chat request to model: ${model.id}`);
    this.outputChannel.appendLine(`Tool mode: ${options.toolMode}, Tools: ${options.tools?.length || 0}`);
    this.outputChannel.appendLine(`Message count: ${messages.length}`);

    this.showWelcomeNotification(model.id);

    // Get model-specific capabilities
    const resolvedModel = this.configManager.getModel(this.providerId, model.id);
    const modelCapabilities = resolvedModel?.capabilities;

    // Convert messages
    const openAIMessages: Record<string, unknown>[] = [];
    for (const msg of messages) {
      openAIMessages.push(...this.convertSingleMessageWithLogging(msg));
    }
    this.outputChannel.appendLine(`Converted to ${openAIMessages.length} OpenAI messages`);

    // Log message structure
    for (let i = 0; i < openAIMessages.length; i++) {
      const msg = openAIMessages[i];
      const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : 'none';
      this.outputChannel.appendLine(`  Message ${i + 1}: role=${msg.role}, hasContent=${!!msg.content}, hasToolCalls=${!!msg.tool_calls}, toolCallId=${toolCallId}`);
    }

    // Calculate token limits and truncate
    const modelMaxContext = resolvedModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens;
    const desiredOutputTokens = Math.min(
      resolvedModel?.limit.output ?? this.gatewayConfig.defaultMaxOutputTokens,
      Math.floor(modelMaxContext / 2)
    );
    const toolsTokenEstimate = options.tools ? Math.ceil(JSON.stringify(options.tools).length / 4 * 1.2) : 0;
    const maxInputTokens = modelMaxContext - desiredOutputTokens - toolsTokenEstimate - 256;

    const truncatedMessages = this.truncateMessagesToFit(openAIMessages, maxInputTokens);
    if (truncatedMessages.length < openAIMessages.length) {
      this.outputChannel.appendLine(`WARNING: Truncated conversation from ${openAIMessages.length} to ${truncatedMessages.length} messages to fit context limit`);
    }

    // Build input text for token estimation
    const inputText = truncatedMessages
      .map((m) => {
        let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        if (m.tool_calls) { text += JSON.stringify(m.tool_calls); }
        return text;
      })
      .join('\n');

    const toolsOverhead = options.tools ? Math.ceil(JSON.stringify(options.tools).length / 4) : 0;
    const estimatedInputTokens = await this.provideTokenCount(model, inputText, token);
    const safeMaxOutputTokens = this.calculateSafeMaxOutputTokens(estimatedInputTokens, toolsOverhead, model.id);

    this.outputChannel.appendLine(
      `Token estimate: input=${estimatedInputTokens}, tools=${toolsOverhead}, model_context=${modelMaxContext}, chosen_max_tokens=${safeMaxOutputTokens}`
    );

    // Build request
    const hasTools = (modelCapabilities?.toolCalling ?? this.gatewayConfig.enableToolCalling) &&
                     options.tools && options.tools.length > 0;
    const temperature = hasTools ? (this.gatewayConfig.agentTemperature ?? 0) : 0.7;

    const requestOptions: Record<string, unknown> = {
      model: model.id,
      messages: truncatedMessages,
      max_tokens: safeMaxOutputTokens,
      temperature,
    };

    const toolsConfig = this.buildToolsConfig(options, modelCapabilities);
    if (toolsConfig) {
      requestOptions.tools = toolsConfig;
      if (options.toolMode !== undefined) {
        requestOptions.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
      }
      requestOptions.parallel_tool_calls = this.gatewayConfig.parallelToolCalling;
      this.outputChannel.appendLine(`Sending ${toolsConfig.length} tools to model (parallel: ${this.gatewayConfig.parallelToolCalling})`);
    }

    if (options.modelOptions) {
      Object.assign(requestOptions, options.modelOptions);
    }

    // Log request
    const debugRequest = JSON.stringify(requestOptions, null, 2);
    this.outputChannel.appendLine(debugRequest.length > 2000 ? `Request (truncated): ${debugRequest.substring(0, 2000)}...` : `Request: ${debugRequest}`);

    try {
      let totalContent = '';
      let totalToolCalls = 0;

      for await (const chunk of this.client.streamChatCompletion(requestOptions as unknown as OpenAIChatCompletionRequest, token)) {
        if (token.isCancellationRequested) { break; }

        if (chunk.content) {
          totalContent += chunk.content;
          progress.report(new vscode.LanguageModelTextPart(chunk.content));
        }

        if (chunk.finished_tool_calls?.length) {
          for (const toolCall of chunk.finished_tool_calls) {
            totalToolCalls++;
            this.processToolCall(toolCall, progress);
          }
        }
      }

      this.outputChannel.appendLine(`Completed chat request, received ${totalContent.length} characters, ${totalToolCalls} tool calls`);

      if (totalContent.length === 0 && totalToolCalls === 0) {
        await this.handleEmptyResponse(
          model,
          inputText,
          openAIMessages.length,
          requestOptions.tools ? (requestOptions.tools as unknown[]).length : 0,
          token,
          progress
        );
      }
    } catch (error) {
      this.handleChatError(error);
    }
  }

  /**
   * Provide token count estimation
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    // Simple approximation: ~4 characters per token
    let content: string;

    if (typeof text === 'string') {
      content = text;
    } else {
      // Filter and extract only text parts from the message content
      content = text.content
        .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
        .map((part) => part.value)
        .join('');
    }

    const estimatedTokens = Math.ceil(content.length / 4);
    return estimatedTokens;
  }

  /**
   * Show a timed notification with a link to settings (once per session)
   */
  private showWelcomeNotification(modelId: string): void {
    if (this.hasShownWelcomeNotification) {
      return;
    }
    this.hasShownWelcomeNotification = true;

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `LLM Gateway: ${modelId}  —  [Settings](command:workbench.action.openSettings?%22github.copilot.llm-gateway%22)`,
        cancellable: false,
      },
      () => new Promise((resolve) => setTimeout(resolve, 3000))
    );
  }

  /**
   * Load legacy GatewayConfig for client compatibility
   * This will be replaced with per-provider config in future refactor
   */
  private loadLegacyConfig(): GatewayConfig {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');

    const cfg: GatewayConfig = {
      serverUrl: this.providerConfig.baseURL,
      apiKey: this.providerConfig.apiKey ?? '',
      requestTimeout: config.get<number>('requestTimeout', 60000),
      defaultMaxTokens: config.get<number>('defaultMaxTokens', 32768),
      defaultMaxOutputTokens: config.get<number>('defaultMaxOutputTokens', 4096),
      enableToolCalling: config.get<boolean>('enableToolCalling', true),
      parallelToolCalling: config.get<boolean>('parallelToolCalling', true),
      agentTemperature: config.get<number>('agentTemperature', 0),
    };

    // Validate requestTimeout
    if (cfg.requestTimeout <= 0) {
      this.outputChannel.appendLine(`ERROR: requestTimeout must be > 0; using default 60000`);
      cfg.requestTimeout = 60000;
    }

    // Validate serverUrl format
    try {
      new URL(cfg.serverUrl);
    } catch {
      this.outputChannel.appendLine(`ERROR: Invalid server URL: ${cfg.serverUrl}`);
      throw new Error(`Invalid server URL: ${cfg.serverUrl}`);
    }

    // Validate defaultMaxOutputTokens relative to defaultMaxTokens
    if (cfg.defaultMaxOutputTokens >= cfg.defaultMaxTokens) {
      const adjusted = Math.max(64, cfg.defaultMaxTokens - 256);
      this.outputChannel.appendLine(
        `WARNING: defaultMaxOutputTokens (${cfg.defaultMaxOutputTokens}) >= defaultMaxTokens (${cfg.defaultMaxTokens}). Adjusting to ${adjusted}.`
      );
      cfg.defaultMaxOutputTokens = adjusted;
    }

    return cfg;
  }
}
