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
 * Provider configuration
 */
export interface ProviderConfig {
  name: string;
  baseURL: string;
  apiKey?: string;
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
