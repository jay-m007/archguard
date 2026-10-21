import type { ScoreBreakdown, Violation } from "./types.js";

/** Penalty weights per issue. Cycles hurt most: they block refactoring and tree-shaking. */
export const WEIGHTS = {
  fileInCycle: 10,
  layerViolation: 5,
  godFile: 3,
  orphanFile: 0.5,
} as const;

/**
 * Architecture health score.
 *
 *   driftPoints = 10·(files in cycles) + 5·(layer violations) + 3·(god files) + 0.5·(orphans)
 *   density     = driftPoints / (number of files)
 *   health      = 100 / (1 + density)
 *
 * Normalising by file count makes scores comparable between a 20-file and a
 * 2,000-file project. The 100/(1+x) curve gives 100 for a clean codebase, 50 when
 * there is one drift point per file, and approaches 0 without going negative.
 */
export function computeScore(fileCount: number, filesInCycles: number, violations: Violation[]): ScoreBreakdown {
  const count = (type: Violation["type"]) => violations.filter((v) => v.type === type).length;
  const layerViolations = count("layer-violation");
  const godFiles = count("god-file");
  const orphanFiles = count("orphan-file");

  const driftPoints =
    WEIGHTS.fileInCycle * filesInCycles +
    WEIGHTS.layerViolation * layerViolations +
    WEIGHTS.godFile * godFiles +
    WEIGHTS.orphanFile * orphanFiles;

  const density = driftPoints / Math.max(fileCount, 1);
  const health = Math.round(100 / (1 + density));

  return {
    health,
    driftPoints,
    filesInCycles,
    layerViolations,
    godFiles,
    orphanFiles,
    grade: health >= 90 ? "A" : health >= 75 ? "B" : health >= 60 ? "C" : health >= 40 ? "D" : "F",
  };
}
