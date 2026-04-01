import * as vscode from 'vscode';
import type { getEncoding } from 'js-tiktoken';
import { GatewayClient } from './client';
import { AnthropicClient } from './anthropic-client';
import {
  GatewayConfig,
  OpenAIChatCompletionRequest,
  ModelConfig,
  ProviderConfig,
} from './types';
import { ConfigManager } from './config/ConfigManager';
import { ResolvedModel, ConfigMode, ProviderNameStyle } from './config/types';
import { TokenUsageViewProvider } from './views/TokenUsageView';

/**
 * Union type for either client type
 */
type ApiClient = GatewayClient | AnthropicClient;

/**
 * Language model provider for OpenAI-compatible inference servers
 * Supports multi-provider configuration
 */
export class GatewayProvider implements vscode.LanguageModelChatProvider {
  private readonly defaultClient: GatewayClient;
  private readonly clients: Map<string, ApiClient> = new Map();
  private gatewayConfig: GatewayConfig;
  private outputChannel: vscode.OutputChannel;
  private configManager: ConfigManager;
  // Store tool schemas for the current request to fill missing required properties
  private readonly currentToolSchemas: Map<string, unknown> = new Map();
  // Track if we've shown the welcome notification this session
  private hasShownWelcomeNotification = false;
  // Cache tiktoken encoder to avoid repeated imports
  private tiktokenEncoder: ReturnType<typeof getEncoding> | null = null;
  private tiktokenLoadAttempted = false;
  // Debug counter for token count calls
  private tokenCountCallCount = 0;
  private lastTokenCountLogTime = 0;
  // Track total prompt tokens for the current session
  private currentSessionPromptTokens = 0;
  private currentSessionCompletionTokens = 0;
  // Cache debug logs setting to avoid repeated config lookups
  private debugLogsEnabled = false;
  private tokenDebugLogsEnabled = false;
  // Status bar item for token usage display
  private tokenStatusBarItem: vscode.StatusBarItem | undefined;
  // Current session token statistics
  private currentContextTokens = 0;
  private currentModelMaxTokens = 0;
  private currentTokenDetails?: Array<{ category: string; label: string; percentage: number }>;
  // Token usage view provider
  private tokenUsageProvider?: TokenUsageViewProvider;

