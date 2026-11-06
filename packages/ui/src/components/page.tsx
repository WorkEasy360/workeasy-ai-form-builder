import type { ReactNode } from "react";
import { CheckIcon } from "./icons";

/**
 * The building blocks every admin page is made of, so all modules share one
 * skeleton: <Page> → <PageHeader> → optional toolbar → cards, tables, forms,
 * or an <EmptyState>.
 */
export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <div className={narrow ? "c-page c-page-narrow" : "c-page"}>{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  /** Small label above the title, e.g. the module group. */
  eyebrow?: ReactNode;
  /** Primary action last, so it sits at the right edge. */
  actions?: ReactNode;
}) {
  return (
    <header className="c-page-head">
      <div>
        {eyebrow && <div className="c-page-eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {subtitle && <p className="c-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="c-page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, actions, children, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={flush ? "c-card c-card-flush" : "c-card"}>
      {(title || actions) && (
        <div className="c-card-head" style={flush ? { padding: "16px 20px 0" } : undefined}>
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ icon, title, children, actions }: { icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="c-empty">
      <span className="c-icon-tile c-icon-tile-lg">{icon}</span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {actions && <div className="c-empty-actions">{actions}</div>}
    </div>
  );
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "brand" | "ai";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="c-badge" data-tone={tone === "neutral" ? undefined : tone}>
      {children}
    </span>
  );
}

/** A small trend line for stat cards; draws nothing for fewer than two points. */
export function Sparkline({ values, width = 96, height = 28, color = "var(--we-chart-1)" }: { values: readonly number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StatCard({ label, value, icon, foot, trend }: { label: string; value: ReactNode; icon?: ReactNode; foot?: ReactNode; trend?: readonly number[] }) {
  return (
    <div className="c-card c-stat">
      <span className="c-stat-label">
        {icon}
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8 }}>
        <span className="c-stat-value">{value}</span>
        {trend && <Sparkline values={trend} />}
      </div>
      {foot && <span className="c-stat-foot">{foot}</span>}
    </div>
  );
}

/** A checked list of capabilities, used to describe what a module does. */
export function FeatureList({ items }: { items: readonly string[] }) {
  return (
    <ul className="c-feature-list">
      {items.map((item) => (
        <li key={item}>
          <CheckIcon size={16} />
          {item}
        </li>
      ))}
    </ul>
  );
}
