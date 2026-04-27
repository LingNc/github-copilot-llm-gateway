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
import { LogService } from './services/LogService';
import { getGlobalStatusBarItem } from './extension';

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
  private logService: LogService;
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
  private messageDebugLogsEnabled = false;
  // Status bar item for token display (use global to survive reloads)
  private tokenStatusBarItem: vscode.StatusBarItem | undefined = getGlobalStatusBarItem();
  // Current session token statistics
  private currentContextTokens = 0;
  private currentModelMaxTokens = 0;
  private currentTokenDetails?: Array<{ category: string; label: string; percentage: number }>;
  // Token usage view provider
  private tokenUsageProvider?: TokenUsageViewProvider;
  // Cache for reasoning content (DeepSeek API requires passing reasoning_content back in multi-turn conversations)
  // Key: message index or identifier, Value: reasoning content
  private reasoningContentCache = new Map<number, string>();
  private reasoningCacheCounter = 0;

  constructor(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    outputChannel: vscode.OutputChannel,
    logService: LogService
  ) {
    this.configManager = configManager;
    this.outputChannel = outputChannel;
    this.logService = logService;

    // Load default config from first provider or global settings
    this.gatewayConfig = this.loadDefaultConfig();
    this.defaultClient = new GatewayClient(this.gatewayConfig);

    // Initialize status bar item
    this.initializeStatusBar(context);

    // Initialize cached debug setting
    this.updateDebugSettings();
  }

  /**
   * Initialize status bar item for token display
   */
  private initializeStatusBar(context: vscode.ExtensionContext): void {
    // Use global status bar if available
    this.tokenStatusBarItem = getGlobalStatusBarItem();
    if (this.tokenStatusBarItem) {
      this.updateStatusBarVisibility();
    }
  }

  /**
   * Update status bar visibility based on active chat session
   */
  private updateStatusBarVisibility(): void {
    if (!this.tokenStatusBarItem) return;

    // Show status bar when there's an active session (has token data)
    if (this.currentContextTokens > 0) {
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
    // Status bar color: green (<50%), yellow (50-80%), red (>80%)
    // MODIFY HERE: Change these colors as needed
    let color: string | vscode.ThemeColor | undefined;
    if (percentage > 80) {
      // HIGH USAGE: Red color - modify this hex color if needed
      color = '#f44336';
    } else if (percentage >= 50) {
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

    // Progress bar - clamp percentage to 0-100 to avoid negative repeat count
    const clampedPercentage = Math.min(100, Math.max(0, percentage));
    const filled = Math.round((clampedPercentage / 100) * 20);
    const empty = Math.max(0, 20 - filled);
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

    this.logService.logTokens(usedTokens, maxTokens);
    this.logService.debug('Token', `Details: ${details?.map(d => `${d.label}=${d.percentage}%`).join(', ') || 'none'}`);
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

    // Reset token statistics before compacting
    this.currentContextTokens = 0;
    this.currentTokenDetails = undefined;
    this.updateTokenStatusBar(0, this.currentModelMaxTokens, 0, []);

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
   * Dispose provider resources
   */
  public dispose(): void {
    // Don't dispose tokenStatusBarItem - it's global and survives reloads
    this.tokenStatusBarItem = undefined;
  }

  /**
   * Update cached debug settings
   */
  private updateDebugSettings(): void {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
    this.debugLogsEnabled = config.get<boolean>('enableDebugLogs', false);
    this.tokenDebugLogsEnabled = config.get<boolean>('enableTokenDebugLogs', false);
    this.messageDebugLogsEnabled = config.get<boolean>('enableMessageDebugLogs', false);
  }

  /**
   * Find provider and model config by model ID
   * Model ID is in format "providerId/modelId" (e.g., "newapi/kimi-k2.5")
   */
  private findModelAndProvider(modelId: string): { providerId: string; model: ResolvedModel } | undefined {
    // Parse the prefixed model ID: "providerId/modelId"
    const slashIndex = modelId.indexOf('/');
    if (slashIndex === -1) {
      // Backward compatibility: if no prefix, search all providers
      const providers = this.configManager.getProviders();
      for (const provider of providers) {
        const model = this.configManager.getModel(provider.id, modelId);
        if (model) {
          return { providerId: provider.id, model };
        }
      }
      return undefined;
    }

    const providerId = modelId.substring(0, slashIndex);
    const actualModelId = modelId.substring(slashIndex + 1);

    // Get the specific provider
    const model = this.configManager.getModel(providerId, actualModelId);
    if (model) {
      return { providerId, model };
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
   * IMPROVED: Handle content as array (like Copilot does)
   */
  private convertToolResultPart(part: vscode.LanguageModelToolResultPart): Record<string, unknown> {
    // Content can be a single value or an array of parts (LanguageModelTextPart, LanguageModelDataPart, etc.)
    let contentStr: string;

    if (Array.isArray(part.content)) {
      // Content is an array of parts - extract text from each
      const parts: string[] = [];
      for (const item of part.content) {
        if (item instanceof vscode.LanguageModelTextPart) {
          parts.push(item.value);
        } else if (item instanceof vscode.LanguageModelDataPart) {
          // Binary data - just note it was present
          parts.push(`[Data: ${item.mimeType}, ${item.data.length} bytes]`);
        } else if (typeof item === 'string') {
          parts.push(item);
        } else {
          // Unknown part type - stringify
          parts.push(this.safeStringify(item));
        }
      }
      contentStr = parts.join('');
    } else if (typeof part.content === 'string') {
      contentStr = part.content;
    } else {
      contentStr = this.safeStringify(part.content);
    }

    return {
      tool_call_id: part.callId,
      role: 'tool',
      content: contentStr,
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
   * Extract content from a tool result part for token counting
   * Handles both string content and array of parts (like Copilot does)
   */
  private extractToolResultContent(part: vscode.LanguageModelToolResultPart): string {
    if (Array.isArray(part.content)) {
      const parts: string[] = [];
      for (const item of part.content) {
        if (item instanceof vscode.LanguageModelTextPart) {
          parts.push(item.value);
        } else if (item instanceof vscode.LanguageModelDataPart) {
          parts.push(`[Data: ${item.mimeType}, ${item.data.length} bytes]`);
        } else if (typeof item === 'string') {
          parts.push(item);
        } else {
          parts.push(this.safeStringify(item));
        }
      }
      return parts.join('');
    } else if (typeof part.content === 'string') {
      return part.content;
    } else {
      return this.safeStringify(part.content);
    }
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
    let assistantMessageIndex = 0; // Track assistant message index for reasoning cache lookup

    for (const msg of messages) {
      const role = this.mapRole(msg.role);
      const toolResults: Record<string, unknown>[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

      // Debug: log message content types (only when debug enabled)
      if (this.debugLogsEnabled) {
        const contentTypes = msg.content.map((p: unknown) => {
          // @ts-ignore
          if (vscode.LanguageModelThinkingPart && p instanceof vscode.LanguageModelThinkingPart) return 'thinking';
          if (p instanceof vscode.LanguageModelTextPart) return 'text';
          if (p instanceof vscode.LanguageModelDataPart) return 'data';
          if (p instanceof vscode.LanguageModelToolResultPart) return 'tool_result';
          if (p instanceof vscode.LanguageModelToolCallPart) return 'tool_call';
          return 'unknown';
        });
        this.outputChannel.appendLine(`[Message Debug] role=${role}, contentTypes=[${contentTypes.join(', ')}], contentCount=${msg.content.length}`);
      }

      for (let i = 0; i < msg.content.length; i++) {
        const part = msg.content[i];
        const partType = part.constructor.name;

        // Debug: Log all part types to understand what's coming in
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`[Part Debug] Index ${i}: constructor=${partType}, keys=[${Object.keys(part).join(',')}]`);
        }

        // Handle LanguageModelThinkingPart (reasoning content from models like DeepSeek)
        // @ts-ignore - LanguageModelThinkingPart may not be in the types yet
        const hasThinkingPart = !!vscode.LanguageModelThinkingPart;
        // @ts-ignore
        const isThinkingPart = hasThinkingPart && part instanceof vscode.LanguageModelThinkingPart;

        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`[Part Debug] Index ${i}: hasThinkingPart=${hasThinkingPart}, isThinkingPart=${isThinkingPart}`);
        }

        // @ts-ignore - LanguageModelThinkingPart may not be in the types yet
        if (isThinkingPart) {
          // Skip thinking parts - reasoning content is now handled via cache for tool-calling messages
          if (this.debugLogsEnabled) {
            // @ts-ignore
            const thinkingValue = part.value || '';
            this.outputChannel.appendLine(`[Part Debug] Index ${i}: type=LanguageModelThinkingPart, skipped (using cache), length=${thinkingValue.length} chars`);
          }
        } else if (part instanceof vscode.LanguageModelTextPart) {
          // Only show detailed preview when message debug is enabled
          if (this.messageDebugLogsEnabled) {
            const textPreview = part.value.substring(0, 100).replace(/\n/g, '\\n');
            this.outputChannel.appendLine(`[Part Debug] Index ${i}: type=${partType}`);
            this.outputChannel.appendLine(`[Part Debug]   TextPart: length=${part.value.length}, preview="${textPreview}..."`);
          }
          contentParts.push({ type: 'text', text: part.value });
          // Count as messages (this includes regular text and file references)
          messagesTokens += await this.provideTokenCount(model, part.value, token);
        } else if (part instanceof vscode.LanguageModelDataPart) {
          // Handle file data (images and other binary data)
          if (part.mimeType.startsWith('image/')) {
            const base64Data = Buffer.from(part.data).toString('base64');
            const imageUrl = `data:${part.mimeType};base64,${base64Data}`;
            contentParts.push({ type: 'image_url', image_url: { url: imageUrl } });
            if (this.messageDebugLogsEnabled) {
              this.outputChannel.appendLine(`[Part Debug] Index ${i}: type=${partType}`);
              this.outputChannel.appendLine(`[Part Debug]   Added image: ${part.mimeType}, ${part.data.length} bytes`);
            }
            // Calculate image tokens based on dimensions
            const estimatedImageTokens = this.calculateImageTokens(part.data, part.mimeType);
            filesTokens += estimatedImageTokens;
            if (this.messageDebugLogsEnabled) {
              this.outputChannel.appendLine(`[Part Debug]   Estimated image tokens: ${estimatedImageTokens}`);
            }
          } else {
            // Handle other file types as text content
            const text = Buffer.from(part.data).toString('utf-8');
            contentParts.push({ type: 'text', text });
            if (this.messageDebugLogsEnabled) {
              this.outputChannel.appendLine(`[Part Debug] Index ${i}: type=${partType}`);
              this.outputChannel.appendLine(`[Part Debug]   Added file: ${part.mimeType}, ${part.data.length} bytes`);
            }
            // Count file content tokens
            const fileTokens = await this.provideTokenCount(model, text, token);
            filesTokens += fileTokens;
          }
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          const toolResult = this.convertToolResultPart(part);
          toolResults.push(toolResult);

          // IMPROVED: Calculate tokens from the actual tool result content (handles arrays correctly)
          const toolResultText = toolResult.content as string;
          const textLength = toolResultText.length;

          // DEBUG: Log tool result size (only when message debug enabled)
          if (this.messageDebugLogsEnabled) {
            const preview = textLength > 200 ? toolResultText.substring(0, 200).replace(/\n/g, '\\n') : toolResultText.replace(/\n/g, '\\n');
            this.outputChannel.appendLine(`[Part Debug] Index ${i}: type=${partType}`);
            this.outputChannel.appendLine(`[Tool Result Debug] callId=${part.callId}, length=${textLength}, preview="${preview}..."`);
          }

          // Check if content is base64 image data (from view_image tool)
          if (toolResultText.startsWith('data:image/')) {
            // Extract mime type and base64 data
            const match = toolResultText.match(/^data:image\/([^;]+);base64,(.+)$/);
            if (match) {
              const mimeType = `image/${match[1]}`;
              const base64Data = match[2];
              const byteLength = Math.ceil(base64Data.length * 0.75); // Approximate byte length
              const estimatedTokens = this.calculateImageTokens(new Uint8Array(byteLength), mimeType);
              toolResultsTokens += estimatedTokens;
              this.logService.debug('Token', `Tool result image: ${mimeType}, ~${estimatedTokens} tokens`);
              if (this.messageDebugLogsEnabled) {
                this.outputChannel.appendLine(`[Tool Result Debug] Detected image data: ${mimeType}, base64 length=${base64Data.length}, estimated tokens=${estimatedTokens}`);
              }
            } else {
              const tokens = await this.provideTokenCount(model, toolResultText, token);
              toolResultsTokens += tokens;
              if (this.messageDebugLogsEnabled) {
                this.outputChannel.appendLine(`[Tool Result Debug] Non-standard image format, counted as text: ${tokens} tokens`);
              }
            }
          } else {
            const tokens = await this.provideTokenCount(model, toolResultText, token);
            toolResultsTokens += tokens;
            if (this.messageDebugLogsEnabled) {
              this.outputChannel.appendLine(`[Tool Result Debug] Counted as text: ${tokens} tokens`);
            }
          }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          if (this.messageDebugLogsEnabled) {
            this.outputChannel.appendLine(`[Part Debug] Index ${i}: type=${partType}`);
            this.outputChannel.appendLine(`[Part Debug]   ToolCall: ${part.name}, callId=${part.callId}`);
          }
          toolCalls.push(this.convertToolCallPart(part));
        } else {
          // Fallback for unknown part types that failed instanceof check
          const anyPart = part as Record<string, unknown>;
          if (this.messageDebugLogsEnabled) {
            this.outputChannel.appendLine(`[Part Debug] Index ${i}: type=${partType}`);
            this.outputChannel.appendLine(`[Part Debug] Unknown part type: ${part.constructor.name}, keys: [${Object.keys(anyPart).join(', ')}]`);
          }

          // Try to extract text content if it has a 'value' property (likely TextPart)
          if ('value' in anyPart && typeof anyPart.value === 'string') {
            if (this.debugLogsEnabled) {
              this.outputChannel.appendLine(`[Part Debug]   Treating as text (has value property): length=${anyPart.value.length}`);
            }
            contentParts.push({ type: 'text', text: anyPart.value });
            messagesTokens += await this.provideTokenCount(model, anyPart.value, token);
          } else if ('content' in anyPart) {
            // Might be a tool result that failed instanceof
            // IMPROVED: Handle array content like convertToolResultPart does
            let contentStr: string;
            const content = anyPart.content;

            if (Array.isArray(content)) {
              // Content is array of parts - extract text and handle images
              const parts: string[] = [];
              for (const item of content) {
                if (item instanceof vscode.LanguageModelTextPart ||
                    (typeof item === 'object' && 'value' in item && typeof item.value === 'string')) {
                  // TextPart or duck-typed text part
                  parts.push(item.value || String(item));
                } else if (item instanceof vscode.LanguageModelDataPart ||
                           (typeof item === 'object' && 'mimeType' in item && 'data' in item)) {
                  // DataPart or duck-typed data part (likely image)
                  const mimeType = item.mimeType || 'application/octet-stream';
                  const dataLength = item.data?.length || 0;
                  parts.push(`[Data: ${mimeType}, ${dataLength} bytes]`);
                } else if (typeof item === 'string') {
                  parts.push(item);
                } else {
                  parts.push(this.safeStringify(item));
                }
              }
              contentStr = parts.join('');
            } else if (typeof content === 'string') {
              contentStr = content;
            } else {
              contentStr = this.safeStringify(content);
            }

            if ('callId' in anyPart && !('name' in anyPart)) {
              if (this.debugLogsEnabled) {
                this.outputChannel.appendLine(`[Part Debug]   Treating as tool result (duck-typed): callId=${anyPart.callId}, contentLength=${contentStr.length}`);
              }
              toolResults.push({
                tool_call_id: anyPart.callId,
                role: 'tool',
                content: contentStr,
              });
              toolResultsTokens += await this.provideTokenCount(model, contentStr, token);
            } else {
              if (this.debugLogsEnabled) {
                this.outputChannel.appendLine(`[Part Debug]   Treating as text from content property`);
              }
              contentParts.push({ type: 'text', text: contentStr });
              messagesTokens += await this.provideTokenCount(model, contentStr, token);
            }
          }
        }
      }

      if (toolCalls.length > 0) {
        // For assistant messages with tool calls, retrieve reasoning from cache
        let reasoningContent = '';
        const cachedReasoning = this.reasoningContentCache.get(assistantMessageIndex);
        if (cachedReasoning) {
          reasoningContent = cachedReasoning;
          if (this.debugLogsEnabled) {
            this.outputChannel.appendLine(`[Reasoning Cache] Retrieved reasoning for assistant ${assistantMessageIndex}: ${cachedReasoning.length} chars`);
          }
        }
        assistantMessageIndex++;

        // For tool calls, we need to extract text content separately
        const textContent = contentParts
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join('');
        const assistantMessage: Record<string, unknown> = {
          role: 'assistant',
          content: textContent || '',
          tool_calls: toolCalls,
          // DeepSeek V4 requires reasoning_content for ALL assistant messages when thinking is enabled
          reasoning_content: reasoningContent || ''
        };
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`[Reasoning Debug] Added reasoning_content to tool-calling message: ${reasoningContent?.length || 0} chars`);
        }
        openAIMessages.push(assistantMessage);
      } else if (toolResults.length > 0) {
        openAIMessages.push(...toolResults);
      } else if (contentParts.length > 0) {
        // Regular assistant message without tool calls
        // DeepSeek V4 requires reasoning_content for ALL assistant messages when thinking is enabled
        if (role === 'assistant') {
          assistantMessageIndex++;
        }

        // Retrieve reasoning content for this assistant message (if available)
        let reasoningContent = '';
        const cachedReasoning = this.reasoningContentCache.get(assistantMessageIndex - 1);
        if (cachedReasoning) {
          reasoningContent = cachedReasoning;
        }

        if (contentParts.some(p => p.type === 'image_url')) {
          const assistantMessage: Record<string, unknown> = {
            role,
            content: contentParts,
            reasoning_content: reasoningContent || ''
          };
          openAIMessages.push(assistantMessage);
        } else {
          const textContent = contentParts.map(p => p.text).join('');
          const assistantMessage: Record<string, unknown> = {
            role,
            content: textContent || '',
            reasoning_content: reasoningContent || ''
          };
          if (this.debugLogsEnabled) {
            this.outputChannel.appendLine(`[Reasoning Debug] Added reasoning_content to regular message: ${reasoningContent?.length || 0} chars`);
          }
          openAIMessages.push(assistantMessage);
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

    // Send upstream model ID without provider prefix (e.g. "kimi-k2.5"),
    // while model.id in VS Code can be prefixed (e.g. "newapi/kimi-k2.5").
    const requestModelId = resolvedModel?.id ?? model.id;

    const requestOptions: any = {
      model: requestModelId,
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
      this.logService.logTools(
        'Tool',
        options.tools.map(t => ({ name: t.name, description: t.description })),
        this.gatewayConfig.parallelToolCalling
      );
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
    this.logService.info('Request', 'Streaming chat completion...');
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

    this.logService.info('Response', `Completed: ${totalContent.length} chars, ${totalToolCalls} tool calls`);
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

    this.logService.info('Config', `Fetching models (mode: ${configMode}, style: ${providerNameStyle})...`);

    const allModels: vscode.LanguageModelChatInformation[] = [];
    const providers = this.configManager.getProviders();

    this.logService.info('Config', `Found ${providers.length} provider(s) in config`);
    for (const provider of providers) {
      const modelCount = Object.keys(provider.models || {}).length;
      this.logService.debug('Config', `  Provider "${provider.id}": ${modelCount} model(s), baseURL=${provider.baseURL}`);
    }

    // Fetch models from all providers in parallel for better performance
    const fetchPromises = providers.map(async (provider) => {
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
        this.logService.debug('Config', `  Provider "${provider.id}" returned: [${providerModels.map(m => m.id).join(', ')}]`);
        return providerModels;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logService.warning('Config', `Failed to fetch from "${provider.id}": ${message}`);
        return [];
      }
    });

    const results = await Promise.all(fetchPromises);
    for (const providerModels of results) {
      allModels.push(...providerModels);
    }

    this.logService.info('Config', `Found ${allModels.length} model(s) from all providers`);

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

      // Get VS Code language
      const vscodeLang = vscode.env.language;
      const isZh = vscodeLang.startsWith('zh');

      // Filter descriptions based on available levels and language
      const levelDescriptions: Record<string, string> = {
        low: isZh ? '响应更快，推理较少' : 'Faster responses with less reasoning',
        medium: isZh ? '平衡推理与速度' : 'Balanced reasoning and speed',
        high: isZh ? '最大推理深度' : 'Maximum reasoning depth',
      };

      // Map effort levels to localized labels and descriptions
      const levelLabels: Record<string, string> = {
        low: 'Low',
        medium: 'Medium',
        high: 'High',
      };

      return {
        properties: {
          reasoningEffort: {
            type: 'string',
            title: isZh ? '思考等级' : 'Thinking Effort',
            enum: effortLevels,
            enumItemLabels: effortLevels.map(level => levelLabels[level] || level.charAt(0).toUpperCase() + level.slice(1)),
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

      // Use provider-prefixed model ID to avoid conflicts between providers
      const prefixedModelId = `${providerId}/${model.id}`;

      return {
        id: prefixedModelId,
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

      // Use provider-prefixed model ID to avoid conflicts between providers
      const prefixedModelId = `${providerId}/${model.id}`;

      modelMap.set(prefixedModelId, {
        id: prefixedModelId,
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
        // Parse API model capabilities from extended fields
        const hasVision = apiModel.supports_image_in === true;
        const hasVideo = apiModel.supports_video_in === true;
        const hasReasoning = apiModel.supports_reasoning === true;
        // Use context_length from API if available, otherwise use default
        const contextLength = apiModel.context_length || this.gatewayConfig.defaultMaxTokens;
        // Use display_name from API if available
        const displayName = apiModel.display_name || apiModel.id;

        // Use provider-prefixed model ID to avoid conflicts between providers
        const prefixedModelId = `${providerId}/${apiModel.id}`;

        this.outputChannel.appendLine(
          `    API model: ${apiModel.id} -> ${prefixedModelId} (vision=${hasVision}, reasoning=${hasReasoning}, context=${contextLength})`
        );

        modelMap.set(prefixedModelId, {
          id: prefixedModelId,
          name: formatName(displayName),
          family: providerId,
          maxInputTokens: contextLength,
          maxOutputTokens: this.gatewayConfig.defaultMaxOutputTokens,
          version: '',
          capabilities: {
            toolCalling: this.gatewayConfig.enableToolCalling,
            imageInput: hasVision,
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

        // Use provider-prefixed model ID to avoid conflicts between providers
        const prefixedModelId = `${providerId}/${apiModel.id}`;

        // API priority: use API model id, but config values if available
        result.push({
          id: prefixedModelId,
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
   * IMPROVED: More strict checking to avoid misclassification
   */
  private processPartDuckTyped(
    part: unknown,
    toolResults: Record<string, unknown>[],
    toolCalls: Record<string, unknown>[],
    contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }>
  ): void {
    const anyPart = part as Record<string, unknown>;

    // Log what we're trying to identify
    const partKeys = Object.keys(anyPart).join(', ');
    this.outputChannel.appendLine(`  [DuckType Debug] Unknown part type, keys: [${partKeys}]`);

    // STRICT: Tool result must have callId AND content AND role should indicate it's a tool result
    // Also check that content is a reasonable type (string or object)
    if ('callId' in anyPart && 'content' in anyPart && !('name' in anyPart)) {
      // Additional check: tool results should have content that looks like tool output
      // If content looks like a regular message (starts with common text patterns), treat as text
      const content = anyPart.content;

      // IMPROVED: Handle array content properly (like Copilot does)
      let contentStr: string;
      if (Array.isArray(content)) {
        // Content is array of parts - extract text and handle images/data properly
        const parts: string[] = [];
        for (const item of content) {
          if (typeof item === 'string') {
            parts.push(item);
          } else if (item && typeof item === 'object') {
            if ('value' in item && typeof item.value === 'string') {
              // TextPart
              parts.push(item.value);
            } else if ('mimeType' in item && 'data' in item) {
              // DataPart (image or binary data) - don't include full data, just metadata
              const mimeType = String(item.mimeType || 'application/octet-stream');
              const dataLength = item.data?.length || 0;
              parts.push(`[Data: ${mimeType}, ${dataLength} bytes]`);
            } else {
              // Other object types
              parts.push(this.safeStringify(item));
            }
          } else {
            parts.push(String(item));
          }
        }
        contentStr = parts.join('');
      } else if (typeof content === 'string') {
        contentStr = content;
      } else {
        contentStr = this.safeStringify(content);
      }

      // Heuristic: If content is very long and doesn't look like tool output, might be text
      // Tool results from view_image typically start with specific patterns
      if (typeof content === 'string' &&
          (content.startsWith('data:image/') ||
           content.startsWith('{') ||
           content.startsWith('[') ||
           content.length < 10000)) {
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`  Found tool result (duck-typed): callId=${anyPart.callId}, contentLength=${contentStr.length}`);
        }
        toolResults.push({
          tool_call_id: anyPart.callId,
          role: 'tool',
          content: contentStr,
        });
      } else if (Array.isArray(content)) {
        // Array content - likely tool result with mixed text/data
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`  Found tool result (duck-typed, array): callId=${anyPart.callId}, contentLength=${contentStr.length}`);
        }
        toolResults.push({
          tool_call_id: anyPart.callId,
          role: 'tool',
          content: contentStr,
        });
      } else {
        // If it doesn't look like a tool result, log and treat as unknown
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`  [DuckType Warning] Part with callId looks like text, not tool result. Adding as text.`);
        }
        contentParts.push({ type: 'text', text: contentStr });
      }
    } else if ('callId' in anyPart && 'name' in anyPart && 'input' in anyPart) {
      // Tool call is more reliable to identify
      if (this.debugLogsEnabled) {
        this.outputChannel.appendLine(`  Found tool call (duck-typed): callId=${anyPart.callId}, name=${anyPart.name}`);
      }
      toolCalls.push({
        id: anyPart.callId,
        type: 'function',
        function: { name: anyPart.name, arguments: this.safeStringify(anyPart.input) },
      });
    } else if ('value' in anyPart && typeof anyPart.value === 'string') {
      // Likely a text part that failed instanceof check
      if (this.debugLogsEnabled) {
        this.outputChannel.appendLine(`  Found text part (duck-typed): length=${anyPart.value.length}`);
      }
      contentParts.push({ type: 'text', text: anyPart.value });
    } else {
      // Truly unknown - log for debugging
      if (this.debugLogsEnabled) {
        this.outputChannel.appendLine(`  [DuckType Unknown] Part could not be classified. Keys: [${partKeys}]`);
      }
      // Try to extract any string content as fallback
      if ('content' in anyPart) {
        const content = anyPart.content;
        let fallback: string;
        if (Array.isArray(content)) {
          // Handle array - extract text parts, summarize data parts
          const parts: string[] = [];
          for (const item of content) {
            if (typeof item === 'string') {
              parts.push(item);
            } else if (item && typeof item === 'object') {
              if ('value' in item && typeof item.value === 'string') {
                parts.push(item.value);
              } else if ('mimeType' in item && 'data' in item) {
                parts.push(`[Data: ${item.mimeType}, ${item.data?.length || 0} bytes]`);
              } else {
                parts.push(this.safeStringify(item));
              }
            } else {
              parts.push(String(item));
            }
          }
          fallback = parts.join('');
        } else if (typeof content === 'string') {
          fallback = content;
        } else {
          fallback = this.safeStringify(content);
        }
        contentParts.push({ type: 'text', text: fallback });
      }
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
    let reasoningContent = ''; // Store reasoning_content for DeepSeek API

    for (const part of msg.content) {
      // Handle LanguageModelThinkingPart (reasoning content from models like DeepSeek)
      // @ts-ignore - LanguageModelThinkingPart may not be in the types yet
      if (vscode.LanguageModelThinkingPart && part instanceof vscode.LanguageModelThinkingPart) {
        // @ts-ignore
        const thinkingValue = part.value || '';
        if (thinkingValue) {
          reasoningContent += thinkingValue;
          if (this.debugLogsEnabled) {
            this.outputChannel.appendLine(`  Found thinking part: length=${thinkingValue.length}`);
          }
        }
      } else if (part instanceof vscode.LanguageModelTextPart) {
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`  Found text part: ${part.value.substring(0, 100)}${part.value.length > 100 ? '...' : ''}`);
        }
        contentParts.push({ type: 'text', text: part.value });
      } else if (part instanceof vscode.LanguageModelDataPart) {
        // Handle image data
        if (part.mimeType.startsWith('image/')) {
          const base64Data = Buffer.from(part.data).toString('base64');
          const imageUrl = `data:${part.mimeType};base64,${base64Data}`;
          contentParts.push({ type: 'image_url', image_url: { url: imageUrl } });
          if (this.debugLogsEnabled) {
            this.outputChannel.appendLine(`  Found image: ${part.mimeType}, ${part.data.length} bytes`);
          }
        } else {
          const text = Buffer.from(part.data).toString('utf-8');
          contentParts.push({ type: 'text', text });
          if (this.debugLogsEnabled) {
            this.outputChannel.appendLine(`  Found data part: ${part.mimeType}, ${part.data.length} bytes`);
          }
        }
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`  Found tool result: callId=${part.callId}`);
        }
        toolResults.push(this.convertToolResultPart(part));
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`  Found tool call: callId=${part.callId}, name=${part.name}`);
        }
        toolCalls.push(this.convertToolCallPart(part));
      } else {
        this.processPartDuckTyped(part, toolResults, toolCalls, contentParts);
      }
    }

    const result: Record<string, unknown>[] = [];
    if (toolCalls.length > 0) {
      const textContent = contentParts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('');
      const assistantMessage: Record<string, unknown> = { role: 'assistant', content: textContent || null, tool_calls: toolCalls };
      // Add reasoning_content for DeepSeek API if present
      if (reasoningContent) {
        assistantMessage.reasoning_content = reasoningContent;
      }
      result.push(assistantMessage);
    } else if (toolResults.length > 0) {
      result.push(...toolResults);
    } else if (contentParts.length > 0 || reasoningContent) {
      // Use array format if there are images
      if (contentParts.some(p => p.type === 'image_url')) {
        const assistantMessage: Record<string, unknown> = { role, content: contentParts };
        if (reasoningContent) {
          assistantMessage.reasoning_content = reasoningContent;
        }
        result.push(assistantMessage);
      } else {
        const textContent = contentParts.map(p => p.text).join('');
        const assistantMessage: Record<string, unknown> = { role, content: textContent || null };
        if (reasoningContent) {
          assistantMessage.reasoning_content = reasoningContent;
        }
        result.push(assistantMessage);
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

    const tools = options.tools.map((tool) => {
      const schema = tool.inputSchema as Record<string, unknown> | undefined;
      this.currentToolSchemas.set(tool.name, schema);

      // Log detailed tool info only in debug mode
      this.logService.debug('Tool', `Tool: ${tool.name}`);
      this.logService.debug('Tool', `  Description: ${tool.description?.substring(0, 100) || 'none'}...`);
      if (schema?.required && Array.isArray(schema.required)) {
        this.logService.debug('Tool', `  Required properties: ${(schema.required as string[]).join(', ')}`);
      }

      return {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      };
    });

    // Log summary in info mode
    this.logService.info('Tool', `Built ${tools.length} tool schemas`);

    return tools;
  }

  /**
   * Process a single tool call from the stream
   */
  private processToolCall(
    toolCall: { id: string; name: string; arguments: string },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    this.logService.info('Tool', `Received: id=${toolCall.id}, name=${toolCall.name}`);
    this.logService.debug('Tool', `  Raw arguments: ${toolCall.arguments.substring(0, 500)}${toolCall.arguments.length > 500 ? '...' : ''}`);

    let args = this.tryRepairJson(toolCall.arguments) as Record<string, unknown> | null;

    if (args === null) {
      this.logService.error('Tool', `Failed to parse tool call arguments for ${toolCall.name}`);
      this.logService.debug('Tool', `  Full arguments: ${toolCall.arguments}`);
      args = {};
    } else {
      const argKeys = Object.keys(args);
      this.logService.debug('Tool', `  Parsed argument keys: ${argKeys.length > 0 ? argKeys.join(', ') : '(none)'}`);
    }

    const toolSchema = this.currentToolSchemas.get(toolCall.name) as Record<string, unknown> | undefined;
    if (toolSchema) {
      args = this.fillMissingRequiredProperties(args, toolCall.name, toolSchema);
    }

    this.logService.debug('Tool', `Completed processing tool call: ${toolCall.name}`);
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

    // Don't reset reasoning cache counter - it should persist across requests
    // to avoid overwriting previous responses' reasoning content
    if (this.debugLogsEnabled) {
      this.outputChannel.appendLine(`[Reasoning Cache] Counter=${this.reasoningCacheCounter}, Cache size: ${this.reasoningContentCache.size}`);
    }

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

    // Log message structure (only in debug mode)
    if (this.debugLogsEnabled) {
      for (let i = 0; i < openAIMessages.length; i++) {
        const msg = openAIMessages[i];
        const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : 'none';
        this.outputChannel.appendLine(`  Message ${i + 1}: role=${msg.role}, hasContent=${!!msg.content}, hasToolCalls=${!!msg.tool_calls}, toolCallId=${toolCallId}`);
      }
    }

    // Calculate token limits (for display only, don't truncate - Copilot Chat manages context)
    const modelMaxContext = resolvedModel?.limit.context ?? this.gatewayConfig.defaultMaxTokens;
    const desiredOutputTokens = Math.min(
      resolvedModel?.limit.output ?? this.gatewayConfig.defaultMaxOutputTokens,
      Math.floor(modelMaxContext / 2)
    );
    const toolsTokenEstimate = options.tools ? await this.provideTokenCount(model, this.safeStringify(options.tools), token) : 0;

    // Build input text for token estimation using full messages (Copilot Chat manages context)
    const inputText = openAIMessages
      .map((m) => {
        let text = typeof m.content === 'string' ? m.content : this.safeStringify(m.content || '');
        if (m.tool_calls) { text += this.safeStringify(m.tool_calls); }
        return text;
      })
      .join('\n');

    const toolsOverhead = options.tools ? await this.provideTokenCount(model, this.safeStringify(options.tools), token) : 0;
    const estimatedInputTokens = await this.provideTokenCount(model, inputText, token) + toolsOverhead;
    const safeMaxOutputTokens = this.calculateSafeMaxOutputTokens(estimatedInputTokens, toolsOverhead, model.id);

    this.logService.info('Token', `Estimate: input=${estimatedInputTokens}, tools=${toolsOverhead}, context=${modelMaxContext}, output=${safeMaxOutputTokens}`);

    // Update token statistics display if enabled
    if (tokenStatisticsEnabled) {
      // Calculate total tokens from categories (not from estimatedInputTokens to avoid double counting)
      // estimatedInputTokens includes all content, but we want to show breakdown by category
      const categorizedTotal = messagesTokens + filesTokens + toolResultsTokens + toolsOverhead;
      const totalTokens = Math.max(estimatedInputTokens, categorizedTotal);

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

    const requestModelId = resolvedModel?.id ?? model.id;

    const requestOptions: Record<string, unknown> = {
      model: requestModelId,
      messages: openAIMessages,
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

    // Log request (only when message debug enabled)
    if (this.messageDebugLogsEnabled) {
      const debugRequest = this.safeStringify(requestOptions);
      this.outputChannel.appendLine(debugRequest.length > 2000 ? `Request (truncated): ${debugRequest.substring(0, 2000)}...` : `Request: ${debugRequest}`);
    }

    // Debug: Log assistant messages with reasoning_content
    if (this.debugLogsEnabled) {
      for (let i = 0; i < openAIMessages.length; i++) {
        const msg = openAIMessages[i];
        if (msg.role === 'assistant') {
          const hasReasoning = 'reasoning_content' in msg;
          const reasoningLen = hasReasoning ? String(msg.reasoning_content).length : 0;
          this.outputChannel.appendLine(`[Request Debug] Assistant ${i}: hasReasoning=${hasReasoning}, reasoningLength=${reasoningLen}, hasToolCalls=${!!msg.tool_calls}`);
        }
      }
    }

    try {
      let totalContent = '';
      let totalToolCalls = 0;
      // Accumulate reasoning content for this response (needed for DeepSeek API multi-turn)
      let accumulatedReasoning = '';
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
            accumulatedReasoning += chunk.thinking;
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
            accumulatedReasoning += chunk.reasoning;
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

      // Store accumulated reasoning content in cache for ALL responses
      // DeepSeek V4 requires reasoning_content for ALL assistant messages when thinking is enabled
      if (accumulatedReasoning) {
        this.reasoningContentCache.set(this.reasoningCacheCounter, accumulatedReasoning);
        if (this.debugLogsEnabled) {
          this.outputChannel.appendLine(`[Reasoning Cache] Stored reasoning for response ${this.reasoningCacheCounter}: ${accumulatedReasoning.length} chars, ${totalToolCalls} tool calls`);
        }
        // Increment counter for next response
        this.reasoningCacheCounter++;
      }

      // Estimate completion tokens from generated content if not provided by API
      // Use ~4 characters per token as a rough estimate
      if (completionTokens === 0 && totalContent.length > 0) {
        completionTokens = Math.ceil(totalContent.length / 4);
        this.outputChannel.appendLine(`Estimated completion tokens from content length: ${completionTokens}`);
      }

      this.logService.info('Response', `Completed: ${totalContent.length} chars, ${totalToolCalls} tool calls`);

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
            // IMPROVED: Include actual tool result content for accurate token counting
            const toolResultContent = this.extractToolResultContent(part);
            parts.push(toolResultContent);
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
