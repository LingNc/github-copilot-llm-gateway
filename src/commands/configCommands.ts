/**
 * Configuration commands
 * Interactive commands for managing providers
 */

import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { ProviderConfig, ModelConfig } from '../config/types';

/**
 * Register all configuration commands
 */
export function registerConfigCommands(
  context: vscode.ExtensionContext,
  configManager: ConfigManager
): void {
  // Add Provider command
  const addProviderCmd = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.addProvider',
    async () => {
      await addProviderInteractive(configManager);
    }
  );
  context.subscriptions.push(addProviderCmd);

  // Edit Provider command
  const editProviderCmd = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.editProvider',
    async () => {
      await editProviderInteractive(configManager);
    }
  );
  context.subscriptions.push(editProviderCmd);

  // Remove Provider command
  const removeProviderCmd = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.removeProvider',
    async () => {
      await removeProviderInteractive(configManager);
    }
  );
  context.subscriptions.push(removeProviderCmd);
}

/**
 * Interactive add provider
 */
async function addProviderInteractive(configManager: ConfigManager): Promise<void> {
  // Get provider ID
  const providerId = await vscode.window.showInputBox({
    prompt: 'Enter a unique provider ID (e.g., "my-openai", "local-vllm")',
    placeHolder: 'provider-id',
    validateInput: (value) => {
      if (!value) {
        return 'Provider ID is required';
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
        return 'Provider ID must match pattern: ^[a-zA-Z0-9_-]+$';
      }
      return null;
    },
  });

  if (!providerId) {
    return;
  }

  // Check if exists
  const existing = configManager.getProvider(providerId);
  if (existing) {
    const overwrite = await vscode.window.showWarningMessage(
      `Provider "${providerId}" already exists. Overwrite?`,
      'Yes',
      'No'
    );
    if (overwrite !== 'Yes') {
      return;
    }
  }

  // Get provider name
  const providerName = await vscode.window.showInputBox({
    prompt: 'Enter provider display name',
    placeHolder: 'e.g., My OpenAI API',
    value: providerId,
  });

  if (!providerName) {
    return;
  }

  // Get base URL
  const baseURL = await vscode.window.showInputBox({
    prompt: 'Enter API base URL',
    placeHolder: 'https://api.openai.com/v1',
    value: 'http://localhost:8000',
    validateInput: (value) => {
      if (!value) {
        return 'Base URL is required';
      }
      try {
        new URL(value);
        return null;
      } catch {
        return 'Invalid URL format';
      }
    },
  });

  if (!baseURL) {
    return;
  }

  // Get API key (optional)
  const apiKey = await vscode.window.showInputBox({
    prompt: 'Enter API key (optional, press Enter to skip)',
    placeHolder: 'sk-...',
    password: true,
  });

  // Create provider config
  const providerConfig: ProviderConfig = {
    name: providerName,
    baseURL,
    apiKey: apiKey || undefined,
    models: {},
  };

  // Ask to add models
  const addModels = await vscode.window.showQuickPick(['Yes', 'No'], {
    placeHolder: 'Add models now?',
  });

  if (addModels === 'Yes') {
    await addModelsInteractive(providerConfig);
  }

  // Save provider
  const success = await configManager.addProvider(providerId, providerConfig);
  if (success) {
    vscode.window.showInformationMessage(`Provider "${providerId}" added successfully.`);
  }
}

/**
 * Interactive edit provider
 */
async function editProviderInteractive(configManager: ConfigManager): Promise<void> {
  const providers = configManager.getProviders();

  if (providers.length === 0) {
    vscode.window.showInformationMessage('No providers configured. Add a provider first.');
    return;
  }

  // Select provider to edit
  const selected = await vscode.window.showQuickPick(
    providers.map((p) => ({ label: `${p.name} (${p.id})`, providerId: p.id })),
    { placeHolder: 'Select a provider to edit' }
  );

  if (!selected) {
    return;
  }

  const provider = configManager.getProvider(selected.providerId);
  if (!provider) {
    vscode.window.showErrorMessage(`Provider "${selected.providerId}" not found.`);
    return;
  }

  // Edit options
  const action = await vscode.window.showQuickPick(
    [
      { label: 'Edit Name', action: 'name' },
      { label: 'Edit Base URL', action: 'baseURL' },
      { label: 'Edit API Key', action: 'apiKey' },
      { label: 'Add Model', action: 'addModel' },
      { label: 'Remove Model', action: 'removeModel' },
      { label: 'Open Settings.json', action: 'openSettings' },
    ],
    { placeHolder: `Edit ${provider.name}` }
  );

  if (!action) {
    return;
  }

  // TODO: Implement edit actions
  vscode.window.showInformationMessage(`Action "${action.label}" selected. Opening settings.json...`);
  await configManager.openConfiguration();
}

/**
 * Interactive remove provider
 */
async function removeProviderInteractive(configManager: ConfigManager): Promise<void> {
  const providers = configManager.getProviders();

  if (providers.length === 0) {
    vscode.window.showInformationMessage('No providers to remove.');
    return;
  }

  // Select provider to remove
  const selected = await vscode.window.showQuickPick(
    providers.map((p) => ({ label: `${p.name} (${p.id})`, providerId: p.id })),
    { placeHolder: 'Select a provider to remove' }
  );

  if (!selected) {
    return;
  }

  await configManager.removeProvider(selected.providerId);
}

/**
 * Interactive add models to provider
 */
async function addModelsInteractive(providerConfig: ProviderConfig): Promise<void> {
  // Ensure models object exists
  if (!providerConfig.models) {
    providerConfig.models = {};
  }

  while (true) {
    const modelId = await vscode.window.showInputBox({
      prompt: 'Enter model ID (or Cancel to finish)',
      placeHolder: 'e.g., gpt-4, llama3-70b',
    });

    if (!modelId) {
      break;
    }

    const modelName = await vscode.window.showInputBox({
      prompt: 'Enter model display name',
      placeHolder: 'e.g., GPT-4',
      value: modelId,
    });

    if (!modelName) {
      continue;
    }

    const contextStr = await vscode.window.showInputBox({
      prompt: 'Enter context window size (tokens)',
      placeHolder: '32768',
      value: '32768',
      validateInput: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) {
          return 'Must be a positive number';
        }
        return null;
      },
    });

    if (!contextStr) {
      continue;
    }

    const outputStr = await vscode.window.showInputBox({
      prompt: 'Enter max output tokens',
      placeHolder: '4096',
      value: '4096',
      validateInput: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) {
          return 'Must be a positive number';
        }
        return null;
      },
    });

    if (!outputStr) {
      continue;
    }

    const modelConfig: ModelConfig = {
      name: modelName,
      modalities: {
        input: ['text'],
        output: ['text'],
      },
      limit: {
        context: parseInt(contextStr, 10),
        output: parseInt(outputStr, 10),
      },
      capabilities: {
        toolCalling: true,
        vision: false,
      },
    };

    providerConfig.models[modelId] = modelConfig;

    const addMore = await vscode.window.showQuickPick(['Yes', 'No'], {
      placeHolder: 'Add another model?',
    });

    if (addMore !== 'Yes') {
      break;
    }
  }
}
