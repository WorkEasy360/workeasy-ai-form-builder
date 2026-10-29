"use client";

import createQrCode from "qrcode-generator";
import { useEffect, useId, useMemo, useState } from "react";
import { api, ApiError, type FormSummary } from "../../../../../../lib/api";

interface Share {
  url: string;
  embedUrl: string;
  embedHtml: string;
  qrPayload: string;
  live: boolean;
  accessMode: AccessMode;
}

type AccessMode = "public" | "organization";

const QR_MARGIN = 4;

/** A QR code as one SVG path: dark modules only, a quiet zone around them. */
function qrPath(text: string): { size: number; d: string } {
  const qr = createQrCode(0, "M");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + QR_MARGIN} ${row + QR_MARGIN}h1v1h-1z`;
    }
  }
  return { size: count + QR_MARGIN * 2, d };
}

function svgFile({ size, d }: { size: number; d: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 8}" height="${size * 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function download(content: string, type: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.problem.title : "Something went wrong.";
}

function CopyField({ label, value, multiline, onCopied }: { label: string; value: string; multiline?: boolean; onCopied: (what: string) => void }) {
  const id = useId();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      onCopied(`${label} copied.`);
    } catch {
      onCopied(`Couldn't copy automatically. Select the ${label.toLowerCase()} and copy it.`);
    }
  }
  return (
    <div className="b-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea id={id} readOnly value={value} rows={8} spellCheck={false} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} onFocus={(e) => e.target.select()} />
      ) : (
        <input id={id} readOnly value={value} onFocus={(e) => e.target.select()} />
      )}
      <div className="b-row" style={{ gap: 8 }}>
        <button type="button" className="b-btn" onClick={() => void copy()}>
          Copy {label.toLowerCase()}
        </button>
      </div>
    </div>
  );
}

/**
 * Sharing (docs/01 §3: "copy link/QR/embed") and the open/closed switch.
 * Closing takes effect at once for every respondent, including anyone with
 * the form already open.
 */
export function SharePanel({ formPath, form, announce }: { formPath: string; form: FormSummary; announce: (message: string) => void }) {
  const [share, setShare] = useState<Share | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    api<Share>(`${formPath}/share`)
      .then((s) => {
        if (!cancelled) setShare(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [formPath]);

  const qr = useMemo(() => (share ? qrPath(share.qrPayload) : undefined), [share]);

  function copied(message: string) {
    setStatus(message);
    announce(message);
  }

  const published = form.activeVersionId !== null;
  return (
    <div className="b-publish">
      <section aria-labelledby="share-heading">
        <h2 id="share-heading">Share</h2>
        {!published && <p>Publish the form first; until then the link shows a "not found" page.</p>}
        {published && form.state === "published" && <p>The form is open: anyone with the link can fill it in.</p>}
        {form.state === "closed" && <p>The form is closed: the link shows that it isn&apos;t accepting responses.</p>}
        {form.state === "archived" && <p>The form is archived: the link shows a &quot;not found&quot; page.</p>}

        {loadError && (
          <p role="alert" className="b-inline-error">
            {loadError}
          </p>
        )}
        {!share && !loadError && <p className="b-muted">Loading…</p>}
        {share && (
          <>
            <CopyField label="Link" value={share.url} onCopied={copied} />
            <p style={{ marginTop: -4 }}>
              <a href={share.url} target="_blank" rel="noopener">
                Open the form in a new tab
              </a>
            </p>
            <CopyField label="Embed code" value={share.embedHtml} multiline onCopied={copied} />
            <p className="b-muted" style={{ marginTop: -4 }}>
              Paste it into any web page. The frame resizes itself to fit the form.
            </p>
          </>
        )}
        <p role="status" aria-live="polite" className="b-muted">
          {status}
        </p>
      </section>

      <section aria-labelledby="qr-heading">
        <h2 id="qr-heading">QR code</h2>
        {share && qr && (
          <>
            <svg
              role="img"
              aria-label={`QR code for ${share.qrPayload}`}
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              width={200}
              height={200}
              shapeRendering="crispEdges"
              style={{ background: "#fff", border: "1px solid var(--we-border)" }}
            >
              <path d={qr.d} fill="#000" />
            </svg>
            <p>
              <button type="button" className="b-btn" onClick={() => download(svgFile(qr), "image/svg+xml", "form-qr-code.svg")}>
                Download QR code (SVG)
              </button>
            </p>
          </>
        )}

        <p style={{ marginTop: 24 }}>
          Who can respond, closing the form, limits and schedule, spam protection and data retention are under{" "}
          <a href={formPath.replace(/^\/api\/v1\/organizations\/([^/]+)\/forms\/([^/]+)$/, "/o/$1/forms/$2/settings")}>Settings</a>.
        </p>
      </section>
    </div>
  );
}
