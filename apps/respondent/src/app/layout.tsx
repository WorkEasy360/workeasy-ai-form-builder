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
