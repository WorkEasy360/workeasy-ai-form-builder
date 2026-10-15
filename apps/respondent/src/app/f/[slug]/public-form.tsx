"use client";

import { FormRenderer, RENDERER_CSS } from "@workeasy/form-renderer";
import type { FormDefinition } from "@workeasy/form-schema";
import { useEffect, useRef } from "react";

/** Message an embedded form sends its host page. It carries a height and nothing else (docs/06 §3). */
const HEIGHT_MESSAGE = "workeasy:form-height";

/**
 * Before anything is sent, asks the API whether the form still accepts a
 * response for the version this page was loaded with. A page left open (or
 * served from a cache) after the form was closed or replaced finds out here.
 *
 * Storing responses arrives with RUN-02, which repeats this check inside its
 * intake transaction; until then an accepting form says so plainly.
 */
async function submit(slug: string, versionId: string): Promise<string | undefined> {
  let res: Response;
  try {
    res = await fetch(`/public/v1/forms/${encodeURIComponent(slug)}/acceptance?versionId=${encodeURIComponent(versionId)}`, { cache: "no-store" });
  } catch {
    return "We couldn't reach Workeasy Forms. Check your connection and try again; your answers are still here.";
  }
  if (res.status === 410) return "This form has closed and isn't accepting responses any more. Your answers weren't sent.";
  if (res.status === 409) return "This form was updated after you opened it. Reload the page to get the latest version; your answers weren't sent.";
  if (res.status === 404) return "This form is no longer available. Your answers weren't sent.";
  if (!res.ok) return "Something went wrong. Please try again; your answers are still here.";
  return "This form isn't collecting responses yet. Your answers weren't sent.";
}

export function PublicForm({ slug, versionId, definition, embed }: { slug: string; versionId: string; definition: FormDefinition; embed: boolean }) {
  const main = useRef<HTMLElement>(null);

  // Embedded: report the content height so the host page can size the iframe.
  // The form's own box is measured, not the document, whose height never drops
  // below the frame's, so the frame can shrink again (e.g. on a shorter page).
  useEffect(() => {
    const content = main.current;
    if (!embed || !content || window.parent === window) return;
    let last = 0;
    const report = () => {
      const height = Math.ceil(content.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      // Any origin may host the form; the message reveals only a height.
      window.parent.postMessage({ type: HEIGHT_MESSAGE, height }, "*");
    };
    const observer = new ResizeObserver(report);
    observer.observe(content);
    report();
    return () => observer.disconnect();
  }, [embed]);

  return (
    <main ref={main} className={embed ? "r-embed" : "r-page"}>
      <style>{RENDERER_CSS}</style>
      <FormRenderer definition={definition} idPrefix="form" onSubmit={() => submit(slug, versionId)} />
    </main>
  );
}
