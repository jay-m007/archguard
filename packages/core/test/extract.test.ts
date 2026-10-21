import { describe, expect, it } from "vitest";
import { extractImports } from "../src/extract.js";

const specs = (file: string, code: string) => extractImports(file, code).map((i) => [i.specifier, i.kind, i.typeOnly]);

describe("extractImports", () => {
  it("finds static, side-effect, re-export, dynamic and require imports", () => {
    const code = `
      import React from "react";
      import "./polyfill";
      export * from "./all";
      export { a } from "./named";
      const lazy = () => import("./lazy");
      const fs = require("fs");
      import legacy = require("./legacy");
    `;
    expect(specs("x.ts", code)).toEqual([
      ["react", "static", false],
      ["./polyfill", "side-effect", false],
      ["./all", "re-export", false],
      ["./named", "re-export", false],
      ["./lazy", "dynamic", false],
      ["fs", "require", false],
      ["./legacy", "import-equals", false],
    ]);
  });

  it("marks type-only imports and exports", () => {
    const code = `
      import type { A } from "./a";
      import { type B, type C } from "./bc";
      import { type D, e } from "./de";
      export type { F } from "./f";
      export { type G } from "./g";
      type H = import("./h").H;
    `;
    expect(specs("x.ts", code)).toEqual([
      ["./a", "static", true],
      ["./bc", "static", true],
      ["./de", "static", false], // mixed: `e` is a runtime value
      ["./f", "re-export", true],
      ["./g", "re-export", true],
      ["./h", "import-type", true],
    ]);
  });

  it("ignores imports that appear only in comments and strings", () => {
    const code = `
      // import x from "./commented";
      /* require("./block") */
      const s = "import y from './string'";
    `;
    expect(extractImports("x.ts", code)).toEqual([]);
  });

  it("parses JSX/TSX files and template-literal specifiers", () => {
    const code = "import { Button } from './Button';\nconst C = () => <Button />;\nimport(`./page`);";
    expect(specs("x.tsx", code)).toEqual([
      ["./Button", "static", false],
      ["./page", "dynamic", false],
    ]);
  });

  it("ignores dynamic imports with computed specifiers", () => {
    expect(extractImports("x.ts", "const n = 'a'; import(`./${n}`); require(n);")).toEqual([]);
  });

  it("reports 1-based line numbers", () => {
    const [imp] = extractImports("x.ts", "\n\nimport a from './a';");
    expect(imp.line).toBe(3);
  });
});