  constructor(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    outputChannel: vscode.OutputChannel
  ) {
    this.configManager = configManager;
    this.outputChannel = outputChannel;

    // Load default config from first provider or global settings
    this.gatewayConfig = this.loadDefaultConfig();
    this.defaultClient = new GatewayClient(this.gatewayConfig);

    // Initialize status bar item
    this.initializeStatusBar(context);

    // Watch for configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
        if (e.affectsConfiguration('github.copilot.llm-gateway')) {
          this.outputChannel.appendLine('Configuration changed, reloading...');
          this.reloadConfig();
        }
      })
    );

    // Initialize cached debug setting
    this.updateDebugSettings();
  }

  /**
   * Initialize status bar item for token display
   */
  private initializeStatusBar(context: vscode.ExtensionContext): void {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
    const tokenStatisticsEnabled = config.get<boolean>('enableTokenStatistics', true);

    if (tokenStatisticsEnabled) {
      this.tokenStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
      );
      // Click has visual feedback but tooltip immediately reappears
      // This mimics Copilot Chat's behavior where clicking doesn't disrupt the UX
      this.tokenStatusBarItem.command = 'github.copilot.llm-gateway.statusBarNoOp';
      context.subscriptions.push(this.tokenStatusBarItem);
      this.updateStatusBarVisibility();
    }
  }

  /**
   * Update status bar visibility based on active chat session
   */
  private updateStatusBarVisibility(): void {
    if (!this.tokenStatusBarItem) return;

    // Show status bar when there's an active chat session
    const hasActiveSession = vscode.window.visibleTextEditors.length > 0 ||
                             vscode.window.activeTerminal !== undefined;
    if (hasActiveSession) {
      this.tokenStatusBarItem.show();
    } else {
      this.tokenStatusBarItem.hide();
    }
  }

  /**
   * Format number with K/M suffix
   */
  private formatNumber(num: number): string {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  /**
   * Get localized string safely
   */
  private getLocalizedString(key: string, ...args: string[]): string {
    try {
      const result = vscode.l10n.t(key, args);
      // If the result is the same as key, try manual lookup
      if (result === key) {
        // Fallback to known translations
        const translations: Record<string, string> = {
          'token.contextWindow': '上下文窗口',
          'token.tokens': '个令牌',
          'token.remainingForResponse': '保留用于响应',
          'token.system': 'System',
          'token.userContext': 'User Context',
          'token.compactContext': '整理对话上下文',
        };
        return translations[key] || key;
      }
      return result;
    } catch {
      // Manual fallback
      const translations: Record<string, string> = {
        'token.contextWindow': '上下文窗口',
        'token.tokens': '个令牌',
        'token.remainingForResponse': '保留用于响应',
        'token.system': 'System',
        'token.userContext': 'User Context',
        'token.compactContext': '整理对话上下文',
      };
      return translations[key] || key;
    }
  }

  /**
   * Update token status bar with current usage
   */
  private updateTokenStatusBar(
    usedTokens: number,
    maxTokens: number,
    reservedTokens: number,
    details?: Array<{ category: string; label: string; percentage: number }>
  ): void {
    if (!this.tokenStatusBarItem) return;

    this.currentContextTokens = usedTokens;
    this.currentModelMaxTokens = maxTokens;

    const percentage = Math.round((usedTokens / maxTokens) * 100);
    // Status bar color: green (safe), yellow (warning), red (critical)
    // MODIFY HERE: Change these colors as needed
    let color: string | vscode.ThemeColor | undefined;
    if (percentage > 90) {
      // HIGH USAGE: Red color - modify this hex color if needed
      color = '#f44336';
    } else if (percentage > 70) {
      // MEDIUM USAGE: Yellow/Orange color - modify this hex color if needed
      color = '#ff9800';
    } else {
      // LOW USAGE: Green color - modify this hex color if needed
      color = '#6bcf7f';
    }

    this.tokenStatusBarItem.text = `$(symbol-keyword) ${percentage}%`;
    this.tokenStatusBarItem.color = color;

    // Build tooltip using Markdown
    const tooltip = new vscode.MarkdownString();
    tooltip.supportHtml = true;
    tooltip.isTrusted = true;

    // Group details by category
    const systemItems: Array<{ label: string; percentage: number }> = [];
    const userContextItems: Array<{ label: string; percentage: number }> = [];

    if (details && details.length > 0) {
      for (const detail of details) {
        const cat = detail.category.toLowerCase();
        if (cat.includes('system')) {
          systemItems.push(detail);
        } else if (cat.includes('user')) {
          userContextItems.push(detail);
        }
      }
    }

    tooltip.appendMarkdown(`### ${this.getLocalizedString('token.contextWindow')}\n\n`);

    const tokenText = `${this.formatNumber(usedTokens)}/${this.formatNumber(maxTokens)} ${this.getLocalizedString('token.tokens')}`;
    const percentageText = `${percentage.toFixed(1)}%`;
    tooltip.appendMarkdown(`${tokenText}  **${percentageText}**\n\n`);

    const filled = Math.round((percentage / 100) * 20);
    const empty = 20 - filled;
    // Use VS Code theme blue color for the progress bar
    const barFilled = '█'.repeat(filled);
    const barEmpty = '▒'.repeat(empty);
    tooltip.appendMarkdown(`<span style="color:var(--vscode-charts-blue)">${barFilled}</span><span style="color:var(--vscode-descriptionForeground)">${barEmpty}</span>\n\n`);

    // Show reserved tokens for response (similar to Copilot Chat)
    const reservedPercentage = ((reservedTokens / maxTokens) * 100).toFixed(1);
    tooltip.appendMarkdown(`${this.formatNumber(reservedTokens)} ${this.getLocalizedString('token.remainingForResponse')} (${reservedPercentage}%)\n\n`);

    // Build categories list (vertical layout like Copilot Chat)
    if (systemItems.length > 0 || userContextItems.length > 0) {
      tooltip.appendMarkdown(`**${this.getLocalizedString('token.system')}**  \n`);

      // System items - show percentage of total context window
      for (const item of systemItems) {
        // item.percentage is percentage of used tokens, convert to percentage of max context
        const contextPercentage = ((item.percentage / 100) * (usedTokens / maxTokens) * 100).toFixed(1);
        tooltip.appendMarkdown(`${item.label} ${contextPercentage}%  \n`);
      }

      // Empty line between sections
      if (systemItems.length > 0 && userContextItems.length > 0) {
        tooltip.appendMarkdown(`  \n`);
      }

      // User Context items
      if (userContextItems.length > 0) {
        tooltip.appendMarkdown(`**${this.getLocalizedString('token.userContext')}**  \n`);
        // Sort items to ensure consistent order: Messages, Files, Tool Results
        const sortedItems = userContextItems.sort((a, b) => {
          const order = ['Messages', 'Files', 'Tool Results'];
          return order.indexOf(a.label) - order.indexOf(b.label);
        });
        for (const item of sortedItems) {
          const contextPercentage = ((item.percentage / 100) * (usedTokens / maxTokens) * 100).toFixed(1);
          tooltip.appendMarkdown(`${item.label} ${contextPercentage}%  \n`);
        }
      }

      tooltip.appendMarkdown(`\n`);
    }

    tooltip.appendMarkdown(`---\n\n`);
    tooltip.appendMarkdown(`[${this.getLocalizedString('token.compactContext')}](command:github.copilot.llm-gateway.compactContext)`);

    this.tokenStatusBarItem.tooltip = tooltip;
    this.tokenStatusBarItem.show();

    // Update token details if provided
    if (details) {
      this.tokenDetails = details.map(d => ({
        ...d,
        tokens: Math.round((d.percentage / 100) * usedTokens)
      }));
    }

    this.outputChannel.appendLine(`[Token Statistics] ${usedTokens}/${maxTokens} (${percentage}%)`);
  }

  /**
   * Token detail categories for display
   */
  private tokenDetails: Array<{ category: string; label: string; tokens: number; percentage: number }> = [];

  public async compactContext(): Promise<void> {
    if (this.currentContextTokens === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('token.noActiveSession'));
      return;
    }

    this.outputChannel.appendLine('[Token Statistics] Opening Copilot Chat with /compact command');
    await vscode.commands.executeCommand('workbench.panel.chat.view.copilot.focus');
    await vscode.commands.executeCommand('type', { text: '/compact' });
    await vscode.commands.executeCommand('workbench.action.chat.submit');
  }

  /**
   * Show token usage information when clicking status bar
   * Opens the Token Usage view panel
   */
  public async showTokenUsage(): Promise<void> {
    if (this.currentContextTokens === 0) {
      vscode.window.showInformationMessage('No active session');
      return;
    }

    // Focus the token usage view
    await vscode.commands.executeCommand('llmGateway.tokenUsage.focus');
  }

  /**
   * Set the token usage view provider
   */
  public setTokenUsageProvider(provider: TokenUsageViewProvider): void {
    this.tokenUsageProvider = provider;
  }

  /**
   * Update cached debug settings
   */
  private updateDebugSettings(): void {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
    this.debugLogsEnabled = config.get<boolean>('enableDebugLogs', false);
    this.tokenDebugLogsEnabled = config.get<boolean>('enableTokenDebugLogs', false);
  }

  /**
   * Find provider and model config by model ID
   */
  private findModelAndProvider(modelId: string): { providerId: string; model: ResolvedModel } | undefined {
    const providers = this.configManager.getProviders();

    for (const provider of providers) {
      const model = this.configManager.getModel(provider.id, modelId);
      if (model) {
        return { providerId: provider.id, model };
      }
    }

    return undefined;
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
      content: typeof part.content === 'string' ? part.content : this.safeStringify(part.content),
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
        arguments: this.safeStringify(part.input),
      },
    };
  }

  /**
   * Convert messages to OpenAI format and categorize tokens
   * Supports text, images, tools, and tool results
   * Returns both the converted messages and token breakdown by category
   */
  private async convertMessagesWithCategories(
    messages: readonly vscode.LanguageModelChatMessage[],
    model: vscode.LanguageModelChatInformation,
    token: vscode.CancellationToken
  ): Promise<{
    messages: Record<string, unknown>[];
    categoryTokens: {
      messagesTokens: number;
      filesTokens: number;
      toolResultsTokens: number;
    };
  }> {
    const openAIMessages: Record<string, unknown>[] = [];
    let messagesTokens = 0;
    let filesTokens = 0;
    let toolResultsTokens = 0;

    for (const msg of messages) {
      const role = this.mapRole(msg.role);
      const toolResults: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

      // Debug: log message content types
      const contentTypes = msg.content.map((p: unknown) => {
        if (p instanceof vscode.LanguageModelTextPart) return 'text';
        if (p instanceof vscode.LanguageModelDataPart) return 'data';
        if (p instanceof vscode.LanguageModelToolResultPart) return 'tool_result';
        if (p instanceof vscode.LanguageModelToolCallPart) return 'tool_call';
        return 'unknown';
      });
      this.outputChannel.appendLine(`  Message role=${role}, contentTypes=[${contentTypes.join(', ')}], contentCount=${msg.content.length}`);

      for (const part of msg.content) {
        // Debug: log part types to understand file handling
        this.outputChannel.appendLine(`    Part type: ${part.constructor.name}, mimeType: ${(part as any).mimeType || 'N/A'}`);

        if (part instanceof vscode.LanguageModelTextPart) {
          contentParts.push({ type: 'text', text: part.value });
          // Count as messages (this includes regular text and file references)
          messagesTokens += await this.provideTokenCount(model, part.value, token);
        } else if (part instanceof vscode.LanguageModelDataPart) {
          // Handle file data (images and other binary data)
          if (part.mimeType.startsWith('image/')) {
            const base64Data = Buffer.from(part.data).toString('base64');
            const imageUrl = `data:${part.mimeType};base64,${base64Data}`;
            contentParts.push({ type: 'image_url', image_url: { url: imageUrl } });
            this.outputChannel.appendLine(`  Added image: ${part.mimeType}, ${part.data.length} bytes`);
            // Calculate image tokens based on dimensions
            const estimatedImageTokens = this.calculateImageTokens(part.data, part.mimeType);
            filesTokens += estimatedImageTokens;
            this.outputChannel.appendLine(`  Estimated image tokens: ${estimatedImageTokens}`);
          } else {
            // Handle other file types as text content
            const text = Buffer.from(part.data).toString('utf-8');
            contentParts.push({ type: 'text', text });
            this.outputChannel.appendLine(`  Added file: ${part.mimeType}, ${part.data.length} bytes`);
            // Count file content tokens
            const fileTokens = await this.provideTokenCount(model, text, token);
            filesTokens += fileTokens;
          }
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          const toolResult = this.convertToolResultPart(part);
          toolResults.push(toolResult);
          // Count tool result content
          const toolResultText = typeof toolResult.content === 'string' ? toolResult.content : this.safeStringify(toolResult.content);
          toolResultsTokens += await this.provideTokenCount(model, toolResultText, token);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(this.convertToolCallPart(part));
        }
      }

      if (toolCalls.length > 0) {
        // For tool calls, we need to extract text content separately
        const textContent = contentParts
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('');
        openAIMessages.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
      } else if (toolResults.length > 0) {
        openAIMessages.push(...toolResults);
      } else if (contentParts.length > 0) {
        // Use array format if there are images, otherwise simple string for compatibility
        if (contentParts.some(p => p.type === 'image_url')) {
          openAIMessages.push({ role, content: contentParts });
        } else {
          const textContent = contentParts.map(p => p.text).join('');
          openAIMessages.push({ role, content: textContent });
        }
      }
    }

    return {
      messages: openAIMessages,
      categoryTokens: {
        messagesTokens,
        filesTokens,
        toolResultsTokens,
      },
    };
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
    const modelAndProvider = this.findModelAndProvider(model.id);
    const resolvedModel = modelAndProvider?.model;
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
        filledProperties.push(`${requiredProp}=${this.safeStringify(defaultValue)}`);
      }
    }

    if (filledProperties.length > 0) {
      this.outputChannel.appendLine(`  AUTO-FILLED missing required properties: ${filledProperties.join(', ')}`);
    }

    return filledArgs;
  }

  /**
   * Safely stringify an object, handling circular references
   */
  private safeStringify(obj: unknown): string {
    try {
      return JSON.stringify(obj);
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('circular')) {
        // Handle circular references by using a replacer
        const seen = new WeakSet();
        return JSON.stringify(obj, (key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
              return '[Circular Reference]';
            }
            seen.add(value);
          }
          return value;
        });
      }
      return String(obj);
    }
  }

  /**
   * Estimate token count for a message
   */
  private estimateMessageTokens(message: any): number {
    let text = '';
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (message.content) {
      text = this.safeStringify(message.content);
    }
    if (message.tool_calls) {
      text += this.safeStringify(message.tool_calls);
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
   * Stream chat completion - delegates to appropriate client
   */
  private async streamChatCompletion(
    requestOptions: any,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    client: ApiClient,
    isAnthropic: boolean
  ): Promise<void> {
    this.outputChannel.appendLine(`Streaming chat completion...`);
    let totalContent = '';
    let totalToolCalls = 0;

    if (isAnthropic && client instanceof AnthropicClient) {
      for await (const chunk of client.streamMessages(requestOptions, token)) {
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
    } else if (client instanceof GatewayClient) {
      for await (const chunk of client.streamChatCompletion(requestOptions as OpenAIChatCompletionRequest, token)) {
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
    const providerNameStyle = this.configManager.getProviderNameStyle();

    this.outputChannel.appendLine(`Fetching models from all providers (mode: ${configMode}, style: ${providerNameStyle})...`);

    const allModels: vscode.LanguageModelChatInformation[] = [];
    const providers = this.configManager.getProviders();

    this.outputChannel.appendLine(`Found ${providers.length} provider(s) in config`);
    for (const provider of providers) {
      const modelCount = Object.keys(provider.models || {}).length;
      this.outputChannel.appendLine(`  Provider "${provider.id}": ${modelCount} model(s), baseURL=${provider.baseURL}`);
    }

    for (const provider of providers) {
      try {
        const providerModels = await this.fetchModelsForProvider(
          provider.id,
          configMode,
          showProviderPrefix,
          providerNameStyle,
          options,
          token
        );
        // Log model IDs with their source for debugging duplicates
        this.outputChannel.appendLine(`  Provider "${provider.id}" returned models: [${providerModels.map(m => m.id).join(', ')}]`);
        allModels.push(...providerModels);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(`Failed to fetch models from provider "${provider.id}": ${message}`);
      }
    }

    this.outputChannel.appendLine(`Found ${allModels.length} model(s) from all providers`);

    // Check for duplicate model IDs
    const idCounts = new Map<string, number>();
    for (const model of allModels) {
      idCounts.set(model.id, (idCounts.get(model.id) || 0) + 1);
    }
    const duplicates = Array.from(idCounts.entries()).filter(([_, count]) => count > 1);
    if (duplicates.length > 0) {
      this.outputChannel.appendLine(`WARNING: Found duplicate model IDs: ${duplicates.map(([id, count]) => `${id}(${count})`).join(', ')}`);
    }

    return allModels;
  }

  /**
   * Fetch models for a specific provider
   */
  private async fetchModelsForProvider(
    providerId: string,
    configMode: ConfigMode,
    showProviderPrefix: boolean,
    providerNameStyle: ProviderNameStyle,
    options: { silent: boolean; },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const configuredModels = this.configManager.getModelsForProvider(providerId);
    this.outputChannel.appendLine(`  Provider "${providerId}": ${configuredModels.length} configured model(s)`);
    for (const model of configuredModels) {
      this.outputChannel.appendLine(`    - ${model.id}: context=${model.limit.context}, output=${model.limit.output}`);
    }

    switch (configMode) {
      case 'config-only':
        return this.buildModelInfoFromConfig(providerId, configuredModels, showProviderPrefix, providerNameStyle);

      case 'config-priority':
        return await this.fetchModelsWithConfigPriority(providerId, configuredModels, showProviderPrefix, providerNameStyle, options, token);

      case 'api-priority':
        return await this.fetchModelsWithApiPriority(providerId, configuredModels, showProviderPrefix, providerNameStyle, options, token);

      default:
        return this.buildModelInfoFromConfig(providerId, configuredModels, showProviderPrefix, providerNameStyle);
    }
  }

  /**
   * Build configuration schema for model picker (e.g., thinking effort selector)
   * Reference: Copilot Chat's buildConfigurationSchema implementation
   *
   * Logic:
   * - If thinking.type !== 'enabled': no thinking configuration shown
   * - If thinking.levels is defined: show dropdown with specified levels
   * - If thinking.type === 'enabled' but no levels: enable thinking without dropdown
   */
  private buildConfigurationSchema(
    model: ResolvedModel
  ): vscode.LanguageModelConfigurationSchema | undefined {
    const thinking = model.options?.thinking;

    // If thinking is not enabled, return undefined
    if (!thinking || thinking.type !== 'enabled') {
      return undefined;
    }

    // If levels is specified, show dropdown in model picker
    if (thinking.levels && thinking.levels.length > 0) {
      const effortLevels = thinking.levels;
      const defaultEffort = thinking.effort && effortLevels.includes(thinking.effort)
        ? thinking.effort
        : effortLevels[0];

      // Filter descriptions based on available levels
      const levelDescriptions: Record<string, string> = {
        low: vscode.l10n.t('Faster responses with less reasoning'),
        medium: vscode.l10n.t('Balanced reasoning and speed'),
        high: vscode.l10n.t('Maximum reasoning depth'),
      };

      return {
        properties: {
          reasoningEffort: {
            type: 'string',
            title: vscode.l10n.t('Thinking Effort'),
            enum: effortLevels,
            enumItemLabels: effortLevels.map(level => level.charAt(0).toUpperCase() + level.slice(1)),
            enumDescriptions: effortLevels.map(level => levelDescriptions[level] || level),
            default: defaultEffort,
            group: 'navigation',
          }
        }
      };
    }

    // If no levels specified but thinking is enabled, no dropdown is shown
    // The model will use default thinking behavior
    return undefined;
  }

  /**
   * Build model info from configuration only
   */
  private buildModelInfoFromConfig(
    providerId: string,
    models: ResolvedModel[],
    showProviderPrefix: boolean,
    providerNameStyle: ProviderNameStyle = 'bracket'
  ): vscode.LanguageModelChatInformation[] {
    return models.map((model) => {
      this.outputChannel.appendLine(`  Building model info: ${model.id}, context=${model.limit.context}, output=${model.limit.output}`);
      // Format name based on style: 'slash' = provider/model, 'bracket' = [provider] model
      const formattedName = showProviderPrefix
        ? (providerNameStyle === 'slash' ? `${providerId}/${model.name}` : `[${providerId}] ${model.name}`)
        : model.name;

      // Build configuration schema if model supports thinking effort
      const configurationSchema = this.buildConfigurationSchema(model);

      return {
        id: model.id,
        name: formattedName,
        family: providerId, // Use providerId as family for grouping
        maxInputTokens: model.limit.context,
        maxOutputTokens: model.limit.output,
        version: '',
        capabilities: {
          toolCalling: model.capabilities?.toolCalling ?? true,
          imageInput: model.capabilities?.vision ?? false,
        },
        configurationSchema,
      };
    });
  }

  /**
   * Fetch models with config priority (config overrides API)
   */
  private async fetchModelsWithConfigPriority(
    providerId: string,
    configuredModels: ResolvedModel[],
    showProviderPrefix: boolean,
    providerNameStyle: ProviderNameStyle,
    options: { silent: boolean; },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // First, get configured models as base
    const modelMap = new Map<string, vscode.LanguageModelChatInformation>();

    // Helper to format name based on style
    const formatName = (name: string) => {
      if (!showProviderPrefix) return name;
      return providerNameStyle === 'slash' ? `${providerId}/${name}` : `[${providerId}] ${name}`;
    };

    for (const model of configuredModels) {
      // Build configuration schema if model supports thinking effort
      const configurationSchema = this.buildConfigurationSchema(model);

      modelMap.set(model.id, {
        id: model.id,
        name: formatName(model.name),
        family: providerId,
        maxInputTokens: model.limit.context,
        maxOutputTokens: model.limit.output,
        version: '',
        capabilities: {
          toolCalling: model.capabilities?.toolCalling ?? true,
          imageInput: model.capabilities?.vision ?? false,
        },
        configurationSchema,
      });
    }

    // If there are configured models, use them directly without API call
    if (configuredModels.length > 0) {
      this.outputChannel.appendLine(`  Provider "${providerId}": using ${configuredModels.length} configured model(s), skipping API fetch`);
      return Array.from(modelMap.values());
    }

    // Only fetch from API if no models are configured
    this.outputChannel.appendLine(`  Provider "${providerId}": no configured models, fetching from API...`);
    try {
      const client = this.getClient(providerId);
      const response = await client.fetchModels();

      for (const apiModel of response.data) {
        // Add API-only models
        this.outputChannel.appendLine(`    API model: ${apiModel.id}`);
        // Use defaults for API-only models
        const defaultMaxTokens = this.gatewayConfig.defaultMaxTokens;
        const defaultMaxOutput = this.gatewayConfig.defaultMaxOutputTokens;

        modelMap.set(apiModel.id, {
          id: apiModel.id,
          name: formatName(apiModel.id),
          family: providerId,
          maxInputTokens: defaultMaxTokens,
          maxOutputTokens: defaultMaxOutput,
          version: '',
          capabilities: {
            toolCalling: this.gatewayConfig.enableToolCalling,
            imageInput: false,
          },
        });
      }

      this.outputChannel.appendLine(`Merged ${modelMap.size} models (config + API)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`API fetch failed, using config only: ${message}`);
    }

    return Array.from(modelMap.values());
  }

  /**
   * Get or create client for a provider
   */
  private getClient(providerId: string): ApiClient {
    // Check if we already have a client for this provider
    const existingClient = this.clients.get(providerId);
    if (existingClient) {
      return existingClient;
    }

    // Create new client for this provider
    const provider = this.configManager.getProvider(providerId);
    if (!provider) {
      throw new Error(`Provider "${providerId}" not found`);
    }

    // Determine API format
    const apiFormat = provider.apiFormat ?? 'openai';

    if (apiFormat === 'anthropic') {
      // Create Anthropic client
      const anthropicClient = new AnthropicClient(provider);
      this.clients.set(providerId, anthropicClient);
      this.outputChannel.appendLine(`Created Anthropic client for provider "${providerId}"`);
      return anthropicClient;
    } else {
      // Create OpenAI-compatible client
      const gatewayConfig: GatewayConfig = {
        serverUrl: provider.baseURL,
        apiKey: provider.apiKey ?? '',
        requestTimeout: this.gatewayConfig.requestTimeout,
        defaultMaxTokens: this.gatewayConfig.defaultMaxTokens,
        defaultMaxOutputTokens: this.gatewayConfig.defaultMaxOutputTokens,
        enableToolCalling: this.gatewayConfig.enableToolCalling,
        parallelToolCalling: this.gatewayConfig.parallelToolCalling,
        agentTemperature: this.gatewayConfig.agentTemperature,
      };

      const client = new GatewayClient(gatewayConfig);
      this.clients.set(providerId, client);
      return client;
    }
  }

  /**
   * Fetch models with API priority (API overrides config for existing models)
   */
  private async fetchModelsWithApiPriority(
    providerId: string,
    configuredModels: ResolvedModel[],
    showProviderPrefix: boolean,
    providerNameStyle: ProviderNameStyle,
    options: { silent: boolean; },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const modelMap = new Map<string, ResolvedModel>();

    // Store configured models
    for (const model of configuredModels) {
      modelMap.set(model.id, model);
    }

    // Helper to format name based on style
    const formatName = (name: string) => {
      if (!showProviderPrefix) return name;
      return providerNameStyle === 'slash' ? `${providerId}/${name}` : `[${providerId}] ${name}`;
    };

    try {
      const client = this.getClient(providerId);
      const response = await client.fetchModels();
      const result: vscode.LanguageModelChatInformation[] = [];

      for (const apiModel of response.data) {
        const configuredModel = modelMap.get(apiModel.id);

        // Build configuration schema if configured model supports thinking
        const configurationSchema = configuredModel ? this.buildConfigurationSchema(configuredModel) : undefined;

        // API priority: use API model id, but config values if available
        result.push({
          id: apiModel.id,
          name: formatName(configuredModel?.name ?? apiModel.id),
          family: providerId,
          maxInputTokens: configuredModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens,
          maxOutputTokens: configuredModel?.limit.output ?? this.gatewayConfig.defaultMaxOutputTokens,
          version: '',
          capabilities: {
            toolCalling: configuredModel?.capabilities?.toolCalling ?? this.gatewayConfig.enableToolCalling,
            imageInput: configuredModel?.capabilities?.vision ?? false,
          },
          configurationSchema,
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
      return this.buildModelInfoFromConfig(providerId, configuredModels, showProviderPrefix, providerNameStyle);
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
        content: typeof anyPart.content === 'string' ? anyPart.content : this.safeStringify(anyPart.content),
      });
    } else if ('callId' in anyPart && 'name' in anyPart && 'input' in anyPart) {
      this.outputChannel.appendLine(`  Found tool call (duck-typed): callId=${anyPart.callId}, name=${anyPart.name}`);
      toolCalls.push({
        id: anyPart.callId,
        type: 'function',
        function: { name: anyPart.name, arguments: this.safeStringify(anyPart.input) },
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
    const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        this.outputChannel.appendLine(`  Found text part: ${part.value.substring(0, 100)}${part.value.length > 100 ? '...' : ''}`);
        contentParts.push({ type: 'text', text: part.value });
      } else if (part instanceof vscode.LanguageModelDataPart) {
        // Handle image data
        if (part.mimeType.startsWith('image/')) {
          const base64Data = Buffer.from(part.data).toString('base64');
          const imageUrl = `data:${part.mimeType};base64,${base64Data}`;
          contentParts.push({ type: 'image_url', image_url: { url: imageUrl } });
          this.outputChannel.appendLine(`  Found image: ${part.mimeType}, ${part.data.length} bytes`);
        } else {
          const text = Buffer.from(part.data).toString('utf-8');
          contentParts.push({ type: 'text', text });
          this.outputChannel.appendLine(`  Found data part: ${part.mimeType}, ${part.data.length} bytes`);
        }
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
      const textContent = contentParts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('');
      result.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
    } else if (toolResults.length > 0) {
      result.push(...toolResults);
    } else if (contentParts.length > 0) {
      // Use array format if there are images
      if (contentParts.some(p => p.type === 'image_url')) {
        result.push({ role, content: contentParts });
      } else {
        const textContent = contentParts.map(p => p.text).join('');
        result.push({ role, content: textContent });
      }
    }
    return result;
  }

  /**
   * Calculate safe max output tokens
   * Ensures minimum output capacity even under high input load
   */
  private calculateSafeMaxOutputTokens(estimatedInputTokens: number, toolsOverhead: number, modelId: string): number {
    const modelAndProvider = this.findModelAndProvider(modelId);
    const resolvedModel = modelAndProvider?.model;
    const modelMaxContext = resolvedModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens;
    const defaultMaxOutput = resolvedModel?.limit.output ?? this.gatewayConfig.defaultMaxOutputTokens;
    const totalEstimatedTokens = estimatedInputTokens + toolsOverhead;

    // Dynamic buffer: smaller buffer when input is high to ensure output capacity
    const inputPercentage = totalEstimatedTokens / modelMaxContext;
    let bufferTokens: number;
    let conservativeMultiplier: number;

    if (inputPercentage > 0.8) {
      // High usage: minimal buffer, no conservative multiplier
      bufferTokens = 128;
      conservativeMultiplier = 1.0;
    } else if (inputPercentage > 0.6) {
      // Medium usage: moderate buffer
      bufferTokens = 192;
      conservativeMultiplier = 1.1;
    } else {
      // Low usage: standard buffer
      bufferTokens = 256;
      conservativeMultiplier = 1.2;
    }

    const conservativeInputEstimate = Math.ceil(totalEstimatedTokens * conservativeMultiplier);

    let safeMaxOutputTokens = Math.min(
      defaultMaxOutput,
      Math.floor(modelMaxContext - conservativeInputEstimate - bufferTokens)
    );

    // Ensure minimum 4K output capacity for reasonable responses
    const minOutputTokens = Math.min(4096, Math.floor(modelMaxContext * 0.2));
    return Math.max(minOutputTokens, safeMaxOutputTokens);
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
    const modelAndProvider = this.findModelAndProvider(model.id);
    const resolvedModel = modelAndProvider?.model;
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
    // Get configuration for this request (once per request)
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
    const tokenStatisticsEnabled = config.get<boolean>('enableTokenStatistics', true);
    // Update cached debug setting for this request
    this.debugLogsEnabled = config.get<boolean>('enableDebugLogs', false);

    this.outputChannel.appendLine(`Sending chat request to model: ${model.id}`);
    this.outputChannel.appendLine(`Tool mode: ${options.toolMode}, Tools: ${options.tools?.length || 0}`);
    this.outputChannel.appendLine(`Message count: ${messages.length}`);

    this.showWelcomeNotification(model.id);

    // Find model and its provider
    const modelAndProvider = this.findModelAndProvider(model.id);
    if (!modelAndProvider) {
      throw new Error(`Model "${model.id}" not found in any provider configuration`);
    }

    const { providerId, model: resolvedModel } = modelAndProvider;
    const modelCapabilities = resolvedModel?.capabilities;

    // Get the client for this provider
    const client = this.getClient(providerId);

    // Check if using Anthropic format (needed for thinking configuration and streaming)
    const provider = this.configManager.getProvider(providerId);
    const isAnthropic = provider?.apiFormat === 'anthropic';

    // Convert messages and categorize tokens
    const { messages: openAIMessages, categoryTokens } = await this.convertMessagesWithCategories(messages, model, token);
    const { messagesTokens, filesTokens, toolResultsTokens } = categoryTokens;
    this.outputChannel.appendLine(`Converted to ${openAIMessages.length} OpenAI messages`);
    this.outputChannel.appendLine(`Token breakdown: messages=${messagesTokens}, files=${filesTokens}, toolResults=${toolResultsTokens}`);

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
    const toolsTokenEstimate = options.tools ? await this.provideTokenCount(model, this.safeStringify(options.tools), token) : 0;
    const maxInputTokens = modelMaxContext - desiredOutputTokens - toolsTokenEstimate - 256;

    const truncatedMessages = this.truncateMessagesToFit(openAIMessages, maxInputTokens);
    if (truncatedMessages.length < openAIMessages.length) {
      this.outputChannel.appendLine(`WARNING: Truncated conversation from ${openAIMessages.length} to ${truncatedMessages.length} messages to fit context limit`);
    }

    // Build input text for token estimation
    const inputText = truncatedMessages
      .map((m) => {
        let text = typeof m.content === 'string' ? m.content : this.safeStringify(m.content || '');
        if (m.tool_calls) { text += this.safeStringify(m.tool_calls); }
        return text;
      })
      .join('\n');

    const toolsOverhead = options.tools ? await this.provideTokenCount(model, this.safeStringify(options.tools), token) : 0;
    const estimatedInputTokens = await this.provideTokenCount(model, inputText, token) + toolsOverhead;
    const safeMaxOutputTokens = this.calculateSafeMaxOutputTokens(estimatedInputTokens, toolsOverhead, model.id);

    this.outputChannel.appendLine(
      `Token estimate: input=${estimatedInputTokens}, tools=${toolsOverhead}, model_context=${modelMaxContext}, chosen_max_tokens=${safeMaxOutputTokens}`
    );

    // Update token statistics display if enabled
    if (tokenStatisticsEnabled) {
      // Calculate total tokens including tools overhead
      const totalTokens = estimatedInputTokens + toolsOverhead;

      // Calculate percentages based on categorized tokens
      const systemTokens = Math.floor(totalTokens * 0.13); // System Instructions ~13%
      const toolDefTokens = options.tools ? toolsOverhead : 0;

      // Calculate actual percentages
      const systemPercentage = Math.round((systemTokens / totalTokens) * 100);
      const toolDefPercentage = Math.round((toolDefTokens / totalTokens) * 100);
      const messagesPercentage = Math.round((messagesTokens / totalTokens) * 100);
      const filesPercentage = Math.round((filesTokens / totalTokens) * 100);
      const toolResultsPercentage = Math.round((toolResultsTokens / totalTokens) * 100);

      // Use safeMaxOutputTokens (dynamic remaining capacity) for "reserved for response"
      // This represents the actual available output tokens for this request
      const reservedOutputTokens = safeMaxOutputTokens;

      this.outputChannel.appendLine(
        `[Token Statistics] reservedOutputTokens=${reservedOutputTokens}, safeMaxOutputTokens=${safeMaxOutputTokens}, desiredOutputTokens=${desiredOutputTokens}, estimatedInputTokens=${estimatedInputTokens}`
      );

      // Build details array with all 5 categories
      const details: Array<{ category: string; label: string; percentage: number }> = [
        { category: 'System', label: 'System Instructions', percentage: systemPercentage },
      ];

      this.outputChannel.appendLine(
        `[Token Statistics Debug] Building details: messagesTokens=${messagesTokens}, filesTokens=${filesTokens}, toolResultsTokens=${toolResultsTokens}, options.tools=${!!options.tools}`
      );

      if (options.tools && toolDefTokens > 0) {
        details.push({ category: 'System', label: 'Tool Definitions', percentage: toolDefPercentage });
      }

      if (messagesTokens > 0) {
        details.push({ category: 'User Context', label: 'Messages', percentage: messagesPercentage });
      }

      if (filesTokens > 0) {
        details.push({ category: 'User Context', label: 'Files', percentage: filesPercentage });
      }

      if (toolResultsTokens > 0) {
        details.push({ category: 'User Context', label: 'Tool Results', percentage: toolResultsPercentage });
        this.outputChannel.appendLine(`[Token Statistics Debug] Added Tool Results: ${toolResultsTokens} tokens, ${toolResultsPercentage}%`);
      }

      this.outputChannel.appendLine(`[Token Statistics Debug] Total details items: ${details.length}`);

      // Save details for later updates
      this.currentTokenDetails = details;

      this.updateTokenStatusBar(totalTokens, modelMaxContext, reservedOutputTokens, details);
    }

    // Build request
    const hasTools = (modelCapabilities?.toolCalling ?? this.gatewayConfig.enableToolCalling) &&
                     options.tools && options.tools.length > 0;

    const requestOptions: Record<string, unknown> = {
      model: model.id,
      messages: truncatedMessages,
      max_tokens: safeMaxOutputTokens,
    };

    // Add sampling parameters ONLY if explicitly configured
    // Temperature: use model config > tool mode default, or don't send if neither
    if (resolvedModel?.options?.temperature !== undefined) {
      requestOptions.temperature = resolvedModel.options.temperature;
    } else if (hasTools) {
      requestOptions.temperature = this.gatewayConfig.agentTemperature ?? 0;
    }
    // If neither configured, don't send temperature (let server use default)

    if (resolvedModel?.options?.topP !== undefined) {
      requestOptions.top_p = resolvedModel.options.topP;
    }
    if (resolvedModel?.options?.frequencyPenalty !== undefined) {
      requestOptions.frequency_penalty = resolvedModel.options.frequencyPenalty;
    }
    if (resolvedModel?.options?.presencePenalty !== undefined) {
      requestOptions.presence_penalty = resolvedModel.options.presencePenalty;
    }

    const toolsConfig = this.buildToolsConfig(options, modelCapabilities);
    if (toolsConfig) {
      requestOptions.tools = toolsConfig;
      if (options.toolMode !== undefined) {
        requestOptions.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
      }
      requestOptions.parallel_tool_calls = this.gatewayConfig.parallelToolCalling;
      this.outputChannel.appendLine(`Sending ${toolsConfig.length} tools to model (parallel: ${this.gatewayConfig.parallelToolCalling})`);
    }

    // Add model-specific options (e.g., thinking configuration)
    if (resolvedModel?.options?.thinking && resolvedModel.options.thinking.type === 'enabled') {
      const thinking = resolvedModel.options.thinking;

      // Get user-selected effort from model configuration
      // If user selected from dropdown, use that value
      // Otherwise, use config default (effort) or first available level
      const userSelectedEffort = (options as unknown as Record<string, unknown>)?.modelConfiguration?.reasoningEffort;
      const configEffort = thinking.effort;
      const availableLevels = thinking.levels;

      // Determine effective effort:
      // 1. User selected from dropdown (highest priority)
      // 2. Configured effort value
      // 3. First available level (if levels configured)
      // 4. undefined (use API default)
      let effectiveEffort: string | undefined;
      if (typeof userSelectedEffort === 'string') {
        effectiveEffort = userSelectedEffort;
      } else if (configEffort) {
        effectiveEffort = configEffort;
      } else if (availableLevels && availableLevels.length > 0) {
        effectiveEffort = availableLevels[0];
      }

      // Handle different API formats for thinking configuration
      if (isAnthropic) {
        // Anthropic format: { type: 'enabled', budget_tokens: number }
        // Only send thinking object if budgetTokens is specified
        if (thinking.budgetTokens) {
          requestOptions.thinking = {
            type: thinking.type,
            budget_tokens: thinking.budgetTokens,
          };
        }
      } else {
        // OpenAI-compatible format
        // For o1/o3 models: reasoning_effort field
        if (effectiveEffort) {
          requestOptions.reasoning_effort = effectiveEffort;
        }

        // Some APIs may use thinking object
        if (thinking.budgetTokens) {
          requestOptions.thinking = {
            type: thinking.type,
            budget_tokens: thinking.budgetTokens,
          };
        }
      }

      this.outputChannel.appendLine(
        `Thinking configured: type=${thinking.type}, ` +
        `${effectiveEffort ? `effort=${effectiveEffort}${userSelectedEffort ? ' (user selected)' : ' (config default)'}, ` : 'effort=API default, '}` +
        `${thinking.budgetTokens ? `budgetTokens=${thinking.budgetTokens}` : 'budgetTokens=API default'}`
      );
    }

    if (options.modelOptions) {
      Object.assign(requestOptions, options.modelOptions);
    }

    // Log request
    const debugRequest = this.safeStringify(requestOptions);
    this.outputChannel.appendLine(debugRequest.length > 2000 ? `Request (truncated): ${debugRequest.substring(0, 2000)}...` : `Request: ${debugRequest}`);

    try {
      let totalContent = '';
      let totalToolCalls = 0;
      // Initialize with estimated values as fallback
      // Many OpenAI-compatible APIs don't return usage data in streaming mode
      let promptTokens = estimatedInputTokens || 0;
      let completionTokens = 0;

      if (isAnthropic && client instanceof AnthropicClient) {
        // Use Anthropic streaming format
        for await (const chunk of client.streamMessages(requestOptions as unknown as Parameters<AnthropicClient['streamMessages']>[0], token)) {
          if (token.isCancellationRequested) { break; }

          if (chunk.content) {
            totalContent += chunk.content;
            progress.report(new vscode.LanguageModelTextPart(chunk.content));
          }

          // Handle thinking content from Claude 3.7+
          // Try to use LanguageModelThinkingPart if available (VS Code API), otherwise accumulate silently
          if (chunk.thinking) {
            totalContent += chunk.thinking;
            // Try to report as ThinkingPart for collapsible UI, fallback to silent accumulation
            try {
              // @ts-ignore - LanguageModelThinkingPart may not be in the types yet
              if (vscode.LanguageModelThinkingPart) {
                // @ts-ignore
                progress.report(new vscode.LanguageModelThinkingPart(chunk.thinking));
              }
            } catch {
              // ThinkingPart not available, don't expose thinking to user
            }
          }

          // Capture usage data (Anthropic usually provides this)
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          }

          if (chunk.finished_tool_calls?.length) {
            for (const toolCall of chunk.finished_tool_calls) {
              totalToolCalls++;
              this.processToolCall(toolCall, progress);
            }
          }
        }
      } else if (client instanceof GatewayClient) {
        // Use OpenAI streaming format
        for await (const chunk of client.streamChatCompletion(requestOptions as unknown as OpenAIChatCompletionRequest, token)) {
          if (token.isCancellationRequested) { break; }

          if (chunk.content) {
            totalContent += chunk.content;
            progress.report(new vscode.LanguageModelTextPart(chunk.content));
          }

          // Handle reasoning_content (thinking) from OpenAI-compatible APIs (e.g., DeepSeek, Qwen)
          // Try to use LanguageModelThinkingPart if available for collapsible UI
          if (chunk.reasoning) {
            totalContent += chunk.reasoning;
            try {
              // @ts-ignore - LanguageModelThinkingPart may not be in the types yet
              if (vscode.LanguageModelThinkingPart) {
                // @ts-ignore
                progress.report(new vscode.LanguageModelThinkingPart(chunk.reasoning));
              }
            } catch {
              // ThinkingPart not available, don't expose thinking to user
            }
          }

          // Capture usage data if provided by API
          // Note: Many OpenAI-compatible APIs don't include usage in streaming responses
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          }

          if (chunk.finished_tool_calls?.length) {
            for (const toolCall of chunk.finished_tool_calls) {
              totalToolCalls++;
              this.processToolCall(toolCall, progress);
            }
          }
        }
      }

      // Estimate completion tokens from generated content if not provided by API
      // Use ~4 characters per token as a rough estimate
      if (completionTokens === 0 && totalContent.length > 0) {
        completionTokens = Math.ceil(totalContent.length / 4);
        this.outputChannel.appendLine(`Estimated completion tokens from content length: ${completionTokens}`);
      }

      this.outputChannel.appendLine(`Completed chat request, received ${totalContent.length} characters, ${totalToolCalls} tool calls`);

      // Report token usage to VS Code for context window display
      if (promptTokens > 0 || completionTokens > 0) {
        // Build basic prompt token details
        // Note: This is a simplified breakdown. In a full implementation,
        // we would categorize tokens by System, UserContext, etc.
        const promptTokenDetails: Array<{ category: string; label: string; percentageOfPrompt: number }> = [];

        // System tokens (estimated ~10% for system instructions)
        const systemTokens = Math.floor(promptTokens * 0.1);
        if (systemTokens > 0) {
          promptTokenDetails.push({
            category: 'System',
            label: 'System Instructions',
            percentageOfPrompt: Math.round((systemTokens / promptTokens) * 100),
          });
        }

        // Tool definitions tokens (if tools are used)
        if (options.tools && options.tools.length > 0) {
          const toolTokens = Math.floor(promptTokens * 0.15);
          promptTokenDetails.push({
            category: 'System',
            label: 'Tool Definitions',
            percentageOfPrompt: Math.round((toolTokens / promptTokens) * 100),
          });
        }

        // User context (remaining tokens)
        const userTokens = promptTokens - systemTokens - (options.tools ? Math.floor(promptTokens * 0.15) : 0);
        if (userTokens > 0) {
          promptTokenDetails.push({
            category: 'User Context',
            label: 'Messages',
            percentageOfPrompt: Math.round((userTokens / promptTokens) * 100),
          });
        }

        // Report token usage via DataPart (experimental)
        // This attempts to send token usage through a special MIME type that Copilot Chat might recognize
        try {
          const usageData = new TextEncoder().encode(JSON.stringify({
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            outputBuffer: safeMaxOutputTokens,
            timestamp: Date.now(),
          }));
          progress.report(new vscode.LanguageModelDataPart(usageData, 'application/vnd.github.copilot-llm-gateway.usage+json'));
          this.outputChannel.appendLine(`Token usage reported via DataPart: prompt=${promptTokens}, completion=${completionTokens}`);
        } catch (e) {
          this.outputChannel.appendLine(`Token usage DataPart failed: ${e}`);
        }

        // Report token usage if the API supports it (fallback)
        // Note: progress.usage is part of the proposed API and may not be available in all VS Code versions
        // This feature is controlled by enableCopilotUsageReport setting (default: false) due to potential compatibility issues
        const copilotUsageReportEnabled = vscode.workspace.getConfiguration('github.copilot.llm-gateway').get<boolean>('enableCopilotUsageReport', false);
        if (copilotUsageReportEnabled && typeof (progress as any).usage === 'function') {
          try {
            (progress as any).usage({
              promptTokens,
              completionTokens,
              outputBuffer: safeMaxOutputTokens,
              promptTokenDetails,
            });
            this.outputChannel.appendLine(`Token usage reported via usage(): prompt=${promptTokens}, completion=${completionTokens}, outputBuffer=${safeMaxOutputTokens}`);
          } catch (usageError) {
            this.outputChannel.appendLine(`Token usage via usage() failed (API may have changed): ${usageError}`);
          }
        } else {
          this.outputChannel.appendLine(`Token usage tracking: prompt=${promptTokens}, completion=${completionTokens}, total=${promptTokens + completionTokens}`);
        }

        // Log detailed token breakdown from API
        this.outputChannel.appendLine(`[Token API Response] prompt_tokens=${promptTokens}, completion_tokens=${completionTokens}, total_tokens=${promptTokens + completionTokens}`);
        this.outputChannel.appendLine(`[Token Comparison] estimated_input=${estimatedInputTokens}, actual_prompt=${promptTokens}, diff=${promptTokens - estimatedInputTokens}`);

        // Update status bar after conversation completes with ACTUAL token counts from API
        // This gives us accurate picture of token usage including precise image token counts
        const totalTokens = promptTokens + completionTokens;
        this.currentSessionPromptTokens = promptTokens;
        this.currentSessionCompletionTokens = completionTokens;
        // Calculate reserved tokens for next response
        const modelMaxContext = resolvedModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens;
        const desiredOutputTokens = Math.min(
          resolvedModel?.limit.output ?? this.gatewayConfig.defaultMaxOutputTokens,
          Math.floor(modelMaxContext / 2)
        );
        const reservedForNext = Math.max(64, desiredOutputTokens - completionTokens);
        // Use saved details to preserve category breakdown
        this.outputChannel.appendLine(`[Token Debug] Before update: estimated=${estimatedInputTokens}, API returned prompt=${promptTokens}, completion=${completionTokens}, total=${totalTokens}`);
        this.updateTokenStatusBar(totalTokens, modelMaxContext, reservedForNext, this.currentTokenDetails);
      }

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
   * Provide token count estimation using tiktoken
   * Falls back to character-based estimation if tiktoken fails
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    this.tokenCountCallCount++;

    let content: string;

    if (typeof text === 'string') {
      content = text;
    } else {
      // Fast path for string content messages
      if (text.content.length === 1 && text.content[0] instanceof vscode.LanguageModelTextPart) {
        content = text.content[0].value;
      } else {
        // Extract content from all part types, not just text parts
        const parts: string[] = [];
        for (const part of text.content) {
          if (part instanceof vscode.LanguageModelTextPart) {
            parts.push(part.value);
          } else if (part instanceof vscode.LanguageModelToolResultPart) {
            // Include tool result content
            parts.push(`Tool result: ${part.callId}`);
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            // Include tool call content
            parts.push(`Tool call: ${part.name}`);
          } else if (part instanceof vscode.LanguageModelDataPart) {
            // Include data part (usually binary data like images)
            parts.push(`[Data: ${part.mimeType}, ${part.data.length} bytes]`);
          }
        }
        content = parts.join('\n');
      }
    }

    // Log call details with stack trace to debug frequent calls (only if token debug enabled)
    if (this.tokenDebugLogsEnabled) {
      const stack = new Error().stack?.split('\n').slice(3, 6).join(' | ') || 'no stack';
      this.outputChannel.appendLine(`[TokenCount #${this.tokenCountCallCount}] len=${content.length} | ${stack}`);
    }

    try {
      // Lazy load tiktoken encoder with caching
      if (!this.tiktokenEncoder && !this.tiktokenLoadAttempted) {
        this.tiktokenLoadAttempted = true;
        const { getEncoding } = await import('js-tiktoken');
        this.tiktokenEncoder = getEncoding('cl100k_base');
      }

      if (this.tiktokenEncoder) {
        const tokens = this.tiktokenEncoder.encode(content);
        const count = tokens.length;
        if (this.tokenDebugLogsEnabled) {
          this.outputChannel.appendLine(`  -> tiktoken: ${count} tokens`);
        }
        return count;
      } else {
        // Fallback if encoder failed to load
        const count = Math.ceil(content.length / 4);
        if (this.tokenDebugLogsEnabled) {
          this.outputChannel.appendLine(`  -> fallback: ${count} tokens`);
        }
        return count;
      }
    } catch (error) {
      // Fallback to character-based estimation
      const count = Math.ceil(content.length / 4);
      if (this.tokenDebugLogsEnabled) {
        this.outputChannel.appendLine(`  -> fallback(error): ${count} tokens`);
      }
      return count;
    }
  }

  /**
   * Calculate image tokens based on OpenAI/GPT-4V formula:
   * 1. Resize to fit within 2048x2048 (maintaining aspect ratio)
   * 2. Scale so shortest side is 768px (optional, for low detail mode)
   * 3. Divide into 512x512 tiles
   * 4. Token count = (num_tiles_x * num_tiles_y) * 170 + 85 (base tokens)
   *
   * Simplified formula: tokens = ceil(width/512) * ceil(height/512) * 170 + 85
   */
  private calculateImageTokens(data: Uint8Array, mimeType: string): number {
    // Try to extract dimensions from image data
    const dimensions = this.extractImageDimensions(data, mimeType);

    if (dimensions) {
      const { width, height } = dimensions;

      // Step 1: Resize to fit within 2048x2048
      let w = width;
      let h = height;
      const maxSize = 2048;
      if (w > maxSize || h > maxSize) {
        const scale = maxSize / Math.max(w, h);
        w = Math.floor(w * scale);
        h = Math.floor(h * scale);
      }

      // Step 2: Calculate tiles (512x512 each)
      const tilesX = Math.ceil(w / 512);
      const tilesY = Math.ceil(h / 512);
      const totalTiles = tilesX * tilesY;

      // Step 3: Calculate tokens (170 per tile + 85 base)
      const tokens = totalTiles * 170 + 85;

      this.outputChannel.appendLine(`  Image dimensions: ${width}x${height} -> scaled ${w}x${h}, tiles: ${tilesX}x${tilesY}=${totalTiles}, tokens: ${tokens}`);
      return tokens;
    }

    // Fallback: estimate based on file size
    // This is less accurate but provides a reasonable estimate
    const fileSizeKB = data.length / 1024;
    // Assume 1KB ≈ 8 tiles (rough estimate for compressed images)
    const estimatedTiles = Math.max(1, Math.ceil(fileSizeKB / 8));
    const tokens = estimatedTiles * 170 + 85;

    this.outputChannel.appendLine(`  Image size: ${fileSizeKB.toFixed(2)}KB, estimated tiles: ${estimatedTiles}, tokens: ${tokens} (dimensions unknown)`);
    return tokens;
  }

  /**
   * Extract image dimensions from binary data
   * Supports PNG, JPEG, GIF, WebP
   */
  private extractImageDimensions(data: Uint8Array, mimeType: string): { width: number; height: number } | null {
    try {
      const buffer = Buffer.from(data);

      // PNG: dimensions at offset 16-24 (big-endian)
      if (mimeType === 'image/png') {
        if (buffer.length >= 24 && buffer.toString('hex', 0, 8) === '89504e470d0a1a0a') {
          const width = buffer.readUInt32BE(16);
          const height = buffer.readUInt32BE(20);
          return { width, height };
        }
      }

      // JPEG: parse SOF markers
      if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
        let offset = 2; // Skip SOI marker
        while (offset < buffer.length - 8) {
          if (buffer[offset] !== 0xff) {
            offset++;
            continue;
          }
          const marker = buffer[offset + 1];
          // SOF0, SOF1, SOF2, SOF3, SOF5, SOF6, SOF7, SOF9, SOF10, SOF11, SOF13, SOF14, SOF15
          if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
              (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
            const height = buffer.readUInt16BE(offset + 5);
            const width = buffer.readUInt16BE(offset + 7);
            return { width, height };
          }
          // Skip segment
          const segmentLength = buffer.readUInt16BE(offset + 2);
          offset += 2 + segmentLength;
        }
      }

      // GIF: dimensions at offset 6-10 (little-endian)
      if (mimeType === 'image/gif') {
        const sig = buffer.toString('ascii', 0, 6);
        if (buffer.length >= 10 && (sig === 'GIF87a' || sig === 'GIF89a')) {
          const width = buffer.readUInt16LE(6);
          const height = buffer.readUInt16LE(8);
          return { width, height };
        }
      }

      // WebP: VP8 or VP8L chunk
      if (mimeType === 'image/webp') {
        if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
          // Try VP8 (lossy) - simplified
          const vp8Index = buffer.indexOf(Buffer.from('VP8 '), 12);
          if (vp8Index !== -1 && buffer.length >= vp8Index + 14) {
            // VP8 dimensions in bitstream (simplified extraction)
            const width = buffer.readUInt16LE(vp8Index + 10) & 0x3fff;
            const height = buffer.readUInt16LE(vp8Index + 8) & 0x3fff;
            if (width > 0 && height > 0) return { width, height };
          }
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(`  Failed to extract image dimensions: ${error}`);
    }
    return null;
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
  private loadDefaultConfig(): GatewayConfig {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');

    // Try to get config from first provider
    const providers = this.configManager.getProviders();
    let baseURL = config.get<string>('serverUrl', 'http://localhost:8000');
    let apiKey = config.get<string>('apiKey', '');

    if (providers.length > 0) {
      baseURL = providers[0].baseURL;
      apiKey = providers[0].apiKey ?? '';
    }

    const cfg: GatewayConfig = {
      serverUrl: baseURL,
      apiKey: apiKey,
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

  /**
   * Reload configuration
   */
  private reloadConfig(): void {
    this.gatewayConfig = this.loadDefaultConfig();
    this.defaultClient.updateConfig(this.gatewayConfig);
    // Clear client cache to force recreation with new config
    this.clients.clear();
    // Update cached debug settings
    this.updateDebugSettings();
    this.outputChannel.appendLine('Configuration reloaded');
  }
}
