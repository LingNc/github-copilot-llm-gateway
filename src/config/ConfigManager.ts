/**
 * Configuration Manager
 * Handles loading, validation, and migration of multi-provider configuration
 */

import * as vscode from 'vscode';
import {
  MultiProviderConfig,
  ProviderConfig,
  ConfigMode,
  ConfigLoadResult,
  ResolvedProvider,
  ResolvedModel,
  ProviderNameStyle,
} from './types';
import { validateMultiProviderConfig, formatValidationErrors } from './validator';
import { checkAndPerformMigration } from './migration';

const CONFIG_SECTION = 'github.copilot.llm-gateway';

/**
 * Configuration Manager class
 */
export class ConfigManager {
  private config: vscode.WorkspaceConfiguration;
  private outputChannel: vscode.OutputChannel;
  private currentConfig: MultiProviderConfig;
  private onConfigChanged: (config: MultiProviderConfig) => void;

  constructor(
    outputChannel: vscode.OutputChannel,
    onConfigChanged: (config: MultiProviderConfig) => void
  ) {
    this.outputChannel = outputChannel;
    this.onConfigChanged = onConfigChanged;
    this.config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    this.currentConfig = this.loadConfig();

    // Watch for configuration changes
    vscode.workspace.onDidChangeConfiguration(this.handleConfigChange.bind(this));
  }

  /**
   * Get current configuration
   */
  public getConfig(): MultiProviderConfig {
    return this.currentConfig;
  }

  /**
   * Get config mode
   */
  public getConfigMode(): ConfigMode {
    return this.currentConfig.configMode;
  }

  /**
   * Check if provider prefix should be shown
   */
  public shouldShowProviderPrefix(): boolean {
    return this.currentConfig.showProviderPrefix;
  }

  /**
   * Get provider name display style
   */
  public getProviderNameStyle(): ProviderNameStyle {
    return this.currentConfig.providerNameStyle;
  }

  /**
   * Get all providers
   */
  public getProviders(): ResolvedProvider[] {
    return Object.entries(this.currentConfig.providers).map(([id, provider]) => ({
      ...provider,
      id,
      source: 'user',
    }));
  }

  /**
   * Get a single provider by ID
   */
  public getProvider(providerId: string): ResolvedProvider | undefined {
    const provider = this.currentConfig.providers[providerId];
    if (!provider) {
      return undefined;
    }
    return {
      ...provider,
      id: providerId,
      source: 'user',
    };
  }

  /**
   * Get all models from all providers
   */
  public getAllModels(): ResolvedModel[] {
    const models: ResolvedModel[] = [];

    for (const [providerId, provider] of Object.entries(this.currentConfig.providers)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        models.push({
          ...model,
          id: modelId,
          providerId,
          fullId: `${providerId}/${modelId}`,
        });
      }
    }

