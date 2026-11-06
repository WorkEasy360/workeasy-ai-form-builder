import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { adminStyles, themeInitScript, tokens } from "@workeasy/ui";
import { PRODUCT_NAME } from "@workeasy/ui/react";
import { CONSOLE_CSS } from "./console-css";

// Self-hosted at build time; the tokens' font stack reads --we-font-inter.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--we-font-inter" });

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: "Build, publish and manage forms, with AI drafts you review before anything goes live.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: tokens.color.surface },
    { media: "(prefers-color-scheme: dark)", color: tokens.colorDark.surface },
  ],
};

const css = `${adminStyles()}\n${CONSOLE_CSS}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script may set data-theme before React hydrates.
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <style>{css}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
