# References, assumptions, and decisions to resolve

Research checked 14 October 2026. Primary official sources are used for the competitor capability baseline and specific technical controls. Product behavior can vary by plan/region; verify detailed equivalence when implementing each advanced feature. Workeasy's architecture is an independent proposal, not a description of Zoho's internal systems.

## Sources

| Source | Use in this design |
|---|---|
| [Zoho Forms official features](https://www.zoho.com/forms/features.html) | Broad feature families: creation, fields, automation, payments, sharing, reporting/mobile/security |
| [Zoho Forms AI features](https://help.zoho.com/portal/en/kb/forms/ai/articles/ai-features-in-zoho-forms) | AI authoring/document/translation/content assistance benchmark |
| [Zoho AI Forms workflow](https://www.zoho.com/forms/ai-forms/features.html) | Draft generation followed by editing/review and sharing |
| [Zoho mobile form features](https://www.zoho.com/forms/mobile-form-features.html) | Offline/mobile collection is a separate advanced capability |
| [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | RLS semantics and bypass/owner considerations |
| [Stripe webhooks](https://docs.stripe.com/webhooks) | Signature handling, duplicate events, asynchronous processing and event ordering |
| [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) | Outbound webhook destination validation and network defenses |

## Confirmed decisions

| ID | Decision | Reason |
|---|---|---|
| ADR-001 | Next.js + Express.js + PostgreSQL | Explicit product-owner stack |
| ADR-002 | Both manual and AI authoring | Explicit product requirement |
| ADR-003 | Workeasy-branded product with public sharing | Explicit product requirement |

## Recommended architecture decisions

| ID | Decision | Consequence |
|---|---|---|
| ADR-004 | Modular monolith plus independently scalable workers | Shared transactions; avoid premature service fragmentation |
| ADR-005 | Shared form definition and deterministic engine | AI/manual parity; matching server/client rules |
| ADR-006 | Immutable publication snapshots | Safe evolution and historical response interpretation |
| ADR-007 | Shared-table tenancy + RLS + application grants | Efficient SaaS default; stringent negative tests required |
| ADR-008 | Transactional outbox and at-least-once execution | Durable delivery; destination deduplication remains necessary |
| ADR-009 | Separate public renderer and console | Isolated assets/auth and independent scaling |
| ADR-010 | Provider adapters for AI/auth/Workeasy/payment | Unknown existing infrastructure does not contaminate domain model |
| ADR-011 | Hosted payment collection | Workeasy does not handle raw card details |
| ADR-012 | No arbitrary code in forms/rules | Bounded evaluation and safer public rendering |

## Open decisions and safe defaults

| Question | Default until resolved | Needed before |
|---|---|---|
| Existing Workeasy login and organization identity? | OIDC adapter + local test IdP | Production SSO/integration |
| Workeasy API contracts and auth? | Interface definitions + clearly isolated test doubles | Connector production acceptance |
| Hosting provider, region, residency? | Cloud-neutral containers and private managed services | Infrastructure provisioning |
| Existing UI/theme components? | Neutral Workeasy-ready token system | Final brand approval |
| AI provider and data processing policy? | Adapter; metadata-only logs; no respondent content | Production AI enablement |
| Payment provider/account model and currency? | No P1 payments; provider adapter in P2 | Payment implementation |
| Expected traffic, file sizes and retention? | Planning profile in operations document | Final load/cost commitment |
| Subscription plans/pricing and trial rules? | Configurable entitlements without invented prices | Billing launch |
| Required third-party connectors? | Generic webhook + prioritized Workeasy integrations | Connector roadmap commitment |
| Team capacity and launch date? | Milestone gates without speculative calendar estimates | Delivery scheduling |
| Exact enterprise/legal obligations? | Security/privacy mechanisms, no certification claims | Regulated or contractual deployments |

## Scope guardrails

The request for every architecture/design is implemented as a coherent recommended architecture plus evaluated alternatives, detailed core contracts, and phase gates for advanced capabilities. It is not feasible or useful to combine every possible architecture. Complete vendor parity requires a separately maintained feature-by-feature test matrix against selected Zoho plans and user scenarios. This package gives the AI IDE a concrete implementation path and clearly identifies the contracts still requiring validation.
