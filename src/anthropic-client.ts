/**
 * HTTP client for Anthropic Messages API
 * Handles streaming and non-streaming requests to Anthropic's API
 */

import { randomBytes } from 'node:crypto';
import {
  AnthropicMessageRequest,
  AnthropicMessageResponse,
  AnthropicStreamEvent,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTool,
  ProviderConfig,
  OpenAIMessage,
  OpenAIChatCompletionChunk,
} from './types';

/**
 * Accumulated tool call during streaming
 */
interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * State for tracking content blocks during streaming
 */
interface StreamState {
  textContent: string;
  toolCalls: Map<number, StreamingToolCall>;
  currentBlockIndex: number | null;
  currentBlockType: 'text' | 'tool_use' | null;
  requestId: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * HTTP client for Anthropic Messages API
 */
export class AnthropicClient {
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /**
   * Update client configuration
   */
  public updateConfig(config: ProviderConfig): void {
    this.config = config;
  }

  /**
   * Fetch available models from Anthropic API
   * Note: Anthropic doesn't have a /models endpoint, so we return models from config
   */
  public async fetchModels(): Promise<{ object: string; data: Array<{ id: string; object: string; created: number; owned_by: string }> }> {
    const models = Object.entries(this.config.models).map(([id, modelConfig]) => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: this.config.name,
    }));

