import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { GatewayProvider } from '../provider';
import { MultiProviderConfig } from '../config/types';
import { TokenUsageViewProvider } from '../views/TokenUsageView';
import { LogService } from '../services/LogService';

/**
 * Provider Manager class
 * Handles registration of a single GatewayProvider that manages all configured providers
 */
export class ProviderManager {
  private configManager: ConfigManager;
  private outputChannel: vscode.OutputChannel;
  private logService: LogService;
  private context: vscode.ExtensionContext;
  private providerDisposable?: vscode.Disposable;
  private provider?: GatewayProvider;
  private tokenUsageProvider?: TokenUsageViewProvider;
  private isReloading = false; // Prevent recursive reloads

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    logService: LogService
  ) {
    this.context = context;
    this.outputChannel = outputChannel;
    this.logService = logService;

    // Initialize ConfigManager with callback for config changes
    this.configManager = new ConfigManager(
      outputChannel,
      this.handleConfigChange.bind(this)
    );
  }

  /**
   * Initialize and register the provider
   */
  public async initialize(): Promise<void> {
    this.outputChannel.appendLine('Initializing Provider Manager...');

    await this.registerProvider();

    this.outputChannel.appendLine('Provider Manager initialized.');
  }

  /**
   * Dispose provider
   */
  public dispose(): void {
    this.outputChannel.appendLine('Disposing provider...');

    if (this.providerDisposable) {
      this.providerDisposable.dispose();
      this.providerDisposable = undefined;
    }

    this.outputChannel.appendLine('Provider disposed.');
  }

  /**
   * Reload configuration and re-register provider
   */
  public async reload(): Promise<void> {
    if (this.isReloading) {
      this.outputChannel.appendLine('Reload already in progress, skipping...');
      return;
    }

    this.isReloading = true;
    this.outputChannel.appendLine('Reloading provider...');

    try {
      // Dispose existing provider
      this.dispose();

      // Reload config and re-register
      const result = this.configManager.reloadConfig();
      await this.registerProvider();

      if (result.migrated) {
        this.outputChannel.appendLine('Configuration migrated from legacy format.');
      }

      for (const warning of result.warnings) {
        this.outputChannel.appendLine(`Warning: ${warning}`);
      }

      this.outputChannel.appendLine('Provider reloaded.');
    } finally {
      this.isReloading = false;
    }
  }

  /**
   * Get ConfigManager instance
   */
  public getConfigManager(): ConfigManager {
    return this.configManager;
  }

  /**
   * Get the registered provider
   */
  public getProvider(): GatewayProvider | undefined {
    return this.provider;
  }

  /**
   * Set the token usage view provider
   */
  public setTokenUsageProvider(provider: TokenUsageViewProvider): void {
    this.tokenUsageProvider = provider;
    // Pass it to the GatewayProvider if it exists
    if (this.provider) {
      this.provider.setTokenUsageProvider(provider);
    }
  }

  /**
   * Handle configuration changes
   */
  private async handleConfigChange(config: MultiProviderConfig): Promise<void> {
    if (this.isReloading) {
      this.outputChannel.appendLine('Configuration changed during reload, ignoring...');
      return;
    }
    this.outputChannel.appendLine('Configuration changed, updating provider...');
    await this.reload();
  }

  /**
   * Register the provider
   */
  private async registerProvider(): Promise<void> {
    const providers = this.configManager.getProviders();

    if (providers.length === 0) {
      this.outputChannel.appendLine('No providers configured. Please add providers in settings.');
      vscode.window.showWarningMessage(
        'LLM Gateway: No providers configured. Add providers in settings.',
        'Open Settings'
      ).then(selection => {
        if (selection === 'Open Settings') {
          this.configManager.openConfiguration();
        }
      });
      return;
    }

    try {
      // Create GatewayProvider instance
      this.provider = new GatewayProvider(
        this.context,
        this.configManager,
        this.outputChannel,
        this.logService
      );

      // Register with VS Code - use the vendor ID declared in package.json
      this.providerDisposable = vscode.lm.registerLanguageModelChatProvider(
        'llm-gateway',
        this.provider
      );

      this.logService.info('Config', `Provider "llm-gateway" registered with ${providers.length} provider(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`Failed to register provider: ${message}`);
      vscode.window.showErrorMessage(
        `LLM Gateway: Failed to register provider. ${message}`
      );
    }
  }
}
