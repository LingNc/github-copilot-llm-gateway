/**
 * Configuration types for multi-provider setup
 */

import {
  ConfigMode,
  ModelCapabilities,
  ModelModalities,
  ModelOptions,
  ModelLimits,
  ModelConfig,
  ProviderConfig,
  MultiProviderConfig,
} from '../types';

export {
  ConfigMode,
  ModelCapabilities,
  ModelModalities,
  ModelOptions,
  ModelLimits,
  ModelConfig,
  ProviderConfig,
  MultiProviderConfig,
};

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validation error
 */
export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Configuration source
 */
export type ConfigSource = 'user' | 'workspace' | 'default';

/**
 * Resolved provider with computed properties
 */
export interface ResolvedProvider extends ProviderConfig {
  id: string;
  source: ConfigSource;
}

/**
 * Resolved model with computed properties
 */
export interface ResolvedModel extends ModelConfig {
  id: string;
  providerId: string;
  fullId: string; // providerId/modelId
}

/**
 * Configuration load result
 */
export interface ConfigLoadResult {
  config: MultiProviderConfig;
  migrated: boolean;
  warnings: string[];
}

/**
 * Legacy configuration (for migration)
 */
export interface LegacyConfig {
  serverUrl?: string;
  apiKey?: string;
  requestTimeout?: number;
  defaultMaxTokens?: number;
  defaultMaxOutputTokens?: number;
  enableToolCalling?: boolean;
  parallelToolCalling?: boolean;
  agentTemperature?: number;
}
