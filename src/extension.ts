import * as vscode from 'vscode';
import { ProviderManager } from './manager';
import { ConfigManager } from './config/ConfigManager';
import { registerConfigCommands } from './commands';

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
  console.log('GitHub Copilot LLM Gateway extension is now active');

  const outputChannel = vscode.window.createOutputChannel('GitHub Copilot LLM Gateway');
  outputChannel.appendLine('Extension activating...');

  // Create ProviderManager
  const providerManager = new ProviderManager(context, outputChannel);

  // Initialize and register all providers
  await providerManager.initialize();

  // Store for disposal
  context.subscriptions.push({
    dispose: () => {
      providerManager.dispose();
      outputChannel.dispose();
    }
  });

  // Register commands
  registerCommands(context, providerManager, outputChannel);

  console.log('Copilot LLM Gateway extension activated successfully');
  outputChannel.appendLine('Extension activated successfully');
}

/**
 * Register all commands
 */
function registerCommands(
  context: vscode.ExtensionContext,
  providerManager: ProviderManager,
  outputChannel: vscode.OutputChannel
): void {
  const configManager = providerManager.getConfigManager();

  // Test connection command
  const testCommand = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.testConnection',
    async () => {
      try {
        const provider = providerManager.getProvider();
        if (!provider) {
          vscode.window.showErrorMessage(
            'LLM Gateway: Provider not initialized. Please check configuration.'
          );
          return;
        }

        const models = await provider.provideLanguageModelChatInformation(
          { silent: false },
          new vscode.CancellationTokenSource().token
        );

        if (models.length > 0) {
          vscode.window.showInformationMessage(
            `LLM Gateway: Successfully connected! Found ${models.length} model(s).`
          );
        } else {
          vscode.window.showWarningMessage(
            'LLM Gateway: Connected but no models found. Check your configuration.'
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `LLM Gateway: Connection test failed. ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
  context.subscriptions.push(testCommand);

  // Open configuration command
  const openConfigCommand = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.openConfig',
    async () => {
      await configManager.openConfiguration();
    }
  );
  context.subscriptions.push(openConfigCommand);

  // Reload configuration command
  const reloadConfigCommand = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.reloadConfig',
    async () => {
      await providerManager.reload();
      vscode.window.showInformationMessage('LLM Gateway: Configuration reloaded.');
    }
  );
  context.subscriptions.push(reloadConfigCommand);

  // Register config management commands
  registerConfigCommands(context, configManager);

  outputChannel.appendLine(`Registered commands`);
}

/**
 * Extension deactivation
 */
export function deactivate() {
  console.log('GitHub Copilot LLM Gateway extension is now deactivated');
}
