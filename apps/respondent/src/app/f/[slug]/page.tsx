import type { FormDefinition } from "@workeasy/form-schema";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicForm } from "./public-form";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";

type Loaded =
  | { kind: "open"; versionId: string; definition: FormDefinition }
  | { kind: "closed" }
  | { kind: "missing" }
  | { kind: "unavailable" };

/** One request per page render, shared by the metadata and the page. */
const loadForm = cache(async (slug: string): Promise<Loaded> => {
  let res: Response;
  try {
    // Always ask the API: its short Cache-Control is for CDNs, and closing must show on the next load.
    res = await fetch(`${apiInternalUrl}/public/v1/forms/${encodeURIComponent(slug)}`, { cache: "no-store" });
  } catch {
    return { kind: "unavailable" };
  }
  if (res.status === 404) return { kind: "missing" };
  if (res.status === 410) return { kind: "closed" };
  if (!res.ok) return { kind: "unavailable" };
  const body = (await res.json()) as { versionId: string; definition: FormDefinition };
  return { kind: "open", versionId: body.versionId, definition: body.definition };
});

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const loaded = await loadForm((await params).slug);
  return {
    title: loaded.kind === "open" ? loaded.definition.title : "Workeasy Forms",
    // Forms are shared by link; they should not appear in search results.
    robots: { index: false, follow: false },
  };
}

function Notice({ title, children, embed }: { title: string; children: React.ReactNode; embed: boolean }) {
  return (
    <main className={embed ? "r-embed" : "r-page"}>
      <h1 style={{ fontSize: 24, margin: "0 0 8px" }}>{title}</h1>
      <p style={{ margin: 0 }}>{children}</p>
    </main>
  );
}

export default async function FormPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const embed = (await searchParams).embed === "1";
  const loaded = await loadForm(slug);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "closed") {
    return (
      <Notice title="This form is closed" embed={embed}>
        It isn&apos;t accepting responses any more. If you think this is a mistake, contact whoever shared it with you.
      </Notice>
    );
  }
  if (loaded.kind === "unavailable") {
    return (
      <Notice title="We couldn't load this form" embed={embed}>
        Please try again in a moment.
      </Notice>
    );
  }
  return <PublicForm slug={slug} versionId={loaded.versionId} definition={loaded.definition} embed={embed} />;
}
