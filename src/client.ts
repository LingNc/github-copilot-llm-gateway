import * as vscode from 'vscode';
import {
  OpenAIChatCompletionRequest,
  OpenAIModelsResponse,
  VLLMConfig
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
 * HTTP client for vLLM server (OpenAI API compatible)
 */
export class VLLMClient {
  private config: VLLMConfig;

  constructor(config: VLLMConfig) {
    this.config = config;
  }

  /**
   * Update client configuration
   */
  public updateConfig(config: VLLMConfig): void {
    this.config = config;
  }

  /**
   * Fetch available models from /v1/models endpoint
   */
  public async fetchModels(): Promise<OpenAIModelsResponse> {
    const url = `${this.config.serverUrl}/v1/models`;

    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to connect to vLLM server: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Stream chat completions from /v1/chat/completions endpoint
   *
   * IMPORTANT: Tool calls are tracked by INDEX during streaming, not by ID.
   * OpenAI streaming format sends tool calls incrementally with an `index` field
   * to identify which tool call is being updated. The `id` may arrive in a later chunk.
   */
  public async *streamChatCompletion(
    request: OpenAIChatCompletionRequest,
    cancellationToken: vscode.CancellationToken
  ): AsyncGenerator<{ content: string; tool_calls: StreamingToolCall[]; finished_tool_calls: StreamingToolCall[]; }, void, unknown> {
    const url = `${this.config.serverUrl}/v1/chat/completions`;

    // Track tool calls by index (not id) since id may come in later chunks
    const toolCallsByIndex = new Map<number, StreamingToolCall>();
    // Track which indices have been finalized
    const finalizedIndices = new Set<number>();
    // Request ID for generating fallback tool call IDs
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    let toolCallCounter = 0;

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...request,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Chat completion failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        // Check for cancellation
        if (cancellationToken.isCancellationRequested) {
          reader.cancel();
          break;
        }

        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed === '' || trimmed === 'data: [DONE]') {
            continue;
          }

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);

            try {
              const parsed: any = JSON.parse(data);
              const finishedToolCalls: StreamingToolCall[] = [];

              // Delta streaming format (incremental tokens / function call parts)
              const delta = parsed.choices?.[0]?.delta;
              const finishReason = parsed.choices?.[0]?.finish_reason;

              if (delta) {
                // Handle streamed tool_calls (OpenAI format with index)
                if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                  for (const tc of delta.tool_calls) {
                    // Use index to track tool calls (critical fix!)
                    const index = tc.index ?? toolCallCounter++;

                    const existing = toolCallsByIndex.get(index);
                    if (existing) {
                      // Accumulate: update id/name if provided, append arguments
                      if (tc.id) {
                        existing.id = tc.id;
                      }
                      if (tc.function?.name) {
                        existing.name = tc.function.name;
                      }
                      if (tc.function?.arguments) {
                        existing.arguments += tc.function.arguments;
                      }
                    } else {
                      // New tool call at this index
                      toolCallsByIndex.set(index, {
                        id: tc.id || '',
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '',
                      });
                    }
                  }
                }

                // Handle legacy function_call format (single function call)
                if (delta.function_call) {
                  const index = 0; // Legacy format only supports one call
                  const existing = toolCallsByIndex.get(index);
                  if (existing) {
                    if (delta.function_call.name) {
                      existing.name = delta.function_call.name;
                    }
                    if (delta.function_call.arguments) {
                      existing.arguments += delta.function_call.arguments;
                    }
                  } else {
                    toolCallsByIndex.set(index, {
                      id: parsed.id || '',
                      name: delta.function_call.name || '',
                      arguments: delta.function_call.arguments || '',
                    });
                  }
                }

                // Check if we hit a finish reason indicating tool calls are complete
                if (finishReason === 'tool_calls' || finishReason === 'function_call') {
                  // Finalize all accumulated tool calls
                  for (const [index, tc] of toolCallsByIndex.entries()) {
                    if (!finalizedIndices.has(index)) {
                      finalizedIndices.add(index);
                      // Generate fallback ID if none provided
                      if (!tc.id) {
                        tc.id = `call_${requestId}_${index}`;
                      }
                      finishedToolCalls.push({ ...tc });
                    }
                  }
                }

                yield {
                  content: delta.content || '',
                  tool_calls: [], // Raw incremental updates no longer yielded
                  finished_tool_calls: finishedToolCalls,
                };
              } else {
                // Non-delta (final) message format - some models send complete message
                const message = parsed.choices?.[0]?.message;
                if (message) {
                  // Handle complete tool_calls array
                  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                    for (let i = 0; i < message.tool_calls.length; i++) {
                      const tc = message.tool_calls[i];
                      const index = tc.index ?? i;
                      if (!finalizedIndices.has(index)) {
                        finalizedIndices.add(index);
                        finishedToolCalls.push({
                          id: tc.id || `call_${requestId}_${index}`,
                          name: tc.function?.name || '',
                          arguments: tc.function?.arguments || '',
                        });
                      }
                    }
                  }

                  // Handle legacy function_call format
                  if (message.function_call && !finalizedIndices.has(0)) {
                    finalizedIndices.add(0);
                    finishedToolCalls.push({
                      id: parsed.id || `call_${requestId}_0`,
                      name: message.function_call.name || '',
                      arguments: message.function_call.arguments || '',
                    });
                  }

                  const content = message.content || message.text || '';
                  yield {
                    content,
                    tool_calls: [],
                    finished_tool_calls: finishedToolCalls,
                  };
                }
              }
            } catch (error) {
              console.error('Failed to parse SSE chunk:', error, 'Data:', data);
            }
          }
        }
      }

      // After stream ends, finalize any remaining tool calls that weren't explicitly finished
      const remainingToolCalls: StreamingToolCall[] = [];
      for (const [index, tc] of toolCallsByIndex.entries()) {
        if (!finalizedIndices.has(index) && (tc.name || tc.arguments)) {
          finalizedIndices.add(index);
          if (!tc.id) {
            tc.id = `call_${requestId}_${index}`;
          }
          remainingToolCalls.push({ ...tc });
        }
      }

      if (remainingToolCalls.length > 0) {
        yield {
          content: '',
          tool_calls: [],
          finished_tool_calls: remainingToolCalls,
        };
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Chat completion request failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get headers for API requests
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  /**
   * Fetch wrapper with timeout support
   */
  private async fetch(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout);

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
