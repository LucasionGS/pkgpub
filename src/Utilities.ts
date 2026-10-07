import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import Path from "node:path";
import Log from "./Log";

export interface RunOptions {
  cwd?: string;
  /**
   * Extra environment variables, merged into the extension host's environment.
   */
  env?: Record<string, string>;
  /**
   * Don't log the command and its output to the output channel.
   */
  quiet?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command without a shell and collect its output. Never rejects because of the exit code, only when the
 * command can't be started at all.
 */
export function run(command: string, args: string[], opts?: RunOptions): Promise<RunResult> {
  opts ??= {};
  if (!opts.quiet) Log.command(opts.cwd, command, args);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (!opts.quiet) Log.output(data.toString());
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (!opts.quiet) Log.output(data.toString());
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`\`${command}\` was not found. Make sure it is installed and on your PATH.`));
      }
      else {
        reject(error);
      }
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Like `run()`, but throws when the command exits with a non-zero code. The error message is `failMessage`
 * followed by the last line of the command's error output.
 */
export async function runChecked(command: string, args: string[], failMessage: string, opts?: RunOptions): Promise<RunResult> {
  const result = await run(command, args, opts);
  if (result.code !== 0) {
    const reason = lastLine(result.stderr) || lastLine(result.stdout);
    throw new Error(reason ? `${failMessage}: ${reason}` : `${failMessage}.`);
  }
  return result;
}

/**
 * The last non-empty line of `text`, without ANSI colour codes.
 */
export function lastLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/**
 * Check whether a file or folder exists.
 */
export async function exists(path: string): Promise<boolean> {
  return await fsp.stat(path).then(() => true).catch(() => false);
}

/**
 * Expand a leading `~` to the home directory.
 */
export function expandHome(path: string): string {
  if (path === "~") return os.homedir();
  if (path.startsWith("~/")) return Path.join(os.homedir(), path.slice(2));
  return path;
}

/**
 * Quote a value for use inside a shell command line.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Write `text` to `path` only if the file's content differs. Returns whether it was written.
 */
export async function writeIfChanged(path: string, text: string): Promise<boolean> {
  const current = await fsp.readFile(path, "utf8").catch(() => null);
  if (current === text) return false;
  await fsp.writeFile(path, text);
  return true;
}
