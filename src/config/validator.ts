/**
 * Configuration validation utilities
 */

import { ValidationResult, ValidationError } from './types';

/**
 * Validate a URL string
 */
export function validateUrl(url: string, path: string): ValidationError | null {
  try {
    new URL(url);
    return null;
  } catch {
    return {
      path,
      message: `Invalid URL: ${url}`,
    };
  }
}

/**
 * Validate a model ID (alphanumeric, dots, dashes, underscores)
 */
export function validateModelId(id: string, path: string): ValidationError | null {
  if (!/^[a-zA-Z0-9_.-]+$/.test(id)) {
    return {
      path,
      message: `Invalid model ID "${id}". Must match pattern: ^[a-zA-Z0-9_.-]+$`,
    };
  }
  return null;
}

/**
 * Validate a provider ID (alphanumeric, dashes, underscores)
 */
export function validateProviderId(id: string, path: string): ValidationError | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return {
      path,
      message: `Invalid provider ID "${id}". Must match pattern: ^[a-zA-Z0-9_-]+$`,
    };
  }
  return null;
}

/**
 * Validate that required fields exist
 */
export function validateRequired<T>(
  obj: T | undefined | null,
  field: string,
  path: string
): ValidationError | null {
  if (obj === undefined || obj === null) {
    return {
      path,
      message: `Missing required field: ${field}`,
    };
  }
  return null;
}

/**
 * Validate number is positive
 */
export function validatePositiveNumber(
  value: number | undefined,
  field: string,
  path: string
): ValidationError | null {
  if (value === undefined || value === null) {
    return null; // Let required validator handle this
  }
  if (typeof value !== 'number' || value <= 0) {
    return {
      path,
      message: `Field "${field}" must be a positive number`,
    };
  }
  return null;
}

/**
 * Validate modalities
 */
export function validateModalities(
  modalities: { input?: string[]; output?: string[] } | undefined,
  path: string
): ValidationError | null {
  if (!modalities) {
    return null;
  }

  const validModalities = ['text', 'image', 'audio'];

  if (modalities.input) {
    for (const mod of modalities.input) {
      if (!validModalities.includes(mod)) {
        return {
          path: `${path}.input`,
          message: `Invalid input modality: ${mod}. Must be one of: ${validModalities.join(', ')}`,
        };
      }
    }
  }

  if (modalities.output) {
    for (const mod of modalities.output) {
      if (!validModalities.includes(mod)) {
        return {
          path: `${path}.output`,
          message: `Invalid output modality: ${mod}. Must be one of: ${validModalities.join(', ')}`,
        };
      }
    }
  }

  return null;
}

/**
 * Validate config mode
 */
export function validateConfigMode(
  mode: string | undefined,
  path: string
): ValidationError | null {
  if (!mode) {
    return null;
  }

  const validModes = ['config-only', 'config-priority', 'api-priority'];
  if (!validModes.includes(mode)) {
    return {
      path,
      message: `Invalid config mode: ${mode}. Must be one of: ${validModes.join(', ')}`,
    };
  }

  return null;
}

/**
 * Validate complete provider configuration
 */
export function validateProviderConfig(
  providerId: string,
  config: unknown,
  path: string
): ValidationResult {
  const errors: ValidationError[] = [];

  // Validate provider ID
  const idError = validateProviderId(providerId, `${path}.${providerId}`);
  if (idError) {
    errors.push(idError);
  }

  if (typeof config !== 'object' || config === null) {
    return {
      valid: false,
      errors: [...errors, { path: `${path}.${providerId}`, message: 'Provider config must be an object' }],
    };
  }

  const provider = config as Record<string, unknown>;

  // Validate required fields
  if (!provider.name || typeof provider.name !== 'string') {
    errors.push({ path: `${path}.${providerId}.name`, message: 'Provider name is required and must be a string' });
  }

  if (!provider.baseURL || typeof provider.baseURL !== 'string') {
    errors.push({ path: `${path}.${providerId}.baseURL`, message: 'Provider baseURL is required and must be a string' });
  } else {
    const urlError = validateUrl(provider.baseURL, `${path}.${providerId}.baseURL`);
    if (urlError) {
      errors.push(urlError);
    }
  }

  if (!provider.models || typeof provider.models !== 'object') {
    errors.push({ path: `${path}.${providerId}.models`, message: 'Provider models is required and must be an object' });
  } else {
    // Validate each model
    const models = provider.models as Record<string, unknown>;
    for (const [modelId, modelConfig] of Object.entries(models)) {
      const modelResult = validateModelConfig(modelId, modelConfig, `${path}.${providerId}.models`);
      errors.push(...modelResult.errors);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate single model configuration
 */
export function validateModelConfig(
  modelId: string,
  config: unknown,
  path: string
): ValidationResult {
  const errors: ValidationError[] = [];

  // Validate model ID
  const idError = validateModelId(modelId, `${path}.${modelId}`);
  if (idError) {
    errors.push(idError);
  }

  if (typeof config !== 'object' || config === null) {
    return {
      valid: false,
      errors: [...errors, { path: `${path}.${modelId}`, message: 'Model config must be an object' }],
    };
  }

  const model = config as Record<string, unknown>;

  // Validate required fields
  if (!model.name || typeof model.name !== 'string') {
    errors.push({ path: `${path}.${modelId}.name`, message: 'Model name is required and must be a string' });
  }

  // Validate limit
  if (!model.limit || typeof model.limit !== 'object') {
    errors.push({ path: `${path}.${modelId}.limit`, message: 'Model limit is required and must be an object' });
  } else {
    const limit = model.limit as Record<string, unknown>;

    const contextError = validatePositiveNumber(limit.context as number, 'context', `${path}.${modelId}.limit.context`);
    if (contextError) {
      errors.push(contextError);
    }

    const outputError = validatePositiveNumber(limit.output as number, 'output', `${path}.${modelId}.limit.output`);
    if (outputError) {
      errors.push(outputError);
    }
  }

  // Validate modalities if present
  if (model.modalities) {
    const modalitiesError = validateModalities(
      model.modalities as { input?: string[]; output?: string[] },
      `${path}.${modelId}.modalities`
    );
    if (modalitiesError) {
      errors.push(modalitiesError);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate complete multi-provider configuration
 */
export function validateMultiProviderConfig(config: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (typeof config !== 'object' || config === null) {
    return {
      valid: false,
      errors: [{ path: '', message: 'Configuration must be an object' }],
    };
  }

  const multiConfig = config as Record<string, unknown>;

  // Validate providers
  if (!multiConfig.providers || typeof multiConfig.providers !== 'object') {
    errors.push({ path: 'providers', message: 'Providers is required and must be an object' });
  } else {
    const providers = multiConfig.providers as Record<string, unknown>;
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      const providerResult = validateProviderConfig(providerId, providerConfig, 'providers');
      errors.push(...providerResult.errors);
    }
  }

  // Validate configMode if present
  if (multiConfig.configMode !== undefined) {
    const modeError = validateConfigMode(multiConfig.configMode as string, 'configMode');
    if (modeError) {
      errors.push(modeError);
    }
  }

  // Validate showProviderPrefix if present
  if (multiConfig.showProviderPrefix !== undefined && typeof multiConfig.showProviderPrefix !== 'boolean') {
    errors.push({ path: 'showProviderPrefix', message: 'showProviderPrefix must be a boolean' });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Format validation errors for display
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map(e => `${e.path}: ${e.message}`).join('\n');
}
