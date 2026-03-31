/**
 * Type definitions for OpenAI-compatible API responses
 */

export interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModel[];
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GatewayConfig {
  serverUrl: string;
  apiKey?: string;
  requestTimeout: number;
  defaultMaxTokens: number;
  defaultMaxOutputTokens: number;
  enableToolCalling: boolean;
  parallelToolCalling: boolean;
  agentTemperature: number;
}

/**
 * Configuration mode for model information source
 */
export type ConfigMode = 'config-only' | 'config-priority' | 'api-priority';

/**
 * Provider name display style
 */
export type ProviderNameStyle = 'slash' | 'bracket';

/**
 * Model capabilities configuration
 */
export interface ModelCapabilities {
  toolCalling?: boolean;
  vision?: boolean;
}

/**
 * Model modalities (input/output types)
 */
export interface ModelModalities {
  input: ('text' | 'image' | 'audio')[];
  output: ('text' | 'image' | 'audio')[];
}

/**
 * Thinking/ReasOning configuration
 */
export interface ThinkingOptions {
  type: 'enabled' | 'disabled';
  budgetTokens?: number;
}

/**
 * Model options
 */
export interface ModelOptions {
  thinking?: ThinkingOptions;
}

/**
 * Model limits (context and output)
 */
export interface ModelLimits {
  context: number;
  output: number;
}

/**
 * Single model configuration
 */
export interface ModelConfig {
  name: string;
  modalities?: ModelModalities;
  options?: ModelOptions;
  limit: ModelLimits;
  capabilities?: ModelCapabilities;
}

/**
 * API format type
 */
export type ApiFormat = 'openai' | 'anthropic';

/**
 * Provider configuration with API format
 */
export interface ProviderConfig {
  name: string;
  baseURL: string;
  apiKey?: string;
  apiFormat?: ApiFormat;
  models: Record<string, ModelConfig>;
}

/**
 * Complete multi-provider configuration
 */
export interface MultiProviderConfig {
  providers: Record<string, ProviderConfig>;
  showProviderPrefix: boolean;
  providerNameStyle: ProviderNameStyle;
  configMode: ConfigMode;
}

/**
 * Extended gateway configuration with multi-provider support
 * Includes backward compatible legacy fields
 */
export interface ExtendedGatewayConfig extends GatewayConfig, MultiProviderConfig {
  // This combines both old and new config formats
}

// ============================================
// Anthropic API Types
// ============================================

/**
 * Anthropic message content block
 */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'thinking'; thinking: string; signature?: string };

/**
 * Anthropic message
 */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/**
 * Anthropic tool definition
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Anthropic message request
 */
export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
}

/**
 * Anthropic message response
 */
export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Anthropic streaming event types
 */
export type AnthropicStreamEvent =
  | { type: 'message_start'; message: { id: string; type: 'message'; role: 'assistant'; content: []; model: string; stop_reason: null; stop_sequence: null; usage: { input_tokens: number; output_tokens: number } } }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } | { type: 'thinking_delta'; thinking: string } }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage?: { output_tokens: number }; stop_reason?: AnthropicMessageResponse['stop_reason']; stop_sequence?: string | null }
  | { type: 'message_stop' };
