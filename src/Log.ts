import * as vscode from "vscode";

/**
 * The `pkgpub` output channel. Every command pkgpub runs in the background is logged here.
 */
export namespace Log {
  let _channel: vscode.OutputChannel | null = null;

  /**
   * The output channel, created on first use.
   */
  export function channel(): vscode.OutputChannel {
    _channel ??= vscode.window.createOutputChannel("pkgpub");
    return _channel;
  }

  /**
   * Write a line to the output channel.
   */
  export function info(message: string) {
    channel().appendLine(message);
  }

  /**
   * Write raw process output to the output channel.
   */
  export function output(text: string) {
    channel().append(text);
  }

  /**
   * Log a command line before it runs.
   */
  export function command(cwd: string | undefined, command: string, args: string[]) {
    const line = [command, ...args.map(quote)].join(" ");
    info(cwd ? `$ (${cwd}) ${line}` : `$ ${line}`);
  }

  /**
   * Bring the output channel into view.
   */
  export function show() {
    channel().show(true);
  }

  function quote(arg: string) {
    return /^[\w./=:@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
  }
}

export default Log;
