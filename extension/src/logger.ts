import * as vscode from 'vscode';

/**
 * Canal de log do Prometheon. Usa um LogOutputChannel, então o nível de detalhe
 * é controlado pelo próprio VS Code (comando "Developer: Set Log Level...").
 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Prometheon', { log: true });
  }

  debug(message: string, ...args: unknown[]): void {
    this.channel.debug(message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.channel.info(message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(message, ...args);
  }

  error(message: string | Error, ...args: unknown[]): void {
    this.channel.error(message, ...args);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
