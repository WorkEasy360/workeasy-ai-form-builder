import type { Metadata } from "next";
import type { ReactNode } from "react";
import { tokensCss } from "@workeasy/ui";

export const metadata: Metadata = {
  title: "Workeasy Forms",
  description: "Complete a Workeasy form.",
  referrer: "no-referrer",
};

const baseCss = `
${tokensCss()}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:var(--we-font-family);font-size:16px;line-height:1.5;background:var(--we-color-background);color:var(--we-color-text)}
:focus-visible{outline:2px solid var(--we-color-focus);outline-offset:2px}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
.r-page{min-height:100vh}
.r-page>.we-surface{min-height:100vh}
.r-notice>h1,.r-notice>p{max-width:680px;margin:0 auto 12px;padding:0 16px}
.r-notice>h1{font-size:24px;padding-top:48px}
.r-embed.r-notice>h1{padding-top:16px}
.r-embed{margin:0}
.r-alert{max-width:680px;margin:16px auto 0;padding:12px 16px;border:2px solid var(--we-color-danger);border-radius:8px}
.r-button{display:inline-block;padding:10px 20px;border-radius:8px;background:var(--we-color-accent);color:var(--we-color-accentText);font-weight:600;text-decoration:none}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{baseCss}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