    return models;
  }

  /**
   * Get models for a specific provider
   */
  public getModelsForProvider(providerId: string): ResolvedModel[] {
    const provider = this.currentConfig.providers[providerId];
    if (!provider) {
      return [];
    }

    return Object.entries(provider.models).map(([modelId, model]) => ({
      ...model,
      id: modelId,
      providerId,
      fullId: `${providerId}/${modelId}`,
    }));
  }

  /**
   * Get a specific model
   */
  public getModel(providerId: string, modelId: string): ResolvedModel | undefined {
    const provider = this.currentConfig.providers[providerId];
    if (!provider) {
      return undefined;
    }

    const model = provider.models[modelId];
    if (!model) {
      return undefined;
    }

    return {
      ...model,
      id: modelId,
      providerId,
      fullId: `${providerId}/${modelId}`,
    };
  }

  /**
   * Reload configuration
   */
  public reloadConfig(): ConfigLoadResult {
    this.config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const result = this.loadConfigWithResult();
    this.currentConfig = result.config;
    this.onConfigChanged(result.config);
    return result;
  }

  /**
   * Load configuration from VS Code settings
   */
  private loadConfig(): MultiProviderConfig {
    return this.loadConfigWithResult().config;
  }

  /**
   * Load configuration with full result
   */
  private loadConfigWithResult(): ConfigLoadResult {
    this.outputChannel.appendLine('Loading configuration...');

    // Check for migration
    const migrationResult = checkAndPerformMigration(this.config, this.outputChannel);

    if (migrationResult.migrated) {
      this.outputChannel.appendLine('Configuration migrated from legacy format.');
      return {
        config: migrationResult.config,
        migrated: true,
        warnings: migrationResult.warnings,
      };
    }

    // Load from new format
    const providers = this.config.get<Record<string, ProviderConfig>>('providers', {});
    const showProviderPrefix = this.config.get<boolean>('showProviderPrefix', true);
    const providerNameStyle = this.config.get<ProviderNameStyle>('providerNameStyle', 'slash');
    const configMode = this.config.get<ConfigMode>('configMode', 'config-priority');

    const multiConfig: MultiProviderConfig = {
      providers,
      showProviderPrefix,
      providerNameStyle,
      configMode,
    };

    // Validate configuration
    const validation = validateMultiProviderConfig(multiConfig);
    if (!validation.valid) {
      const errorMessage = formatValidationErrors(validation.errors);
      this.outputChannel.appendLine(`Configuration validation failed:\n${errorMessage}`);
      vscode.window.showErrorMessage(
        `LLM Gateway configuration error: ${validation.errors[0].message}. Check Output panel for details.`
      );
    } else {
      const providerCount = Object.keys(providers).length;
      const modelCount = Object.values(providers).reduce(
        (sum, p) => sum + (p.models ? Object.keys(p.models).length : 0),
        0
      );
      this.outputChannel.appendLine(
        `Configuration loaded: ${providerCount} provider(s), ${modelCount} model(s), mode: ${configMode}`
      );
    }

    // Log warnings
    for (const warning of migrationResult.warnings) {
      this.outputChannel.appendLine(`Warning: ${warning}`);
    }

    return {
      config: multiConfig,
      migrated: false,
      warnings: migrationResult.warnings,
    };
  }

  /**
   * Handle configuration changes
   */
  private handleConfigChange(event: vscode.ConfigurationChangeEvent): void {
    if (event.affectsConfiguration(CONFIG_SECTION)) {
      this.outputChannel.appendLine('Configuration changed, reloading...');
      this.reloadConfig();
    }
  }

  /**
   * Add a new provider
   */
  public async addProvider(providerId: string, provider: ProviderConfig): Promise<boolean> {
    // Validate provider ID
    if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
      vscode.window.showErrorMessage(
        `Invalid provider ID "${providerId}". Must match pattern: ^[a-zA-Z0-9_-]+$`
      );
      return false;
    }

    // Check for duplicate
    if (this.currentConfig.providers[providerId]) {
      const overwrite = await vscode.window.showWarningMessage(
        `Provider "${providerId}" already exists. Overwrite?`,
        'Yes',
        'No'
      );
      if (overwrite !== 'Yes') {
        return false;
      }
    }

    // Update config
    const providers = { ...this.currentConfig.providers };
    providers[providerId] = provider;

    try {
      await this.config.update('providers', providers, true);
      vscode.window.showInformationMessage(`Provider "${providerId}" added successfully.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to add provider: ${message}`);
      return false;
    }
  }

  /**
   * Remove a provider
   */
  public async removeProvider(providerId: string): Promise<boolean> {
    if (!this.currentConfig.providers[providerId]) {
      vscode.window.showErrorMessage(`Provider "${providerId}" not found.`);
      return false;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to remove provider "${providerId}"?`,
      'Yes',
      'No'
    );
    if (confirm !== 'Yes') {
      return false;
    }

    const providers = { ...this.currentConfig.providers };
    delete providers[providerId];

    try {
      await this.config.update('providers', providers, true);
      vscode.window.showInformationMessage(`Provider "${providerId}" removed.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to remove provider: ${message}`);
      return false;
    }
  }

  /**
   * Open configuration in settings.json
   */
  public async openConfiguration(): Promise<void> {
    await vscode.commands.executeCommand(
      'workbench.action.openSettingsJson',
      { query: 'github.copilot.llm-gateway' }
    );
  }
}
