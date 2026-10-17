# Accessibility and mobile verification (UX-01)

Target: WCAG 2.2 level AA for the console and the public form.

## Automated checks

| Check | Where | Runs in CI |
|---|---|---|
| Public form with every field type, before and after errors are shown: axe-core WCAG A/AA rules | `packages/form-renderer/src/a11y.browser.test.tsx` | Yes (`pnpm test:browser`) |
| Every console page and the public form, at desktop and phone widths and in dark mode: axe-core WCAG A/AA rules plus advisory best practices, and no sideways scrolling | `scripts/a11y-audit.mjs` | No; needs the local stack |
| Keyboard only: fill and submit the public form; add a field from the builder palette | `scripts/a11y-audit.mjs` | No |

Run the full audit against a local stack (`pnpm infra:up`, `pnpm db:seed`, `pnpm dev`):

```sh
node scripts/a11y-audit.mjs --out ./a11y-report
```

It signs in with the local Dex fixture account (or `A11Y_EMAIL` and `A11Y_PASSWORD`), creates and publishes a form, audits each page, archives the form, and writes screenshots and `report.json` to the output folder. It exits 1 on any serious or critical issue.

Pages covered: organizations, forms list, create form, builder, preview, responses, response detail, analytics, integrations, form settings, members, AI settings, audit log, background jobs, invitation, help, and the public form with its confirmation.

## Results, 17 October 2026

52 page views, 2 keyboard journeys: no WCAG violations, no advisories, no sideways scrolling (rerun with the Help page added, DOC-01).

Fixed while verifying:

- Status badges ("Live", "Closed") and the AI choice card had text below 4.5:1 contrast.
- On phones, the audit log and background jobs tables scrolled inside boxes keyboard users could not reach; they are now focusable, labelled regions.
- Each console page now has exactly one main landmark, with the form header inside it, and a "Skip to main content" link as the first focusable element.
- Heading levels on the create page no longer skip from 1 to 3; the jobs table's action column has a real (visually hidden) header.

## Still to check by hand

Automated rules find roughly a third of accessibility problems. Before release, someone should run these journeys with NVDA on Windows and VoiceOver on iOS, and record the result here:

1. Sign in, create a form from a template, add a question, publish, copy the link.
2. Open the public form on a phone, answer with the screen reader, trigger an error, fix it, submit.
3. Read a response in the console, and find a member and change their role.

Also check text at 200% zoom and with Windows high contrast mode.
