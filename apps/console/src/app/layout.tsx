import type { Metadata } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { tokensCss } from "@workeasy/ui";
import { CONSOLE_CSS } from "./console-css";

export const metadata: Metadata = {
  title: "WorkEasy360 Forms",
  description: "Build, publish and manage WorkEasy360 forms.",
};

// Self-hosted at build time: no request to a font service at runtime.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--we-font-inter" });

const baseCss = `
${tokensCss()}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;font-family:var(--we-font-family);font-size:var(--we-text-base);line-height:var(--we-leading-base);background:var(--we-background);color:var(--we-text-body);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
:focus-visible{outline:2px solid var(--we-focus);outline-offset:2px}
${CONSOLE_CSS}`;

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
