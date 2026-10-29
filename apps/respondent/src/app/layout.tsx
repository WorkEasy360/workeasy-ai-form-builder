import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { tokensCss } from "@workeasy/ui";

export const metadata: Metadata = {
  title: "WorkEasy360 Forms",
  description: "Complete a WorkEasy360 form.",
  referrer: "no-referrer",
};

// Self-hosted at build time: no request to a font service at runtime.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--we-font-inter" });

const baseCss = `
${tokensCss()}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:var(--we-font-family);font-size:16px;line-height:1.5;background:var(--we-color-background);color:var(--we-color-text);-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid var(--we-color-focus);outline-offset:2px}
@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}
.r-page{min-height:100vh}
.r-page>.we-surface{min-height:100vh}
.r-notice>h1,.r-notice>p{max-width:680px;margin:0 auto 12px;padding:0 16px}
.r-notice>h1{font-size:24px;line-height:32px;font-weight:600;padding-top:48px}
.r-embed.r-notice>h1{padding-top:16px}
.r-embed{margin:0}
.r-alert{max-width:680px;margin:16px auto 0;padding:12px 16px;border:1px solid var(--we-error);border-left-width:4px;border-radius:var(--we-radius-md);background:var(--we-error-bg);color:var(--we-error-fg)}
.r-button{display:inline-flex;align-items:center;min-height:40px;padding:0 20px;border-radius:var(--we-radius-md);background:var(--we-color-accent);color:var(--we-color-accentText);font-weight:600;text-decoration:none;transition:filter var(--we-duration-fast) var(--we-ease)}
.r-button:hover{filter:brightness(1.1)}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        <style>{baseCss}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
