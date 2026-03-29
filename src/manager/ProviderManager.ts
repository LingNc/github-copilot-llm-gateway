/**
 * Provider Manager
 * Manages multiple GatewayProvider instances for multi-provider support
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { GatewayProvider } from '../provider';
import { MultiProviderConfig, ResolvedProvider } from '../config/types';

/**
 * Provider registration info
 */
interface ProviderRegistration {
  provider: GatewayProvider;
  disposable: vscode.Disposable;
  providerId: string;
}

/**
 * Provider Manager class
 * Handles registration and lifecycle of multiple GatewayProvider instances
 */
export class ProviderManager {
  private configManager: ConfigManager;
  private outputChannel: vscode.OutputChannel;
  private context: vscode.ExtensionContext;
  private registrations: Map<string, ProviderRegistration> = new Map();

  constructor(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.context = context;
    this.outputChannel = outputChannel;

    // Initialize ConfigManager with callback for config changes
    this.configManager = new ConfigManager(
      outputChannel,
      this.handleConfigChange.bind(this)
    );
  }

  /**
   * Initialize and register all providers
   */
  public async initialize(): Promise<void> {
    this.outputChannel.appendLine('Initializing Provider Manager...');

    const config = this.configManager.getConfig();
    await this.registerAllProviders(config);

    this.outputChannel.appendLine('Provider Manager initialized.');
  }

  /**
   * Dispose all providers
   */
  public dispose(): void {
    this.outputChannel.appendLine('Disposing all providers...');

    for (const [providerId, registration] of this.registrations) {
      registration.disposable.dispose();
      this.outputChannel.appendLine(`Provider "${providerId}" unregistered.`);
    }

    this.registrations.clear();
    this.outputChannel.appendLine('All providers disposed.');
  }

  /**
   * Reload configuration and re-register providers
   */
  public async reload(): Promise<void> {
    this.outputChannel.appendLine('Reloading providers...');

    // Dispose existing providers
    this.dispose();

    // Reload config and re-register
    const result = this.configManager.reloadConfig();
    await this.registerAllProviders(result.config);

    if (result.migrated) {
      this.outputChannel.appendLine('Configuration migrated from legacy format.');
    }

    for (const warning of result.warnings) {
      this.outputChannel.appendLine(`Warning: ${warning}`);
    }

    this.outputChannel.appendLine('Providers reloaded.');
  }

  /**
   * Get ConfigManager instance
   */
  public getConfigManager(): ConfigManager {
    return this.configManager;
  }

  /**
   * Get all registered provider IDs
   */
  public getRegisteredProviderIds(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * Check if a provider is registered
   */
  public isProviderRegistered(providerId: string): boolean {
    return this.registrations.has(providerId);
  }

  /**
   * Get a specific provider
   */
  public getProvider(providerId: string): GatewayProvider | undefined {
    const registration = this.registrations.get(providerId);
    return registration?.provider;
  }

  /**
   * Handle configuration changes
   */
  private async handleConfigChange(config: MultiProviderConfig): Promise<void> {
    this.outputChannel.appendLine('Configuration changed, updating providers...');
    await this.reload();
  }

  /**
   * Register all providers from configuration
   */
  private async registerAllProviders(config: MultiProviderConfig): Promise<void> {
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

    for (const provider of providers) {
      await this.registerProvider(provider);
    }

    this.outputChannel.appendLine(`Registered ${this.registrations.size} provider(s).`);
  }

  /**
   * Register a single provider
   */
  private async registerProvider(resolvedProvider: ResolvedProvider): Promise<void> {
    const providerId = resolvedProvider.id;

    try {
      // Check if already registered
      if (this.registrations.has(providerId)) {
        this.outputChannel.appendLine(`Provider "${providerId}" already registered, skipping.`);
        return;
      }

      // Create GatewayProvider instance
      const provider = new GatewayProvider(
        this.context,
        this.configManager,
        providerId
      );

      // Register with VS Code
      const disposable = vscode.lm.registerLanguageModelChatProvider(
        providerId,
        provider
      );

      // Store registration
      this.registrations.set(providerId, {
        provider,
        disposable,
        providerId,
      });

      this.outputChannel.appendLine(
        `Provider "${providerId}" (${resolvedProvider.name}) registered successfully.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`Failed to register provider "${providerId}": ${message}`);
      vscode.window.showErrorMessage(
        `LLM Gateway: Failed to register provider "${providerId}". ${message}`
      );
    }
  }

  /**
   * Unregister a single provider
   */
  private unregisterProvider(providerId: string): void {
    const registration = this.registrations.get(providerId);
    if (!registration) {
      return;
    }

    registration.disposable.dispose();
    this.registrations.delete(providerId);
    this.outputChannel.appendLine(`Provider "${providerId}" unregistered.`);
  }
}
