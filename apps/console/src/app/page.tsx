import { SessionPanel } from "./session-panel";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { signin } = await searchParams;
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "var(--we-space-6) var(--we-space-2)" }}>
      <h1 style={{ margin: 0, fontSize: 28 }}>Workeasy Forms</h1>
      <SessionPanel signInFailed={signin === "failed"} />
    </main>
  );
}
