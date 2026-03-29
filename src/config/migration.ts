/**
 * Configuration migration utilities
 * Handles migration from legacy single-provider config to multi-provider config
 */

import * as vscode from 'vscode';
import {
  LegacyConfig,
  MultiProviderConfig,
  ProviderConfig,
  ModelConfig,
} from './types';

/**
 * Check if legacy configuration exists (providers not configured)
 */
export function hasLegacyConfig(config: vscode.WorkspaceConfiguration): boolean {
  const providers = config.get<Record<string, unknown>>('providers');
  // If providers is not set but serverUrl is, it's legacy config
  return !providers && !!config.get<string>('serverUrl');
}

/**
 * Extract legacy configuration from VS Code settings
 */
export function extractLegacyConfig(config: vscode.WorkspaceConfiguration): LegacyConfig {
  return {
    serverUrl: config.get<string>('serverUrl'),
    apiKey: config.get<string>('apiKey'),
    requestTimeout: config.get<number>('requestTimeout'),
    defaultMaxTokens: config.get<number>('defaultMaxTokens'),
    defaultMaxOutputTokens: config.get<number>('defaultMaxOutputTokens'),
    enableToolCalling: config.get<boolean>('enableToolCalling'),
    parallelToolCalling: config.get<boolean>('parallelToolCalling'),
    agentTemperature: config.get<number>('agentTemperature'),
  };
}

/**
 * Create a default provider from legacy configuration
 */
export function createDefaultProviderFromLegacy(legacy: LegacyConfig): ProviderConfig {
  const baseURL = legacy.serverUrl || 'http://localhost:8000';
  const apiKey = legacy.apiKey || '';
  const defaultMaxTokens = legacy.defaultMaxTokens || 32768;
  const defaultMaxOutputTokens = legacy.defaultMaxOutputTokens || 4096;
  const enableToolCalling = legacy.enableToolCalling !== false; // default true

  // Create a default model that uses legacy settings
  const defaultModel: ModelConfig = {
    name: 'Default Model',
    modalities: {
      input: ['text'],
      output: ['text'],
    },
    limit: {
      context: defaultMaxTokens,
      output: defaultMaxOutputTokens,
    },
    capabilities: {
      toolCalling: enableToolCalling,
      vision: false,
    },
  };

  return {
    name: 'Default Provider',
    baseURL,
    apiKey: apiKey || undefined,
    models: {
      'default': defaultModel,
    },
  };
}

/**
 * Migrate legacy configuration to multi-provider configuration
 */
export function migrateToMultiProvider(legacy: LegacyConfig): MultiProviderConfig {
  const defaultProvider = createDefaultProviderFromLegacy(legacy);

  return {
    providers: {
      'default': defaultProvider,
    },
    showProviderPrefix: false,
    configMode: 'api-priority', // Use API-priority for legacy to maintain behavior
  };
}

/**
 * Create a minimal multi-provider config with empty providers
 * Used when no configuration exists at all
 */
export function createEmptyMultiProviderConfig(): MultiProviderConfig {
  return {
    providers: {},
    showProviderPrefix: false,
    configMode: 'config-only',
  };
}

/**
 * Create a default multi-provider config with example provider
 * Used for first-time setup
 */
export function createExampleMultiProviderConfig(): MultiProviderConfig {
  return {
    providers: {
      'local-vllm': {
        name: '本地 vLLM',
        baseURL: 'http://localhost:8000',
        models: {
          'llama3': {
            name: 'Llama 3',
            modalities: {
              input: ['text'],
              output: ['text'],
            },
            limit: {
              context: 8192,
              output: 4096,
            },
            capabilities: {
              toolCalling: true,
              vision: false,
            },
          },
        },
      },
    },
    showProviderPrefix: false,
    configMode: 'config-only',
  };
}

/**
 * Get migration message for output channel
 */
export function getMigrationMessage(legacy: LegacyConfig): string {
  const parts: string[] = ['Detected legacy configuration. Migrating to multi-provider format...'];

  if (legacy.serverUrl) {
    parts.push(`  - serverUrl: ${legacy.serverUrl}`);
  }
  if (legacy.apiKey) {
    parts.push('  - apiKey: [hidden]');
  }
  if (legacy.defaultMaxTokens) {
    parts.push(`  - defaultMaxTokens: ${legacy.defaultMaxTokens}`);
  }
  if (legacy.defaultMaxOutputTokens) {
    parts.push(`  - defaultMaxOutputTokens: ${legacy.defaultMaxOutputTokens}`);
  }
  if (legacy.enableToolCalling !== undefined) {
    parts.push(`  - enableToolCalling: ${legacy.enableToolCalling}`);
  }

  parts.push('Migration complete. Consider updating your settings to use the new format for better control.');

  return parts.join('\n');
}

/**
 * Check if migration is needed and perform it
 * Returns true if migration was performed
 */
export function checkAndPerformMigration(
  config: vscode.WorkspaceConfiguration,
  outputChannel: vscode.OutputChannel
): { migrated: boolean; config: MultiProviderConfig; warnings: string[] } {
  const warnings: string[] = [];

  if (hasLegacyConfig(config)) {
    const legacy = extractLegacyConfig(config);
    outputChannel.appendLine(getMigrationMessage(legacy));

    const multiConfig = migrateToMultiProvider(legacy);
    return {
      migrated: true,
      config: multiConfig,
      warnings: ['Migrated from legacy configuration. Please review the new format in settings.'],
    };
  }

  // Check if providers is empty
  const providers = config.get<Record<string, ProviderConfig>>('providers');
  if (!providers || Object.keys(providers).length === 0) {
    warnings.push('No providers configured. Using empty configuration. Please add providers in settings.');
    return {
      migrated: false,
      config: createEmptyMultiProviderConfig(),
      warnings,
    };
  }

  // Configuration is already in new format
  return {
    migrated: false,
    config: {
      providers: providers || {},
      showProviderPrefix: config.get<boolean>('showProviderPrefix', false),
      configMode: config.get<('config-only' | 'config-priority' | 'api-priority')>('configMode', 'config-priority'),
    },
    warnings,
  };
}
