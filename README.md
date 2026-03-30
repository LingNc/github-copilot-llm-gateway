# GitHub Copilot LLM Gateway

![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/AndrewButson.github-copilot-llm-gateway)
![.github/workflows/codeql-analysis](https://github.com/arbs-io/github-copilot-llm-gateway/actions/workflows/codeql-analysis.yml/badge.svg)
![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/AndrewButson.github-copilot-llm-gateway)
[![GitHub issues](https://img.shields.io/github/issues/arbs-io/github-copilot-llm-gateway.svg)](https://github.com/arbs-io/github-copilot-llm-gateway/issues)
![Visual Studio Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/AndrewButson.github-copilot-llm-gateway)

[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=arbs-io_github-copilot-llm-gateway&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=arbs-io_github-copilot-llm-gateway)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=arbs-io_github-copilot-llm-gateway&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=arbs-io_github-copilot-llm-gateway)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=arbs-io_github-copilot-llm-gateway&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=arbs-io_github-copilot-llm-gateway)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=arbs-io_github-copilot-llm-gateway&metric=bugs)](https://sonarcloud.io/summary/new_code?id=arbs-io_github-copilot-llm-gateway)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=arbs-io_github-copilot-llm-gateway&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=arbs-io_github-copilot-llm-gateway)

Extend GitHub Copilot with open-source language models running on your own infrastructure.

## About

**GitHub Copilot LLM Gateway** is a companion extension for GitHub Copilot that adds support for self-hosted open-source models. It seamlessly integrates with the Copilot chat experience, allowing you to use models like Qwen, Llama, and Mistral alongside—or instead of—the default Copilot models.

**New in this version:** Multi-provider configuration support! You can now configure multiple inference servers simultaneously (e.g., local vLLM + remote API) and switch between them in Copilot Chat.

This extension connects to any **OpenAI-compatible inference server**, giving you complete control over your AI-assisted development environment.

### Key Benefits

| Benefit                | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| **Data Sovereignty**   | Your code never leaves your network. All inference happens on your own hardware. |
| **Zero API Costs**     | No per-token fees. Use your GPU resources without usage limits.                  |
| **Model Choice**       | Access thousands of open-source models from Hugging Face and beyond.             |
| **Multi-Provider**     | Configure multiple inference servers and switch between them easily.             |
| **Offline Capable**    | Work without internet once models are downloaded.                                |
| **Full Customization** | Fine-tune models for your specific codebase or domain.                           |

### Compatible Inference Servers

- [vLLM](https://github.com/vllm-project/vllm) — High-performance inference (recommended)
- [Ollama](https://ollama.ai/) — Easy local deployment
- [llama.cpp](https://github.com/ggml-org/llama.cpp) — CPU and GPU inference
- [Text Generation Inference](https://github.com/huggingface/text-generation-inference) — Hugging Face's server
- [LocalAI](https://localai.io/) — OpenAI API drop-in replacement
- Any OpenAI Chat Completions API-compatible endpoint

## Getting Started

### Prerequisites

- **VS Code** 1.106.0 or later
- **GitHub Copilot** extension installed and signed in
- **Inference server(s)** running with an OpenAI-compatible API

### Step 1: Install the Extension

#### Option A: Build and Install from Source (Development)

1. Clone this repository:
```bash
git clone https://github.com/arbs-io/github-copilot-llm-gateway.git
cd github-copilot-llm-gateway
```

2. Install dependencies:
```bash
npm install
```

3. Build the extension:
```bash
npm run package
```

4. This creates `github-copilot-llm-gateway-1.0.0.vsix`

5. In VS Code, open the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
6. Click the `...` menu (top-right) → **Install from VSIX**
7. Select the generated `.vsix` file

#### Option B: Development Mode (Hot Reload)

1. Open this project in VS Code
2. Press `F5` to launch Extension Development Host
3. This opens a new VS Code window with the extension loaded

### Step 2: Start Your Inference Server

Launch your inference server with tool calling enabled. Example using vLLM:

```bash
vllm serve Qwen/Qwen3-8B \
    --enable-auto-tool-choice \
    --tool-call-parser hermes \
    --max-model-len 32768 \
    --gpu-memory-utilization 0.95 \
    --host 0.0.0.0 \
    --port 42069
```

Verify the server is running:

```bash
curl http://localhost:42069/v1/models
```

### Step 3: Configure the Extension

The extension uses a **multi-provider configuration** system. Open VS Code Settings (`Ctrl+,` / `Cmd+,`) and search for **"Copilot LLM Gateway"**.

Open `settings.json` (`Ctrl+Shift+P` → "Preferences: Open User Settings (JSON)") and add your providers:

```json
{
  "github.copilot.llm-gateway.providers": {
    "local-vllm": {
      "name": "本地 vLLM",
      "baseURL": "http://localhost:42069",
      "models": {
        "Qwen3-8B": {
          "name": "Qwen 3 8B",
          "modalities": {
            "input": ["text"],
            "output": ["text"]
          },
          "limit": {
            "context": 32768,
            "output": 4096
          },
          "capabilities": {
            "toolCalling": true,
            "vision": false
          }
        }
      }
    }
  },
  "github.copilot.llm-gateway.showProviderPrefix": false,
  "github.copilot.llm-gateway.configMode": "config-priority"
}
```

**Configuration modes:**
- `config-only` - Only use configured models (for APIs without `/v1/models`)
- `config-priority` - Configured models override API models (recommended)
- `api-priority` - API models with config as fallback

### Step 4: Select Your Model in Copilot Chat

1. Open **GitHub Copilot Chat** (`Ctrl+Alt+I` / `Cmd+Alt+I`)
2. Click the **model selector** dropdown
3. Each configured provider appears as a separate entry
4. Select a model from your provider and start chatting!

### Step 5: Start Chatting

Your self-hosted models now appear in Copilot Chat. Select one and start coding with AI assistance!

## Configuration Reference

### Provider Configuration

```json
{
  "github.copilot.llm-gateway.providers": {
    "<provider-id>": {
      "name": "Display Name",
      "baseURL": "http://localhost:8000",
      "apiKey": "optional-api-key",
      "models": {
        "<model-id>": {
          "name": "Model Display Name",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 32768,
            "output": 4096
          },
          "capabilities": {
            "toolCalling": true,
            "vision": true
          }
        }
      }
    }
  }
}
```

### Model Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name for the model |
| `modalities.input` | string[] | Input types: `["text"]`, `["text", "image"]` |
| `modalities.output` | string[] | Output types: `["text"]` |
| `limit.context` | number | Maximum context tokens |
| `limit.output` | number | Maximum output tokens |
| `capabilities.toolCalling` | boolean | Enable tool calling |
| `capabilities.vision` | boolean | Enable vision support |

### Global Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `showProviderPrefix` | boolean | `true` | Show provider prefix in model selector |
| `providerNameStyle` | string | `"slash"` | Provider name display style: `"slash"` (provider/model) or `"bracket"` ([provider] model) |
| `configMode` | string | `"config-priority"` | Model source mode |
| `requestTimeout` | number | `60000` | Request timeout in ms |
| `parallelToolCalling` | boolean | `true` | Allow parallel tool calls |
| `agentTemperature` | number | `0.0` | Temperature for tool mode |

## Commands

Access from Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command | Description |
|---------|-------------|
| **LLM Gateway: Test Server Connection** | Test connectivity and list models |
| **LLM Gateway: Open Configuration** | Open settings.json |
| **LLM Gateway: Reload Configuration** | Reload providers without restart |
| **LLM Gateway: Add Provider** | Interactive provider creation |
| **LLM Gateway: Remove Provider** | Remove a configured provider |

## Troubleshooting

### Model not appearing in Copilot

1. Verify server is running: `curl http://your-server:port/v1/models`
2. Check configuration in settings.json
3. Run **"LLM Gateway: Test Server Connection"** command
4. Run **"LLM Gateway: Reload Configuration"** to refresh

### Extension not loading

1. Check Output panel (`Ctrl+Shift+U`) → Select "GitHub Copilot LLM Gateway"
2. Look for configuration validation errors
3. Verify JSON syntax in settings.json

### "Model returned empty response"

1. **Check tool parser** — Ensure `--tool-call-parser` matches your model
2. **Disable tool calling** — Set `enableToolCalling: false` in model config
3. **Reduce context** — Conversation may exceed model's limit

## Recommended Models

These models have been tested with good tool calling support:

| Model | VRAM | Tool Support | Best For |
|-------|------|--------------|----------|
| **Qwen/Qwen3-8B** | ~16GB | Excellent | General coding |
| **Qwen/Qwen2.5-7B-Instruct** | ~14GB | Excellent | Balanced performance |
| **Qwen/Qwen2.5-14B-Instruct** | ~28GB | Excellent | Higher quality |

## Support

- **Issues & Feature Requests**: [GitHub Issues](https://github.com/arbs-io/github-copilot-llm-gateway/issues)
- **Discussions**: [GitHub Discussions](https://github.com/arbs-io/github-copilot-llm-gateway/discussions)

## License

MIT License — see [LICENSE](LICENSE) for details.

---

_This extension is not affiliated with GitHub or Microsoft. GitHub Copilot is a trademark of GitHub, Inc._
