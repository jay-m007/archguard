import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { ALWAYS_EXCLUDE, OUTPUT_DIRS } from "./config.js";
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
  const isOutput = createOutputDirCheck(root);
  return files.filter((f) => !isOutput(f)).sort();
}

/**
 * Returns a predicate telling whether a file lives inside a build-output folder
 * (dist/, build/, out/, coverage/) that sits next to a package.json. Those hold
 * compiled copies of the source and would duplicate every module in the graph,
 * whereas a folder like src/lib/build/ is real source and is kept.
 */
function createOutputDirCheck(root: string): (file: string) => boolean {
  const cache = new Map<string, boolean>();
  const hasPackageJson = (dir: string) => {
    if (!cache.has(dir)) cache.set(dir, fs.existsSync(path.join(root, dir, "package.json")));
    return cache.get(dir)!;
  };

  return (file) => {
    const parts = file.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      if (OUTPUT_DIRS.includes(parts[i]) && hasPackageJson(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  };
}