    return {
      object: 'list',
      data: models,
    };
  }

  /**
   * Convert OpenAI format messages to Anthropic format
   */
  public convertMessages(messages: OpenAIMessage[]): { system?: string; messages: AnthropicMessage[] } {
    const anthropicMessages: AnthropicMessage[] = [];
    let system: string | undefined;

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Anthropic separates system message
        system = msg.content || '';
      } else if (msg.role === 'user') {
        anthropicMessages.push({
          role: 'user',
          content: this.convertContentToAnthropic(msg.content),
        });
      } else if (msg.role === 'assistant') {
        const content: AnthropicContentBlock[] = [];

        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }

        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}'),
            });
          }
        }

        anthropicMessages.push({
          role: 'assistant',
          content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
        });
      } else if (msg.role === 'tool') {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || '',
            content: msg.content || '',
          }],
        });
      }
    }

    return { system, messages: anthropicMessages };
  }

  /**
   * Convert OpenAI content to Anthropic content format
   */
  private convertContentToAnthropic(content: string | null): string | AnthropicContentBlock[] {
    if (!content) {
      return '';
    }
    return content;
  }

  /**
   * Convert OpenAI tools to Anthropic tools
   */
  public convertTools(tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>): AnthropicTool[] {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  }

  /**
   * Create initial stream state
   */
  private createStreamState(): StreamState {
    return {
      textContent: '',
      toolCalls: new Map(),
      currentBlockIndex: null,
      currentBlockType: null,
      requestId: `msg_${Date.now()}_${randomBytes(4).toString('hex')}`,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /**
   * Process a single SSE event from Anthropic
   */
  private processStreamEvent(
    event: AnthropicStreamEvent,
    state: StreamState
  ): { content: string; tool_calls: StreamingToolCall[] } | null {
    switch (event.type) {
      case 'message_start':
        state.inputTokens = event.message.usage?.input_tokens || 0;
        return null;

      case 'content_block_start':
        state.currentBlockIndex = event.index;
        if (event.content_block.type === 'text') {
          state.currentBlockType = 'text';
        } else if (event.content_block.type === 'tool_use') {
          state.currentBlockType = 'tool_use';
          state.toolCalls.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            arguments: '',
          });
        }
        return null;

      case 'content_block_delta':
        if (state.currentBlockIndex === event.index) {
          if (event.delta.type === 'text_delta' && state.currentBlockType === 'text') {
            state.textContent += event.delta.text;
            return { content: event.delta.text, tool_calls: [] };
          } else if (event.delta.type === 'input_json_delta' && state.currentBlockType === 'tool_use') {
            const toolCall = state.toolCalls.get(event.index);
            if (toolCall) {
              toolCall.arguments += event.delta.partial_json;
            }
            return null;
          }
        }
        return null;

      case 'content_block_stop':
        state.currentBlockIndex = null;
        state.currentBlockType = null;
        return null;

      case 'message_delta':
        if (event.usage?.output_tokens) {
          state.outputTokens = event.usage.output_tokens;
        }
        return null;

      case 'message_stop':
        return null;

      default:
        return null;
    }
  }

  /**
   * Get finalized tool calls
   */
  private getFinalizedToolCalls(state: StreamState): StreamingToolCall[] {
    const result: StreamingToolCall[] = [];
    for (const tc of state.toolCalls.values()) {
      result.push({ ...tc });
    }
    return result;
  }

  /**
   * Stream chat completions from Anthropic Messages API
   */
  public async *streamMessages(
    request: {
      model: string;
      messages: OpenAIMessage[];
      max_tokens?: number;
      temperature?: number;
      stream?: boolean;
      tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
      tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
    },
    cancellationToken: { isCancellationRequested: boolean }
  ): AsyncGenerator<{ content: string; tool_calls: StreamingToolCall[]; finished_tool_calls: StreamingToolCall[] }, void, unknown> {
    const baseUrl = this.config.baseURL.replace(/\/$/, '');
    const url = `${baseUrl}/messages`;

    // Convert OpenAI format to Anthropic format
    const { system, messages: anthropicMessages } = this.convertMessages(request.messages);

    const anthropicRequest: AnthropicMessageRequest = {
      model: request.model,
      max_tokens: request.max_tokens || 4096,
      messages: anthropicMessages,
      system,
      temperature: request.temperature,
      stream: true,
    };

    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = this.convertTools(request.tools);
      if (request.tool_choice) {
        anthropicRequest.tool_choice = request.tool_choice;
      }
    }

    const state = this.createStreamState();

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(anthropicRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (cancellationToken.isCancellationRequested) {
          reader.cancel();
          break;
        }

        const { done, value } = await reader.read();
        if (done) { break; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const result = this.processSSELine(line, state);
          if (result) {
            yield result;
          }
        }
      }

      // Finalize any remaining tool calls
      const finalized = this.getFinalizedToolCalls(state);
      if (finalized.length > 0) {
        yield { content: '', tool_calls: [], finished_tool_calls: finalized };
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Anthropic request failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Parse a single SSE line and process the event
   */
  private processSSELine(
    line: string,
    state: StreamState
  ): { content: string; tool_calls: StreamingToolCall[]; finished_tool_calls: StreamingToolCall[] } | null {
    const trimmed = line.trim();

    if (trimmed === '' || trimmed === 'data: [DONE]') {
      return null;
    }

    // Anthropic SSE format: event: <event_type>\ndata: <json>\n\n
    if (trimmed.startsWith('event: ')) {
      // Store event type for next data line
      return null;
    }

    if (!trimmed.startsWith('data: ')) {
      return null;
    }

    const data = trimmed.slice(6);

    // Handle streaming complete marker
    if (data === '[DONE]') {
      return null;
    }

    try {
      const event = JSON.parse(data) as AnthropicStreamEvent;
      const result = this.processStreamEvent(event, state);

      if (result) {
        return {
          content: result.content,
          tool_calls: result.tool_calls,
          finished_tool_calls: [],
        };
      }

      return null;
    } catch {
      console.error('Failed to parse Anthropic SSE event:', data);
      return null;
    }
  }

  /**
   * Create a non-streaming chat completion
   */
  public async createMessage(
    request: {
      model: string;
      messages: OpenAIMessage[];
      max_tokens?: number;
      temperature?: number;
      tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
      tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
    }
  ): Promise<AnthropicMessageResponse> {
    const baseUrl = this.config.baseURL.replace(/\/$/, '');
    const url = `${baseUrl}/messages`;

    // Convert OpenAI format to Anthropic format
    const { system, messages: anthropicMessages } = this.convertMessages(request.messages);

    const anthropicRequest: AnthropicMessageRequest = {
      model: request.model,
      max_tokens: request.max_tokens || 4096,
      messages: anthropicMessages,
      system,
      temperature: request.temperature,
      stream: false,
    };

    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = this.convertTools(request.tools);
      if (request.tool_choice) {
        anthropicRequest.tool_choice = request.tool_choice;
      }
    }

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(anthropicRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return await response.json() as AnthropicMessageResponse;
  }

  /**
   * Get headers for API requests
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
    };

    if (this.config.apiKey) {
      headers['x-api-key'] = this.config.apiKey;
    }

    return headers;
  }

  /**
   * Fetch wrapper with timeout support
   */
  private async fetch(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second default timeout

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
