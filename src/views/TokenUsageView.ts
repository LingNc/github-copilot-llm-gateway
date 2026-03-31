/**
 * Token usage webview view provider
 * Shows detailed token usage information in a sidebar panel
 */

import * as vscode from 'vscode';

interface TokenDetail {
  category: string;
  label: string;
  tokens: number;
  percentage: number;
}

export class TokenUsageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'llmGateway.tokenUsage';

  private _view?: vscode.WebviewView;
  private _currentTokens = 0;
  private _maxTokens = 0;
  private _details: TokenDetail[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'compress':
          await vscode.commands.executeCommand('workbench.action.chat.clear');
          vscode.window.showInformationMessage(
            vscode.l10n.t('token.contextCompressed')
          );
          this.updateData(0, this._maxTokens, []);
          break;
      }
    });

    // Initial update
    this._updateView();
  }

  public updateData(usedTokens: number, maxTokens: number, details: TokenDetail[]): void {
    this._currentTokens = usedTokens;
    this._maxTokens = maxTokens;
    this._details = details;
    this._updateView();
  }

  public show(): void {
    if (this._view) {
      this._view.show();
    } else {
      vscode.commands.executeCommand('llmGateway.tokenUsage.focus');
    }
  }

  private _updateView(): void {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'update',
        usedTokens: this._currentTokens,
        maxTokens: this._maxTokens,
        details: this._details,
        percentage: this._maxTokens > 0
          ? Math.round((this._currentTokens / this._maxTokens) * 100)
          : 0,
        remaining: this._maxTokens - this._currentTokens,
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Use a content security policy that allows loading resources from the extension
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline';">
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            padding: 16px;
            line-height: 1.4;
        }

        .header {
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin-bottom: 8px;
        }

        .token-count {
            font-size: 16px;
            color: var(--vscode-foreground);
            margin-bottom: 4px;
        }

        .percentage {
            font-size: 24px;
            font-weight: 300;
            margin: 8px 0;
        }

        .percentage.high {
            color: var(--vscode-errorForeground);
        }

        .percentage.medium {
            color: var(--vscode-editorWarning-foreground);
        }

        .percentage.low {
            color: var(--vscode-gitDecoration-addedResourceForeground);
        }

        .remaining {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .category {
            margin-top: 16px;
        }

        .category-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            letter-spacing: 0.5px;
        }

        .detail-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .detail-item:last-child {
            border-bottom: none;
        }

        .detail-label {
            font-size: 12px;
            color: var(--vscode-foreground);
        }

        .detail-percentage {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .compress-button {
            margin-top: 24px;
            padding: 8px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }

        .compress-button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .empty-state {
            text-align: center;
            padding: 32px 16px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div id="content">
        <div class='empty-state'>No active chat session</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // Handle messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;

            if (message.type === 'update') {
                updateContent(message);
            }
        });

        function updateContent(data) {
            const content = document.getElementById('content');

            if (data.usedTokens === 0) {
                content.innerHTML = '<div class='empty-state'>No active chat session</div>';
                return;
            }

            const percentageClass = data.percentage > 90 ? 'high' : data.percentage > 70 ? 'medium' : 'low';

            let detailsHtml = '';
            if (data.details && data.details.length > 0) {
                // Group by category
                const byCategory = {};
                for (const detail of data.details) {
                    if (!byCategory[detail.category]) {
                        byCategory[detail.category] = [];
                    }
                    byCategory[detail.category].push(detail);
                }

                for (const [category, items] of Object.entries(byCategory)) {
                    detailsHtml += `<div class='category'>`;
                    detailsHtml += `<div class='category-title'>${escapeHtml(category)}</div>`;
                    for (const item of items) {
                        detailsHtml += `
                            <div class='detail-item'>
                                <span class='detail-label'>${escapeHtml(item.label)}</span>
                                <span class='detail-percentage'>${item.percentage}%</span>
                            </div>
                        `;
                    }
                    detailsHtml += `</div>`;
                }
            }

            content.innerHTML = `
                <div class='header'>
                    <div class='title'>Context Window</div>
                    <div class='token-count'>${formatTokens(data.usedTokens)}/${formatTokens(data.maxTokens)} tokens</div>
                    <div class='percentage ${percentageClass}'>${data.percentage}%</div>
                    <div class='remaining'>${formatTokens(data.remaining)} remaining for response</div>
                </div>
                ${detailsHtml}
                <button class='compress-button' onclick='compressContext()'>
                    <span>Compress Context</span>
                </button>
            `;
        }

        function compressContext() {
            vscode.postMessage({ type: 'compress' });
        }

        function formatTokens(tokens) {
            if (tokens >= 1000) {
                return (tokens / 1000).toFixed(1) + 'K';
            }
            return tokens.toString();
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    </script>
</body>
</html>`;
  }
}
