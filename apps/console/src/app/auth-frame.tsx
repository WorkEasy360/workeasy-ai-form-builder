import type { ReactNode } from "react";
import { BrandMark, PRODUCT_LINE } from "@workeasy/ui/react";

/** The centred frame for signing in and accepting invitations: the Workeasy lockup above a card. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="c-center-page">
      <div className="c-auth">
        <div className="c-auth-brand">
          <BrandMark size={40} />
          <h1 style={{ margin: 0, fontSize: "inherit" }}>
            <strong>Workeasy</strong>
            <small>{PRODUCT_LINE}</small>
          </h1>
        </div>
        {children}
      </div>
    </main>
  );
}
