// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Run a git command and return trimmed stdout.
 * Throws on non-zero exit with stderr message.
 * Handles git-not-installed and not-a-repo errors gracefully.
 */
export async function git(args: string[], cwd?: string): Promise<string> {
  let proc;
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd: cwd ?? process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such file') || msg.includes('not found') || msg.includes('ENOENT')) {
      throw new Error('git is not installed or not found in PATH');
    }
    throw new Error(`Failed to spawn git: ${msg}`);
  }

  const exitCode = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    const trimmed = stderr.trim();
    if (trimmed.includes('not a git repository')) {
      throw new Error('Not a git repository (or any parent up to mount point)');
    }
    if (trimmed.includes('does not have any commits')) {
      throw new Error('Git repository has no commits yet');
    }
    throw new Error(`git exited with code ${exitCode}: ${trimmed || '(no stderr)'}`);
  }

  return (await new Response(proc.stdout).text()).trim();
}
