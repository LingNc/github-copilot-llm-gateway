import * as vscode from 'vscode';
import { VLLMClient } from './client';
import { VLLMConfig } from './types';

/**
 * Language model provider for vLLM server
 */
export class VLLMProvider implements vscode.LanguageModelChatProvider {
  private client: VLLMClient;
  private config: VLLMConfig;
  private outputChannel: vscode.OutputChannel;
  // Store tool schemas for the current request to fill missing required properties
  private currentToolSchemas: Map<string, any> = new Map();
  // Track if we've shown the welcome notification this session
  private hasShownWelcomeNotification = false;

  constructor(private context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot LLM Gateway');
    this.config = this.loadConfig();
    this.client = new VLLMClient(this.config);

    // Watch for configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
        if (e.affectsConfiguration('github.copilot.llm-gateway')) {
          this.outputChannel.appendLine('Configuration changed, reloading...');
          this.reloadConfig();
        }
      })
    );
  }

  // Helper method: convertMessages (kept for potential future use)
  private convertMessages(messages: readonly vscode.LanguageModelChatMessage[]): any[] {
    const openAIMessages: any[] = [];
    for (const msg of messages) {
      let role: string;
      if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        role = 'user';
      } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
        role = 'assistant';
      } else {
        role = 'user';
      }

      const toolResults: any[] = [];
      let textContent = '';
      let toolCalls: any[] = [];

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          toolResults.push({
            tool_call_id: part.callId,
            role: 'tool',
            content: typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content),
          });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        }
      }

      if (toolCalls.length > 0) {
        openAIMessages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls,
        });
      } else if (toolResults.length > 0) {
        for (const toolResult of toolResults) {
          openAIMessages.push(toolResult);
        }
      } else if (textContent) {
        openAIMessages.push({
          role,
          content: textContent,
        });
      }
    }

    return openAIMessages;
  }

  // Helper method: buildRequestOptions
  private buildRequestOptions(
    model: vscode.LanguageModelChatInformation,
    openAIMessages: any[],
    estimatedInputTokens: number
  ): any {
    const modelMaxContext = this.config.defaultMaxTokens || 32768;
    const bufferTokens = 128;
    let safeMaxOutputTokens = Math.min(
      this.config.defaultMaxOutputTokens || 2048,
      Math.floor(modelMaxContext - estimatedInputTokens - bufferTokens)
    );
    if (safeMaxOutputTokens < 64) {
      safeMaxOutputTokens = Math.max(64, Math.floor((this.config.defaultMaxOutputTokens || 2048) / 2));
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

  // Helper method: addTooling
  private addTooling(
    requestOptions: any,
    options: vscode.ProvideLanguageModelChatResponseOptions
  ): void {
    if (this.config.enableToolCalling && options.tools && options.tools.length > 0) {
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

      requestOptions.parallel_tool_calls = this.config.parallelToolCalling;
      this.outputChannel.appendLine(`Sending ${requestOptions.tools.length} tools to model (parallel: ${this.config.parallelToolCalling})`);
    }
  }

  /**
   * Get default value for a JSON schema type
   */
  private getDefaultForType(schema: any): any {
    if (!schema || !schema.type) {
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
   * Fill in missing required properties with default values based on the tool schema
   */
  private fillMissingRequiredProperties(args: any, toolName: string, toolSchema: any): any {
    if (!toolSchema || !toolSchema.required || !Array.isArray(toolSchema.required)) {
      return args;
    }

    const properties = toolSchema.properties || {};
    const filledArgs = { ...args };
    const filledProperties: string[] = [];

    for (const requiredProp of toolSchema.required) {
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
   * Truncate messages to fit within a token limit.
   * Strategy: Keep the first message (usually system prompt) and the most recent messages.
   * Remove older messages from the middle of the conversation.
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
   * Attempt to repair truncated or malformed JSON arguments
   */
  private tryRepairJson(jsonStr: string): any | null {
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

    // Fix: missing closing braces/brackets
    const openBraces = (repaired.match(/{/g) || []).length;
    const closeBraces = (repaired.match(/}/g) || []).length;
    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/]/g) || []).length;

    // Add missing closing brackets
    for (let i = 0; i < openBrackets - closeBrackets; i++) {
      repaired += ']';
    }
    // Add missing closing braces
    for (let i = 0; i < openBraces - closeBraces; i++) {
      repaired += '}';
    }

    // Fix: trailing comma before closing brace/bracket
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');

    // Fix: truncated string value - close the string
    if ((repaired.match(/"/g) || []).length % 2 !== 0) {
      // Odd number of quotes - try to close the last string
      repaired += '"';
      // Re-add closing braces if needed
      const newOpenBraces = (repaired.match(/{/g) || []).length;
      const newCloseBraces = (repaired.match(/}/g) || []).length;
      for (let i = 0; i < newOpenBraces - newCloseBraces; i++) {
        repaired += '}';
      }
    }

    try {
      return JSON.parse(repaired);
    } catch {
      this.outputChannel.appendLine(`JSON repair failed. Original: ${jsonStr}`);
      this.outputChannel.appendLine(`Repaired attempt: ${repaired}`);
      return null;
    }
  }

  // Helper method: streamChatCompletion (updated for new client interface)
  private async streamChatCompletion(
    requestOptions: any,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.outputChannel.appendLine(`Streaming chat completion...`);
    let totalContent = '';
    let totalToolCalls = 0;

    for await (const chunk of this.client.streamChatCompletion(requestOptions, token)) {
      if (token.isCancellationRequested) {
        break;
      }

      // Report text content immediately
      if (chunk.content) {
        totalContent += chunk.content;
        progress.report(new vscode.LanguageModelTextPart(chunk.content));
      }

      // Process finished tool calls (fully accumulated by client)
      if (chunk.finished_tool_calls && chunk.finished_tool_calls.length > 0) {
        for (const toolCall of chunk.finished_tool_calls) {
          totalToolCalls++;
          this.outputChannel.appendLine(`Tool call received: id=${toolCall.id}, name=${toolCall.name}`);
          this.outputChannel.appendLine(`  Raw arguments: ${toolCall.arguments.substring(0, 500)}${toolCall.arguments.length > 500 ? '...' : ''}`);

          // Parse arguments with repair capability
          let args = this.tryRepairJson(toolCall.arguments);

          if (args === null) {
            this.outputChannel.appendLine(`ERROR: Failed to parse tool call arguments for ${toolCall.name}`);
            this.outputChannel.appendLine(`  Full arguments: ${toolCall.arguments}`);
            args = {}; // Fallback to empty args
          }

          progress.report(new vscode.LanguageModelToolCallPart(
            toolCall.id,
            toolCall.name,
            args
          ));
        }
      }
    }

    this.outputChannel.appendLine(`Completed chat request, received ${totalContent.length} characters, ${totalToolCalls} tool calls`);
  }

  /**
   * Provide language model information - fetches available models from vLLM server
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean; },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    try {
      this.outputChannel.appendLine('Fetching models from vLLM server...');
      const response = await this.client.fetchModels();

      const models = response.data.map((model) => {
        const modelInfo: vscode.LanguageModelChatInformation = {
          id: model.id,
          name: model.id,
          family: 'vllm-custom',
          maxInputTokens: this.config.defaultMaxTokens,
          maxOutputTokens: this.config.defaultMaxOutputTokens,
          version: '1.0.0',
          capabilities: {
            toolCalling: this.config.enableToolCalling
          },
        };

        return modelInfo;
      });

      this.outputChannel.appendLine(`Found ${models.length} models: ${models.map(m => m.id).join(', ')}`);
      return models;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`ERROR: Failed to fetch models: ${errorMessage}`); if (!options.silent) {
        vscode.window.showErrorMessage(
          `GitHub Copilot LLM Gateway: Failed to fetch models. ${errorMessage}`,
          'Open Settings'
        ).then((selection: string | undefined) => {
          if (selection === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot.llm-gateway');
          }
        });
      }

      return [];
    }
  }

  /**
   * Provide language model chat response - streams responses from vLLM server
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

    // Show welcome notification (once per session)
    this.showWelcomeNotification(model.id);

    // Convert VS Code messages to OpenAI format
    const openAIMessages: any[] = [];

    for (const msg of messages) {
      // Determine the role
      let role: string;
      if (msg.role === vscode.LanguageModelChatMessageRole.User) {
        role = 'user';
      } else if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
        role = 'assistant';
      } else {
        // Default to user for any other role types
        role = 'user';
      }

      // Check if this message contains tool results
      const toolResults: any[] = [];
      let textContent = '';
      let toolCalls: any[] = [];

      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          // Regular text content
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          // This is a LanguageModelToolResultPart - tool execution result
          this.outputChannel.appendLine(`  Found tool result: callId=${part.callId}`);
          toolResults.push({
            tool_call_id: part.callId,
            role: 'tool',
            content: typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content),
          });
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          // This is a LanguageModelToolCallPart - tool invocation from assistant
          this.outputChannel.appendLine(`  Found tool call: callId=${part.callId}, name=${part.name}`);
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        } else {
          // Fallback: try duck-typing for older VS Code versions or edge cases
          const anyPart = part as any;
          if ('callId' in anyPart && 'content' in anyPart && !('name' in anyPart)) {
            // Looks like a tool result
            this.outputChannel.appendLine(`  Found tool result (duck-typed): callId=${anyPart.callId}`);
            toolResults.push({
              tool_call_id: anyPart.callId,
              role: 'tool',
              content: typeof anyPart.content === 'string'
                ? anyPart.content
                : JSON.stringify(anyPart.content),
            });
          } else if ('callId' in anyPart && 'name' in anyPart && 'input' in anyPart) {
            // Looks like a tool call
            this.outputChannel.appendLine(`  Found tool call (duck-typed): callId=${anyPart.callId}, name=${anyPart.name}`);
            toolCalls.push({
              id: anyPart.callId,
              type: 'function',
              function: {
                name: anyPart.name,
                arguments: JSON.stringify(anyPart.input),
              },
            });
          }
        }
      }

      // Add assistant message with tool calls if present
      if (toolCalls.length > 0) {
        openAIMessages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls,
        });
      } else if (toolResults.length > 0) {
        // Add each tool result as a separate message
        for (const toolResult of toolResults) {
          openAIMessages.push(toolResult);
        }
      } else if (textContent) {
        // Regular message with text content
        openAIMessages.push({
          role,
          content: textContent,
        });
      }
    }

    this.outputChannel.appendLine(`Converted to ${openAIMessages.length} OpenAI messages`);

    // Log message structure for debugging
    for (let i = 0; i < openAIMessages.length; i++) {
      const msg = openAIMessages[i];
      this.outputChannel.appendLine(`  Message ${i + 1}: role=${msg.role}, ` +
        `hasContent=${!!msg.content}, hasToolCalls=${!!msg.tool_calls}, ` +
        `toolCallId=${msg.tool_call_id || 'none'}`);
    }

    // Estimate input tokens and truncate if necessary
    const modelMaxContext = this.config.defaultMaxTokens || 32768;
    const desiredOutputTokens = Math.min(this.config.defaultMaxOutputTokens || 2048, Math.floor(modelMaxContext / 2));

    // Estimate tokens for tools/functions schema (reserve space for this)
    const toolsTokenEstimate = options.tools
      ? Math.ceil(JSON.stringify(options.tools).length / 4 * 1.2) // 20% buffer
      : 0;

    const maxInputTokens = modelMaxContext - desiredOutputTokens - toolsTokenEstimate - 256; // 256 buffer

    // Truncate messages if they exceed the context limit
    const truncatedMessages = this.truncateMessagesToFit(openAIMessages, maxInputTokens);
    if (truncatedMessages.length < openAIMessages.length) {
      this.outputChannel.appendLine(`WARNING: Truncated conversation from ${openAIMessages.length} to ${truncatedMessages.length} messages to fit context limit`);
    }

    // Create a single text blob of the input messages for a rough token estimate
    // Include tool_calls in the estimate as they add significant tokens
    const inputText = truncatedMessages
      .map((m) => {
        let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        if (m.tool_calls) {
          text += JSON.stringify(m.tool_calls);
        }
        return text;
      })
      .join('\n');

    // Estimate tokens for tools/functions schema (adds significant overhead)
    const toolsOverhead = options.tools
      ? Math.ceil(JSON.stringify(options.tools).length / 4)
      : 0;

    const estimatedInputTokens = await this.provideTokenCount(model, inputText, token);
    const totalEstimatedTokens = estimatedInputTokens + toolsOverhead;

    // Be conservative: use 20% buffer on top of estimate to account for tokenizer differences
    const conservativeInputEstimate = Math.ceil(totalEstimatedTokens * 1.2);
    const bufferTokens = 256; // leave room for system tokens and safety

    let safeMaxOutputTokens = Math.min(
      this.config.defaultMaxOutputTokens || 2048,
      Math.floor(modelMaxContext - conservativeInputEstimate - bufferTokens)
    );

    // Ensure a reasonable minimum
    if (safeMaxOutputTokens < 64) {
      safeMaxOutputTokens = 64;
    }

    this.outputChannel.appendLine(
      `Token estimate: input=${estimatedInputTokens}, tools=${toolsOverhead}, conservative=${conservativeInputEstimate}, model_context=${modelMaxContext}, chosen_max_tokens=${safeMaxOutputTokens}`
    );

    // Use lower temperature when tools are present for more consistent tool call formatting
    const hasTools = this.config.enableToolCalling && options.tools && options.tools.length > 0;
    const temperature = hasTools ? (this.config.agentTemperature ?? 0.0) : 0.7;

    const requestOptions: any = {
      model: model.id,
      messages: truncatedMessages,
      max_tokens: safeMaxOutputTokens,
      temperature,
    };

    // Add tools to request if enabled
    if (hasTools) {
      // Clear and repopulate tool schemas for this request
      this.currentToolSchemas.clear();

      requestOptions.tools = options.tools.map((tool) => {
        // Log each tool's schema for debugging
        this.outputChannel.appendLine(`Tool: ${tool.name}`);
        this.outputChannel.appendLine(`  Description: ${tool.description?.substring(0, 100) || 'none'}...`);

        // Store schema for later use when processing tool calls
        const schema = tool.inputSchema as any;
        this.currentToolSchemas.set(tool.name, schema);

        if (schema?.required && Array.isArray(schema.required)) {
          this.outputChannel.appendLine(`  Required properties: ${schema.required.join(', ')}`);
        }

        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        };
      });

      if (options.toolMode !== undefined) {
        requestOptions.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
      }

      // Set parallel tool calling flag
      requestOptions.parallel_tool_calls = this.config.parallelToolCalling;

      this.outputChannel.appendLine(`Sending ${requestOptions.tools.length} tools to model (parallel: ${this.config.parallelToolCalling})`);
    }

    // Add model options if provided
    if (options.modelOptions) {
      Object.assign(requestOptions, options.modelOptions);
    }

    // Log the full request for debugging (truncate large content)
    const debugRequest = JSON.stringify(requestOptions, null, 2);
    if (debugRequest.length > 2000) {
      this.outputChannel.appendLine(`Request (truncated): ${debugRequest.substring(0, 2000)}...`);
    } else {
      this.outputChannel.appendLine(`Request: ${debugRequest}`);
    }

    try {
      let totalContent = '';
      let totalToolCalls = 0;

      for await (const chunk of this.client.streamChatCompletion(
        requestOptions,
        token
      )) {
        if (token.isCancellationRequested) {
          break;
        }

        // Report text content if present
        if (chunk.content) {
          totalContent += chunk.content;
          progress.report(new vscode.LanguageModelTextPart(chunk.content));
        }

        // Process finished tool calls (client handles accumulation by index)
        if (chunk.finished_tool_calls && chunk.finished_tool_calls.length > 0) {
          for (const toolCall of chunk.finished_tool_calls) {
            totalToolCalls++;
            this.outputChannel.appendLine(`\n=== TOOL CALL RECEIVED ===`);
            this.outputChannel.appendLine(`  ID: ${toolCall.id}`);
            this.outputChannel.appendLine(`  Name: ${toolCall.name}`);
            this.outputChannel.appendLine(`  Raw arguments: ${toolCall.arguments.substring(0, 1000)}${toolCall.arguments.length > 1000 ? '...' : ''}`);

            // Parse arguments with repair capability
            let args = this.tryRepairJson(toolCall.arguments);

            if (args === null) {
              this.outputChannel.appendLine(`  ERROR: Failed to parse tool call arguments`);
              this.outputChannel.appendLine(`  Full arguments: ${toolCall.arguments}`);
              args = {}; // Fallback to empty args
            } else {
              // Log the parsed arguments keys to help debug missing required properties
              const argKeys = Object.keys(args);
              this.outputChannel.appendLine(`  Parsed argument keys: ${argKeys.length > 0 ? argKeys.join(', ') : '(none)'}`);
            }

            // Fill in missing required properties based on tool schema
            const toolSchema = this.currentToolSchemas.get(toolCall.name);
            if (toolSchema) {
              args = this.fillMissingRequiredProperties(args, toolCall.name, toolSchema);
            }

            this.outputChannel.appendLine(`=== END TOOL CALL ===\n`);

            progress.report(new vscode.LanguageModelToolCallPart(
              toolCall.id,
              toolCall.name,
              args
            ));
          }
        }
      }

      this.outputChannel.appendLine(`Completed chat request, received ${totalContent.length} characters, ${totalToolCalls} tool calls`);

      // Handle empty response with no tool calls - provide helpful error message
      if (totalContent.length === 0 && totalToolCalls === 0) {
        const toolCount = requestOptions.tools?.length || 0;
        const inputTokenCount = await this.provideTokenCount(model, inputText, token);

        this.outputChannel.appendLine(`WARNING: Model returned empty response with no tool calls.`);
        this.outputChannel.appendLine(`  Input tokens estimated: ${inputTokenCount}`);
        this.outputChannel.appendLine(`  Messages in conversation: ${openAIMessages.length}`);
        this.outputChannel.appendLine(`  Tools provided: ${toolCount}`);

        // Build a helpful error message - the model returned nothing
        const errorHint = toolCount > 0
          ? `The model returned an empty response. This typically indicates the model failed to generate valid output with tool calling enabled. Check the vLLM server logs for errors.`
          : `The model returned an empty response. Check the vLLM server logs for details.`;

        this.outputChannel.appendLine(`  Issue: ${errorHint}`);

        // Report a text response to the user explaining the issue
        const errorMessage = `I was unable to generate a response. ${errorHint}\n\n` +
          `Diagnostic info:\n` +
          `- Model: ${model.id}\n` +
          `- Tools provided: ${toolCount}\n` +
          `- Estimated input tokens: ${inputTokenCount}\n` +
          `- Context limit: ${modelMaxContext}\n\n` +
          `Check the "GitHub Copilot LLM Gateway" output panel for detailed logs.`;

        progress.report(new vscode.LanguageModelTextPart(errorMessage));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : '';

      this.outputChannel.appendLine(`ERROR: Chat request failed: ${errorMessage}`);
      if (errorStack) {
        this.outputChannel.appendLine(`Stack trace: ${errorStack}`);
      }

      // Check if this is a tool calling format error
      if (errorMessage.includes('HarmonyError') || errorMessage.includes('unexpected tokens')) {
        this.outputChannel.appendLine('HINT: This appears to be a tool calling format error.');
        this.outputChannel.appendLine('The model may not support function calling properly.');
        this.outputChannel.appendLine('Try: 1) Using a different model, 2) Disabling tool calling in settings, or 3) Checking vLLM server logs');

        vscode.window.showErrorMessage(
          `GitHub Copilot LLM Gateway: Model failed to generate valid tool calls. This model may not support function calling. Check Output panel for details.`,
          'Open Output', 'Disable Tool Calling'
        ).then((selection: string | undefined) => {
          if (selection === 'Open Output') {
            this.outputChannel.show();
          } else if (selection === 'Disable Tool Calling') {
            vscode.workspace.getConfiguration('github.copilot.llm-gateway').update('enableToolCalling', false, vscode.ConfigurationTarget.Global);
          }
        });
      } else {
        vscode.window.showErrorMessage(
          `GitHub Copilot LLM Gateway: Chat request failed. ${errorMessage}`
        );
      }

      throw error;
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
    // This is a rough estimate; for more accuracy, could use tiktoken library
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
   * Load configuration from VS Code settings
   */
  private loadConfig(): VLLMConfig {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');

    const cfg: VLLMConfig = {
      serverUrl: config.get<string>('serverUrl', 'http://localhost:8000'),
      apiKey: config.get<string>('apiKey', ''),
      requestTimeout: config.get<number>('requestTimeout', 60000),
      defaultMaxTokens: config.get<number>('defaultMaxTokens', 32768),
      defaultMaxOutputTokens: config.get<number>('defaultMaxOutputTokens', 4096),
      enableToolCalling: config.get<boolean>('enableToolCalling', true),
      parallelToolCalling: config.get<boolean>('parallelToolCalling', true),
      agentTemperature: config.get<number>('agentTemperature', 0.0),
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
      this.outputChannel.appendLine(`ERROR: Invalid vLLM serverUrl: ${cfg.serverUrl}`);
      throw new Error(`Invalid vLLM serverUrl: ${cfg.serverUrl}`);
    }

    // Validate defaultMaxOutputTokens relative to defaultMaxTokens
    if (cfg.defaultMaxOutputTokens >= cfg.defaultMaxTokens) {
      const adjusted = Math.max(64, cfg.defaultMaxTokens - 256);
      this.outputChannel.appendLine(
        `WARNING: github.copilot.llm-gateway.defaultMaxOutputTokens (${cfg.defaultMaxOutputTokens}) >= defaultMaxTokens (${cfg.defaultMaxTokens}). Adjusting to ${adjusted}.`
      );
      vscode.window.showWarningMessage(
        `GitHub Copilot LLM Gateway: 'defaultMaxOutputTokens' was >= 'defaultMaxTokens'. Adjusted to ${adjusted} to avoid request errors.`
      );
      cfg.defaultMaxOutputTokens = adjusted;
    }

    return cfg;
  }

  /**
   * Reload configuration and update client
   */
  private reloadConfig(): void {
    this.config = this.loadConfig();
    this.client.updateConfig(this.config);
    this.outputChannel.appendLine('Configuration reloaded');
  }
}
