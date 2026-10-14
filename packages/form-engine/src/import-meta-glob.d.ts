// Vite's import.meta.glob, used by the shared corpus tests in both Node and
// browser runs. Declared locally so the package needs no Vite type dependency.
interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { eager: true; import?: string }): Record<string, T>;
}
