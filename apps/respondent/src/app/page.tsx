import { BrandMark, PRODUCT_LINE } from "@workeasy/ui/react";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "var(--we-space-12) var(--we-space-4)", display: "grid", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <BrandMark size={40} />
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, lineHeight: 1.15 }}>
          Workeasy
          <small style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--we-color-textMuted)" }}>{PRODUCT_LINE}</small>
        </h1>
      </div>
      <p style={{ margin: 0, color: "var(--we-color-textMuted)" }}>Open the form link you were given to get started.</p>
    </main>
  );
}
