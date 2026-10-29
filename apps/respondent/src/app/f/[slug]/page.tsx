import type { FormDefinition } from "@workeasy/form-schema";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PublicForm } from "./public-form";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";
/** The respondent sign-in cookie (docs/06 §1); the console's cookie is never forwarded. */
const RESPONDENT_COOKIES = ["__Host-we_respondent", "we_respondent"];

type Loaded =
  | { kind: "open"; versionId: string; definition: FormDefinition }
  | { kind: "closed" }
  | { kind: "full" }
  | { kind: "not_open_yet"; opensAt: string | undefined }
  | { kind: "busy" }
  | { kind: "missing" }
  | { kind: "sign_in"; signInUrl: string }
  | { kind: "not_member" }
  | { kind: "unavailable" };

/** One request per page render, shared by the metadata and the page. */
const loadForm = cache(async (slug: string, embed: boolean): Promise<Loaded> => {
  const jar = await cookies();
  const cookie = RESPONDENT_COOKIES.flatMap((name) => {
    const value = jar.get(name)?.value;
    return value ? [`${name}=${value}`] : [];
  }).join("; ");
  let res: Response;
  try {
    // Always ask the API: its short Cache-Control is for CDNs, and closing must show on the next load.
    res = await fetch(`${apiInternalUrl}/public/v1/forms/${encodeURIComponent(slug)}${embed ? "?embed=1" : ""}`, {
      cache: "no-store",
      headers: cookie ? { cookie } : {},
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (res.status === 404) return { kind: "missing" };
  if (res.status === 410) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string };
    return problem.code === "FORM_FULL" ? { kind: "full" } : { kind: "closed" };
  }
  if (res.status === 409) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; opensAt?: string };
    if (problem.code === "FORM_NOT_OPEN") return { kind: "not_open_yet", opensAt: problem.opensAt };
  }
  if (res.status === 429) return { kind: "busy" };
  if (res.status === 401) {
    const problem = (await res.json().catch(() => ({}))) as { signInUrl?: string };
    return problem.signInUrl ? { kind: "sign_in", signInUrl: problem.signInUrl } : { kind: "unavailable" };
  }
  if (res.status === 403) return { kind: "not_member" };
  if (!res.ok) return { kind: "unavailable" };
  const body = (await res.json()) as { versionId: string; definition: FormDefinition };
  return { kind: "open", versionId: body.versionId, definition: body.definition };
});

/** Rendered on the server, which has no respondent time zone: shown in UTC and labelled so. */
const OPENS_FORMAT = new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" });

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const loaded = await loadForm((await params).slug, (await searchParams).embed === "1");
  return {
    title: loaded.kind === "open" ? loaded.definition.title : "WorkEasy360 Forms",
    // Forms are shared by link; they should not appear in search results.
    robots: { index: false, follow: false },
  };
}

function Notice({ title, children, embed }: { title: string; children: React.ReactNode; embed: boolean }) {
  return (
    <main className={embed ? "r-embed r-notice" : "r-page r-notice"}>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export default async function FormPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = await searchParams;
  const embed = query.embed === "1";
  const loaded = await loadForm(slug, embed);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "closed") {
    return (
      <Notice title="This form is closed" embed={embed}>
        <p>It isn&apos;t accepting responses any more. If you think this is a mistake, contact whoever shared it with you.</p>
      </Notice>
    );
  }
  if (loaded.kind === "full") {
    return (
      <Notice title="This form is full" embed={embed}>
        <p>It has received all the responses it can take. If you think this is a mistake, contact whoever shared it with you.</p>
      </Notice>
    );
  }
  if (loaded.kind === "not_open_yet") {
    return (
      <Notice title="This form isn't open yet" embed={embed}>
        <p>
          {loaded.opensAt ? (
            <>
              It opens on <time dateTime={loaded.opensAt}>{OPENS_FORMAT.format(new Date(loaded.opensAt))} (UTC)</time>. Come back then.
            </>
          ) : (
            "Come back later."
          )}
        </p>
      </Notice>
    );
  }
  if (loaded.kind === "busy") {
    return (
      <Notice title="This form can't take responses right now" embed={embed}>
        <p>Please try again later.</p>
      </Notice>
    );
  }
  if (loaded.kind === "sign_in") {
    return (
      <Notice title="Sign in to fill in this form" embed={embed}>
        <p>This form is only for members of the organization that published it.</p>
        {query.signin === "failed" && <p role="alert">Signing in didn&apos;t work. Please try again.</p>}
        <p>
          {embed ? (
            // Sign-in can't happen inside another site's frame; it opens in a tab, then this frame is reloaded.
            <a className="r-button" href={loaded.signInUrl} target="_blank" rel="noopener">
              Sign in (opens a new tab)
            </a>
          ) : (
            <a className="r-button" href={loaded.signInUrl}>
              Sign in
            </a>
          )}
        </p>
        {embed && <p>After signing in, reload this page.</p>}
      </Notice>
    );
  }
  if (loaded.kind === "not_member") {
    return (
      <Notice title="You don't have access to this form" embed={embed}>
        <p>It&apos;s only for members of the organization that published it. If you think you should have access, contact whoever shared it with you.</p>
      </Notice>
    );
  }
  if (loaded.kind === "unavailable") {
    return (
      <Notice title="We couldn't load this form" embed={embed}>
        <p>Please try again in a moment.</p>
      </Notice>
    );
  }
  return <PublicForm slug={slug} versionId={loaded.versionId} definition={loaded.definition} embed={embed} />;
}
