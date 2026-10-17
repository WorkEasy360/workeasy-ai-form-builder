import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them into the output.
  noExternal: [/^@workeasy\//],
  // Their CommonJS dependencies (pg, nodemailer) are bundled too, and call
  // require() for Node built-ins, which ESM output does not define.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
