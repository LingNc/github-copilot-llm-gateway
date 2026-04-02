/**
 * Log service for structured logging with levels
 * Supports: error, warning, info, debug
 */

import * as vscode from 'vscode';

export type LogLevel = 'error' | 'warning' | 'info' | 'debug';

interface LogOptions {
  level: LogLevel;
  showTimestamp: boolean;
  detailedToolInfo: boolean;
}

export class LogService {
  private outputChannel: vscode.OutputChannel;
  private options: LogOptions;

  constructor(
    outputChannel: vscode.OutputChannel,
    options: Partial<LogOptions> = {}
  ) {
    this.outputChannel = outputChannel;
    this.options = {
      level: options.level || 'info',
      showTimestamp: options.showTimestamp ?? false,
      detailedToolInfo: options.detailedToolInfo ?? false,
    };
  }

  /**
   * Update log options from configuration
   */
  public updateOptions(options: Partial<LogOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current log level
   */
  public getLevel(): LogLevel {
    return this.options.level;
  }

  /**
   * Check if a level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['error', 'warning', 'info', 'debug'];
    const currentIndex = levels.indexOf(this.options.level);
    const messageIndex = levels.indexOf(level);
    return messageIndex <= currentIndex;
  }

  /**
   * Format log message with prefix and optional timestamp
   */
  private formatMessage(level: LogLevel, tag: string, message: string): string {
    const parts: string[] = [];

    if (this.options.showTimestamp) {
      const now = new Date();
      const timestamp = now.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      parts.push(`[${timestamp}]`);
    }

    parts.push(`[${tag}]`);
    parts.push(message);

    return parts.join(' ');
  }

  /**
   * Log error message
   */
  public error(tag: string, message: string): void {
    if (this.shouldLog('error')) {
      this.outputChannel.appendLine(this.formatMessage('error', tag, message));
    }
  }

  /**
   * Log warning message
   */
  public warning(tag: string, message: string): void {
    if (this.shouldLog('warning')) {
      this.outputChannel.appendLine(this.formatMessage('warning', tag, message));
    }
  }

  /**
   * Log info message
   */
  public info(tag: string, message: string): void {
    if (this.shouldLog('info')) {
      this.outputChannel.appendLine(this.formatMessage('info', tag, message));
    }
  }

  /**
   * Log debug message
   */
  public debug(tag: string, message: string): void {
    if (this.shouldLog('debug')) {
      this.outputChannel.appendLine(this.formatMessage('debug', tag, message));
    }
  }

  /**
   * Check if detailed tool info should be shown
   */
  public shouldShowDetailedToolInfo(): boolean {
    return this.options.detailedToolInfo;
  }

  /**
   * Log tool information (simplified or detailed)
   */
  public logTools(
    tag: string,
    tools: Array<{ name: string; description?: string }>,
    parallel: boolean
  ): void {
    if (!this.shouldLog('info')) return;

    const toolNames = tools.map(t => t.name).join(', ');
    this.info(tag, `发送 ${tools.length} 个工具 (parallel: ${parallel})`);

    if (this.options.detailedToolInfo && this.shouldLog('debug')) {
      this.debug(tag, `工具列表: ${toolNames}`);
      for (const tool of tools.slice(0, 3)) {
        this.debug(tag, `  - ${tool.name}: ${tool.description || '无描述'}`);
      }
      if (tools.length > 3) {
        this.debug(tag, `  ... 还有 ${tools.length - 3} 个工具`);
      }
    } else if (tools.length > 0) {
      // 显示前3个工具作为示例
      const examples = tools.slice(0, 3).map(t => t.name).join(', ');
      this.info(tag, `示例: ${examples}${tools.length > 3 ? ` ... 还有 ${tools.length - 3} 个` : ''}`);
    }
  }

  /**
   * Log request information
   */
  public logRequest(method: string, url: string, body?: unknown): void {
    if (!this.shouldLog('info')) return;

    this.info('Request', `${method} ${url}`);

    if (body && this.shouldLog('debug')) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      // 限制长度
      const truncated = bodyStr.length > 500 ? bodyStr.substring(0, 500) + '...' : bodyStr;
      this.debug('Request', `Body: ${truncated}`);
    }
  }

  /**
   * Log response information
   */
  public logResponse(status: number, statusText: string, body?: unknown): void {
    if (!this.shouldLog('info')) return;

    const statusTag = status >= 400 ? 'Error' : 'Response';
    this.info(statusTag, `HTTP ${status} ${statusText}`);

    if (body && this.shouldLog('debug')) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      const truncated = bodyStr.length > 500 ? bodyStr.substring(0, 500) + '...' : bodyStr;
      this.debug('Response', `Body: ${truncated}`);
    }
  }

  /**
   * Log token statistics
   */
  public logTokens(used: number, max: number, details?: string): void {
    if (!this.shouldLog('info')) return;

    const percentage = Math.round((used / max) * 100);
    this.info('Token', `${used}/${max} (${percentage}%)${details ? ` - ${details}` : ''}`);
  }

  /**
   * Log configuration information
   */
  public logConfig(message: string): void {
    this.info('Config', message);
  }
}
