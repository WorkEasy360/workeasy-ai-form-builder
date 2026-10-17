import type { Metadata } from "next";
import type { ReactNode } from "react";
import { tokensCss } from "@workeasy/ui";
import { CONSOLE_CSS } from "./console-css";

export const metadata: Metadata = {
  title: "Workeasy Forms",
  description: "Build, publish and manage Workeasy forms.",
};

const baseCss = `
${tokensCss()}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:var(--we-font-family);font-size:16px;line-height:1.5;background:var(--we-color-background);color:var(--we-color-text)}
:focus-visible{outline:2px solid var(--we-color-focus);outline-offset:2px}
${CONSOLE_CSS}`;

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
