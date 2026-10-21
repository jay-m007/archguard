import fg from "fast-glob";
import { ALWAYS_EXCLUDE } from "./config.js";
import type { ArchGuardConfig } from "./types.js";

/**
 * Finds every source file in the project that should become a graph node.
 * Returns POSIX paths relative to `root`, sorted for deterministic output.
 */
export async function discoverFiles(root: string, config: ArchGuardConfig): Promise<string[]> {
  const files = await fg(config.include, {
    cwd: root,
    ignore: [...ALWAYS_EXCLUDE, ...config.exclude],
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  return files.sort();
}
