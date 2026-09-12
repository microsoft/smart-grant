# Changelog

All notable changes to **Smart Grant Request** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [Unreleased] — `main`

> **Running in production** since 2026-09-09. Still labelled Unreleased because
> the version has not been cut: that waits on UAT sign-off for the PDF, the
> palette, and the end-to-end pipeline. Deployed is not the same as accepted.

### Removed

- **Every manual deployment script.** `deploy-azure.ps1`, `deploy-azure.sh`
  and `deploy/Deploy-SmartGrantRequest.ps1` all predated this topology and
  none of them could produce it. The first two hardcoded a specific
  subscription, created their own registry with the admin user enabled, and
  passed the interface credentials to `az containerapp create` as plain
  environment variables — no VNet, no private endpoint, no Key Vault, no
  managed identity. They also expected an `AZURE_OPENAI_API_KEY` that cannot
  exist when the Foundry account has local authentication disabled. The
  third created a Key Vault of its own and wrote secrets through the data
  plane, which a tenant policy that forces private networking will block.

  Running any of them would not have updated an existing deployment; it would
  have built a second, weaker copy of it somewhere else. An escape hatch that
  quietly downgrades the security model is worse than no escape hatch.
  Deployment is CI; infrastructure is `infra/*.bicep`.

- **The entire v1 surface.** The original interface, the six-agent chain that
  served it, and the Microsoft Fabric / Power BI integration were deleted from
  the tree rather than left dormant. Gone: `src/components/LiveAgentDemo.tsx`
  and nine sibling components, `src/app/api/agent-framework/`,
  `src/lib/agent-framework-client.ts`, `src/lib/data.ts`,
  `agent_framework_backend/agents/`, `services/fabric.py`,
  `routes/fabric_routes.py`, and the `/workflow/run`, `/workflow/run` (POST)
  and `/workflow/run-sync` endpoints. `/` is now a redirect to `/v2`.
- **The compact SSE dialect** (`a:` / `c:` / `d:` lines) and the `?format=`
  switch that selected it. It existed only to feed the v1 frontend; with that
  gone it had no caller, and two wire formats with one consumer is a
  maintenance tax for nothing.
- **`USE_V2_WORKFLOW`**, a feature flag whose only job was flipping the legacy
  route over to v2. It was still being reported on `GET /v2/health`.
- **Five production dependencies with no importer**: `powerbi-client`,
  `powerbi-client-react`, `powerbi-models`, `@azure/openai`, `openai`.
- **Documentation describing removed code**: `SPEC.md`, `README.v1.md`,
  `README_BACKUP.md`, `FABRIC_INTEGRATION.md`, `NCES_INTEGRATION.md`,
  `MULTI_SOURCE_IMPLEMENTATION.md`, `STATE_PORTALS_IMPLEMENTATION.md`,
  `AGENT_FRAMEWORK_INTEGRATION.md`, `docs/fabric-integration.md`,
  `agent_framework_backend/README.md`, `fabric-capacity.json`.

### Security

- `jspdf` 3.0.3 → 4.2.1 closes the only critical advisory in the production
  dependency tree, and the transitive `dompurify` one with it. `next` 14.2.33
  → 14.2.35 plus `npm audit fix` clear `nanoid` and `fflate`. Production
  advisories: 6 → 2. The two that remain are inside Next 14 itself (the listed
  `postcss` is its bundled copy) and only clear on Next 16, still in canary.

### Fixed

- **Discovery asked Grants.gov the wrong question.** The `search2` call sent
  only a keyword and a status filter, so a search for "stem" came back full of
  university and research programmes. A real production run for Lincoln High
  School returned 26 candidates and the ranker disqualified 25 of them: 12
  "higher ed only", 7 "eligibility not school-based", plus an SBIR programme
  and two graduate-only ones.

  Every one of those refusals was correct — a high school genuinely cannot
  apply for a graduate-MSI grant. The rubric was doing exactly what it should;
  the candidate pool was wrong. Loosening the rubric would have "fixed" the
  empty shortlist by recommending grants the school is ineligible for.

  The request now carries `eligibilities: "05"` — Grants.gov's code for
  *Independent school districts*, the applicant type that actually describes
  the schools in this product, whose index is the NCES CCD of public schools.
  Measured against the live API for "stem": 153 results before, 43 after, with
  a real K-12 programme (DoD STARBASE) at the top instead of Tribal Colleges
  and two-year-college initiatives. Also adding code 99 ("unrestricted") was
  tried and rejected — it puts the university grants straight back. No
  category is starved: the narrowest, literacy, still returns 11.

  A test pins the parameter, because it is invisible in the response: if
  someone drops it, the only symptom would be the ranker quietly discarding
  almost everything again, far from the cause.

- **The generation header lost the funder's name when the chosen prospect was
  a foundation.** It read `Writing against {selectedGrant?.title}`, but
  `startGeneration` deliberately sets `selectedGrant` to `null` for a
  foundation and stores it in `selectedFoundation` instead — so the sentence
  rendered as "Writing against  — five specialists collaborating in real
  time", with a hole in the middle. This was not an edge case: when Discovery
  shortlists no federal match it falls back to foundation prospects, which
  makes this the default path. The document itself was never affected — the
  exported PDF names the foundation nine times — so the defect was confined
  to that one label.

- **Three `react-hooks/exhaustive-deps` warnings**, each judged on its own
  merits rather than silenced with a blanket rule.

  In `WriterStudio` the two `useCallback`s genuinely were missing `emit`, and
  adding it is free: `emit` is itself `useCallback(…, [])` reading a ref that
  an effect keeps current, so its identity never changes. The neighbouring
  `reset` already listed it — the omissions were inconsistency, not intent.

  `Office3D` was the opposite case, and following the linter there would have
  introduced a bug. The cinema bus must keep a stable identity: `Director`
  writes `focusPoint`, `focusDistance` and `intensity` into it every frame and
  `Effects` reads them in the same frame, so rebuilding it when the
  reduced-motion preference changed would reset the camera mid-shot. That is
  exactly why `reducedMotion` is assigned by mutation instead of being a
  dependency. The creation moved from `useMemo(…, [])` to a ref, which is what
  the code already meant and is strictly stronger: `useMemo` is a performance
  hint that React is free to discard, so the old form could in principle have
  rebuilt the bus on its own. No `eslint-disable` was added anywhere, and
  `/v2` and `/v2/office` build to byte-identical sizes.

- `GET /` advertised `/workflow/run` and `/workflow/run-post`, neither of
  which existed. The route list is now covered by a test that compares it
  against the application's own routing table.
- `docs/architecture.md` claimed the application had no backend database. It
  had one — a SQLite file on ephemeral disk — which has since been replaced
  by the blob event log described under *Changed*.
- The README claimed 130,000+ school records. That figure is the size of the
  federal database, not of the shipped index, which holds 102,178 rows from
  NCES CCD 2024 via the Urban Institute Education Data Portal — **100,237**
  of them operating schools the picker can actually find. The hero now reads
  that number from the index at render time instead of quoting a constant.
  The README also advertised a public demo link that redirects every visitor
  to `/login`.
- **Four numbers on the Pulse dashboard described something other than what
  they measured**, each found by looking at real data rather than by a test:
  - *Active sessions* counted events. A discovery and a draft on the same
    school are one visit and two runs. Renamed **Agent runs**.
  - *Avg request* averaged `amount_high`, the award ceiling published in the
    opportunity, which is not a sum anyone asked for. Renamed **Avg award
    ceiling**.
  - Sector labels rendered as *Computer-Science*, *Mental-Health* and *Ell*
    because the label map was keyed with `_` where the product emits `-`. A
    test now requires the map and `GRANT_TYPES` to be the same set, so the
    two cannot drift apart again in silence.
  - *recording since May 21* — a whole UTC day rendered in the browser's
    timezone, moving the start of history a day earlier.
- **The hero described a product that no longer exists.** It promised six
  agents that "collaborate live", which reads as one continuous chain; the
  pipeline has stopped after discovery and waited for a human to choose the
  grant since HITL landed. It also promised *five minutes*, which nothing in
  the system measures.

### Changed

- **The deploy pipeline authenticates by federated identity, with no stored
  password.** It had been failing at the last step with *"the containerapp
  … does not exist"* — the app existed; the service principal behind
  `AZURE_CREDENTIALS` simply held no role on the subscription the apps live
  in. That secret predated the current topology and had never been rotated.
  Setting a subscription explicitly would have papered over an identity
  nobody could account for.

  It is replaced by `id-smartgrant-deploy`, a user-assigned identity with a
  GitHub OIDC federated credential whose subject pins it to one repository
  and one branch. GitHub mints a token per run and Entra ID
  exchanges it; nothing durable is stored. `AZURE_CLIENT_ID`,
  `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` are identifiers, not
  credentials — on their own they authenticate no one.

  Its rights are three resource-scoped assignments and nothing else:
  `Container Apps Contributor` on each of the two apps, and `AcrPush` on the
  registry. It cannot reach the Key Vault, the Pulse storage account, the
  network, or the other identities. `Container Apps Operator` was considered
  and rejected — it has no `write`, so it cannot swap an image.

  The registry admin credential goes with it: pushes now use `az acr login`
  through the same identity, retiring the last long-lived username/password
  pair in the repository.

- **Backend dependencies are pinned to exact versions.** `requirements.txt`
  used `>=` on every line, so each `pip install` resolved to whatever was
  newest that day: the developer's machine, CI, and the production image
  could run three different programs from one commit. That bill came due —
  CI resolved FastAPI 0.138, which stopped copying included routes into
  `app.routes` and stores the router in one internal object instead. The
  endpoints still served, but a route-table assertion read the structural
  change as the whole `/v2` surface having vanished, and the deploy stopped
  while it was investigated.

  The pins are the versions the backend actually runs — full suite, SSE
  streaming, agent pipeline end to end — verified by building a clean
  environment from the file alone. `starlette` is pinned too, despite being
  transitive: it implements routing, middleware, and the test client, and
  leaving it loose means swapping the application's ASGI base with nobody
  deciding anything.

- **The `agent-framework` umbrella package is replaced by the two
  sub-packages actually imported**, `agent-framework-core` and
  `agent-framework-openai`. The umbrella pulls the `[all]` extra — roughly 26
  ecosystem connectors (Bedrock, Ollama, Anthropic, Redis, Cosmos, Mem0 and
  the rest), none of them imported anywhere in this tree. It also made the
  version impossible to pin at all: the extra resolves its sub-packages
  independently, and the current ones already demand a newer core than the
  pinned umbrella allows, which is an unsolvable conflict. A clean install
  goes from ~200 packages to 70.

- **`structlog` is now declared.** `main.py` imports it on line 15, but it
  only ever reached the image as a transitive dependency of the agent
  framework — one upstream change away from an ImportError at startup.

- **Pulse now writes to Azure Blob Storage instead of SQLite.** One append
  blob per day (`pulse/YYYY/MM/DD.jsonl`). Append blobs make each write
  atomic at the block level, so replicas write concurrently without a lock,
  and reading a period is a prefix listing rather than a full scan. The old
  file was local to each container: every deploy started from zero and two
  replicas told different stories.

  Authentication is Entra ID only. The account is provisioned with
  `allowSharedKeyAccess: false`, public network access off, and a private
  endpoint, so there is no key to leak. `tools/migrate_usage_db.py` moves an
  existing `usage.db` into the log and refuses to run twice over the same
  days unless forced.

  Coverage is 54 unit tests against a fake log plus 6 integration tests that
  run against Azurite and pin the SDK contract — append semantics, the
  create-race guard, 404 read as empty. Without the emulator they skip with
  an explicit reason. With nothing configured at all, Pulse is off and the
  panel says so rather than inventing numbers.

### Added

- **Human-in-the-loop (HITL) grant selection.** The single end-to-end pipeline
  is split into two SDK workflows: **DiscoveryWorkflow** ranks live results
  through a `Discovery Ranker` agent that applies hard disqualifiers
  (Grants.gov nav pages, state/type/grade/deadline mismatch) and an explicit
  100-point rubric across eight dimensions (eligibility fit, mission alignment,
  demographic resonance, award-size fit, competition odds, timeline feasibility,
  sustainability potential, strategic upside), and **GenerationWorkflow** runs
  Narrative → Budget → Compliance → Intelligence → Writer against the
  user-picked `RankedGrant`. Frontend pauses on
  [`src/components/v2/RankedGrantPicker.tsx`](src/components/v2/RankedGrantPicker.tsx)
  showing per-dimension bars, confidence badge, pros/cons, methodology
  disclosure, and a disqualified list. New endpoints
  `POST /v2/workflow/discover` and `POST /v2/workflow/generate` replace the
  previous monolithic `/v2/workflow/run` for the v2 UI flow.
- **Consulting-grade generation prompts (Phase B).** Rewrote Narrative,
  Budget, and Writer system prompts in
  [`agent_framework_backend/v2/prompts_generation.py`](agent_framework_backend/v2/prompts_generation.py)
  to demand realistic market rates, explicit category bands, banned filler
  words ("transformative", "synergy", "leverage" as verb, "innovative"), and
  a fixed 7-section Writer schema at 1,400–1,900 words. All builders take the
  user-selected `RankedGrant` so every section references the actual funder,
  award range, deadline, and rubric-derived pros/cons.
- **Typed agent handoffs (Phase B).** `AgentContext.typed_outputs` now carries
  parsed Pydantic objects between agents. After each agent whose spec declares
  a `response_format` in `_JSON_OUTPUT_AGENTS`, the executor parses the raw
  output with a tolerant JSON extractor (`_parse_typed_output`) and stores the
  validated model. Today this covers the Budget agent; Compliance and
  Intelligence will join in Phase C. The Writer prompt prefers typed Budget
  figures over raw text so its monetary references stay arithmetically
  consistent with the validated budget.
- **`BudgetOutput` invariant validator.** New
  `@model_validator(mode="after")` on `BudgetOutput` silently snaps
  `total_usd` to the sum of lines when drift is ≤ $1, appends a `notes`
  warning when drift is larger (trusting the line items), and appends band
  warnings when category groups fall outside the realistic ranges:
  personnel + fringe 15–35%, equipment + supplies 20–50%, training 8–20%,
  travel 0–10%, contractual + indirect 0–20%.
- **Honest Compliance and Intelligence agents (Phase C).** Both rewritten
  from scratch in [`agent_framework_backend/v2/prompts_generation.py`](agent_framework_backend/v2/prompts_generation.py)
  with strict-JSON outputs.
  - **Compliance** receives *pre-computed deterministic facts* in the user
    prompt (per-heading word counts, missing required sections, budget
    arithmetic from the typed `BudgetOutput`, demographic-number
    consistency check, deadline check) and is required to convert each
    fact verbatim into one finding, plus 2–4 LLM-level findings on tone,
    asset-based framing, and narrative-budget consistency. Findings now
    carry an explicit `category` (`eligibility | narrative | budget |
    format | anti_fabrication`) and the `overall_status` is auto-derived
    from finding severity when the model contradicts its own list.
  - **Intelligence** is anchored to *real federal base rates* (Title IV-A
    30–45%, Title I SIG 15–25%, ED competitive <$250k 20–35%, ED
    competitive $250k–$1M 12–20%, NSF DRK-12 8–15%, foundation 10–25%)
    that are inferred from the selected grant and injected into the
    prompt. The agent must pick a qualitative band (`weak | moderate |
    strong`), cite the base rate it used, and ground every advantage in
    a school fact or `selected_grant.pros` entry and every risk in a
    `selected_grant.cons` entry or a Compliance finding. The fabricated
    "funded XX similar projects" language is gone, and the
    `success_probability` integer is snapped to the band midpoint by a
    validator when the model drifts.
- **Schemas tightened (Phase C).** `ComplianceFinding` gained a typed
  `category` field; `ComplianceOutput` gained an auto-normalising
  validator. `IntelligenceOutput` gained `probability_band`,
  `base_rate_pct_range`, `base_rate_basis`, plus list caps and a
  probability-band consistency validator.
- **All five generation agents now flow typed handoffs.** The
  executor's `_JSON_OUTPUT_AGENTS` set is `{"budget", "compliance",
  "intelligence"}`; their outputs parse into Pydantic models and are
  exposed to downstream prompt builders via `ctx.typed_outputs`. The
  Writer prompt prefers the typed Compliance + Intelligence objects
  over their raw text, so structured findings flow cleanly into the
  final document.

- **Real Microsoft Agent Framework SDK 1.3.0 orchestration.**
  Replaced the v1 manual loop with `Agent`, `WorkflowBuilder.add_chain([...])`,
  custom `Executor`s with `@handler` methods, and typed `AgentContext`
  payloads flowing forward through the chain. The pipeline runs as
  `Workflow.run(message, stream=True, include_status_events=False)` and emits
  real `WorkflowEvent`s through `WorkflowContext.add_event/send_message/yield_output`.
  See [`agent_framework_backend/v2/workflow.py`](agent_framework_backend/v2/workflow.py)
  and [`agent_framework_backend/v2/agents.py`](agent_framework_backend/v2/agents.py).
- **Keyless Azure AI Foundry auth via Microsoft Entra ID.** Backend builds an
  `AsyncAzureOpenAI` client with an `azure_ad_token_provider` from
  `DefaultAzureCredential`, scoped to `https://cognitiveservices.azure.com/.default`.
  Works on Foundry resources where API-key authentication is disabled.
  Gated by `FOUNDRY_USE_AAD=true` in [.env.example](.env.example).
- **`/v2/health` workflow_engine proof field.** Reflects the live SDK class
  names + version from the running Python process — defense in depth that the
  pipeline genuinely runs `agent_framework`, not a stub. Sample output:
  ```json
  "workflow_engine": {
    "package": "agent_framework",
    "version": "1.3.0",
    "agent_class":       "agent_framework._agents.Agent",
    "workflow_class":    "agent_framework._workflows._workflow.Workflow",
    "builder_class":     "agent_framework._workflows._workflow_builder.WorkflowBuilder",
    "executor_class":    "agent_framework._workflows._executor.Executor",
    "chat_client_class": "agent_framework_openai._chat_client.OpenAIChatClient"
  }
  ```
- **Cinema-grade PDF generator** ([src/components/v2/pdf.ts](src/components/v2/pdf.ts)):
  - Serif covers with school + grant + generation date.
  - Markdown body with headings (`#`–`####`), GFM tables, ordered/unordered lists,
    blockquotes, paragraphs.
  - **Widow / orphan control** on every block. Headings, ALL-CAPS section
    labels (`II. STATEMENT OF NEED`), and lettered subheadings (`A. Capacity
    Building`) all use a **keep-with-next** rule that peeks ahead at the next
    1–2 actual content blocks and reserves room for the heading + real
    upcoming text (capped at 8 lines).
  - **Tables** never split a row across pages, always reserve room for the
    header + ≥ 2 body rows, and **repeat the header on every page** when long.
  - Short paragraphs (≤ 4 lines) are kept together; longer paragraphs require
    ≥ 2 lines on the current page or page-break.
  - Page footer with “Smart Grant Request · Generated <date>” + page numbering.
- **Apple-blue palette** (Apple Design Studio / Linear-inspired):
  background `#F4F7FB`, surface `#FFFFFF`, primary `#2E7CE4`, ink `#0B1F33`,
  text-muted `#4A6079`, border `#DCE5F0`, muted accent `#E5EDF8`.
  Replaces the warm claude.com palette. Source of truth:
  [src/app/globals.css](src/app/globals.css) `.v2-root`, mirrored in
  [tailwind.config.js](tailwind.config.js) and
  [src/components/v2/pdf.ts](src/components/v2/pdf.ts) `COLOR`.
- **Consulting-grade typography end-to-end.** Pictographic emojis stripped at
  three layers: agent prompts (`agent_framework_backend/v2/agents.py`
  `_strip_emojis`), on-screen markdown (`src/components/v2/Markdown.tsx`,
  `src/components/v2/AgentStream.tsx`), and PDF (`src/components/v2/pdf.ts`
  `sanitize`). Bold labels, lists, and headings carry structure — no
  decorative bullets, no substitution glyphs.
- **Collapsible agent rows** in the live stream. Each agent row defaults to
  collapsed and is a `<button>` that expands its body with a height/opacity
  Framer Motion transition.
- **README.v2 cinema rewrite** — accurate roadmap, real SDK class names,
  copy-pasted `workflow_engine` proof, two-terminal Quick Start, Apple-blue
  design tokens, verified file references.
- **Federal-grade PDF deliverable (Phase E).** Rewrote
  [`src/components/v2/pdf.ts`](src/components/v2/pdf.ts) end-to-end so the
  downloaded artifact is a submission-shaped application package rather than
  a generated report with appendices. The new pipeline: (1) a serif cover
  with a two-column **Funding Opportunity / Applicant** block carrying the
  funder name, program, ALN, deadline, requested amount, school name,
  district, location, grades, and enrolment — all extracted from the
  Writer's markdown front-matter via `splitMetadata()`; (2) a **reserved
  table-of-contents page** that is back-filled in a *second pass* with real
  per-heading page numbers gathered by an `onHeading` callback during body
  paint, including leader dots; (3) the seven-section narrative body (no
  appendices); (4) a federal-style **Certifications & Signatures** page
  with the 18 U.S.C. § 1001 false-statement preamble, five required
  assurances (Non-Discrimination, Drug-Free Workplace, Anti-Lobbying,
  2 CFR 200 Financial Management, Records Retention), and two signature
  blocks — Principal and Superintendent / Authorized Representative — each
  with name, title, date, and a ruled signature line; (5) page-by-page
  footers showing `{schoolName} — {grantName}` left and `Page p of n` right
  on every page except the cover. The results panel caption now reads
  `Cover · TOC · 7 sections · Signatures`.
- **Live federal-funding analytics (Phase F).** New
  [`agent_framework_backend/services/analytics.py`](agent_framework_backend/services/analytics.py)
  exposes `GrantsLandscapeService.compute_landscape()`, an async aggregator
  that fans out one broad query plus seven per-category queries to the
  Grants.gov `search2` Opportunities API via `asyncio.gather`, caches the
  result for ten minutes behind an `asyncio.Lock`, and returns: live
  `open_opportunities` (the API's authoritative `hitCount`),
  `closing_within_30_days`, `posted_last_30_days`,
  `unique_agencies_in_sample`, per-category counts for Literacy / STEM /
  CTE / Special Ed / Arts / Health / Civics, a top-funders breakdown
  derived through the same `_derive_agency()` heuristic introduced in
  Phase D (with the catch-all `Federal Agency` placeholder filtered out
  of the chart), a closing-soon list ordered by `days_until` with HTML
  entities decoded, and a twelve-week posted-per-week timeline anchored
  on Monday week-starts. New endpoint
  [`GET /v2/analytics/landscape`](agent_framework_backend/routes/v2_routes.py)
  serves the payload; a Next.js proxy at
  [`src/app/api/v2/analytics`](src/app/api/v2/analytics/route.ts)
  forwards the request from the browser and is allow-listed in
  [`src/middleware.ts`](src/middleware.ts) so the dashboard works on the
  unauthenticated demo path. The frontend
  [`src/components/v2/AnalyticsCanvas.tsx`](src/components/v2/AnalyticsCanvas.tsx)
  was rewritten end-to-end against this contract: animated count-up hero
  stats, an Apple-blue gradient-filled SVG sparkline for the twelve-week
  timeline (with a real "recent vs. earlier" trend indicator), Framer
  Motion staggered category and agency bar charts, a closing-soon table
  with red/amber/blue urgency pills and direct deep-links to Grants.gov,
  loading skeletons, an error card with retry, and a refresh button that
  reports the last-updated timestamp as a relative-time chip. No mock
  data anywhere on the page.

### Changed

- **Real Grants.gov opportunities (Phase D).** Rewrote
  [`agent_framework_backend/services/grants.py`](agent_framework_backend/services/grants.py)
  to call the **Grants.gov `search2` Opportunities API**
  (`POST https://api.grants.gov/v1/api/search2`,
  `{keyword, rows, oppStatuses: "forecasted|posted"}`) as the primary source
  instead of the GSA Search.gov i14y website index, which was returning
  Grants.gov navigation/help pages ("Grant Terminology", "Grant Eligibility",
  department directories) — all of which the Discovery rubric correctly
  disqualified as "Generic landing page", leaving the picker empty. The legacy
  GSA path is retained as a defensive fallback only. Since `search2` does not
  carry award amounts or a populated `agencyName` field, agency attribution is
  now derived in `_derive_agency()` from (1) CFDA / ALN `84.*` codes in the
  title (definitive ED marker), (2) ED-office substrings inside the number
  (`OESE`, `OII`, `OPE-`, `IES-`), then (3) longest-prefix match against
  `_AGENCY_PREFIX_MAP` (ED-, NSF, HHS, HRSA, DOL-, EPA, NEH, USDA, etc.).
  Verified end-to-end against the live API: a literacy search now surfaces
  *Innovative Approaches to Literacy 84.215G* (ED), *OESE Comprehensive
  Centers — Literacy for Students with Disabilities 84.283D* (ED), and
  *Adult Education and Family Literacy Act State Awards*.
- `FOUNDRY_API_VERSION` default bumped from `2024-12-01-preview` to
  `2025-03-01-preview` — required for the Responses API used by
  `OpenAIChatClient` in Agent Framework 1.3.0.
- `_GrantAgentExecutor` calls `agent.run(user_prompt, stream=True)` with the
  prompt as the first positional argument (the SDK signature changed and
  rejects `messages=` keyword usage).
- `_WorkflowInputs` dataclass is now declared **before** the `_Setup`
  executor that uses it as a handler annotation — required by the SDK's
  runtime handler validation, which inspects `__annotations__` and fails on
  forward references.
- `workflow.py` no longer uses `from __future__ import annotations`, because
  the SDK's runtime handler validation reads `WorkflowContext[AgentContext]`
  literally and fails on string-form annotations.
- v2 surface UI: removed on-screen “Full application” card and
  success-probability badge from PDF cover (UX cleanup).

### Fixed

- Foundry 403 `AuthenticationTypeDisabled` on keyless resources — fixed by
  bypassing the SDK's implicit env-file resolution (which auto-injects
  `AZURE_OPENAI_API_KEY`) and constructing `AsyncAzureOpenAI` with the AAD
  token provider directly.
- Foundry 400 BadRequest “Responses API enabled only for api-version
  2025-03-01-preview and later” — fixed by bumping the API version default.
- jsPDF garbled `Ø=Ü` characters from emojis in PDF output — fixed by
  Latin-1 sanitisation in `sanitize()`.
- “II. STATEMENT OF NEED” orphan heading stranded at the bottom of a page —
  fixed by orphan control for `#`/`##` headings, ALL-CAPS section labels,
  lettered subheadings, AND a keep-with-next reservation that includes the
  actual upcoming content block (not just a flat 3-line reservation).

### Security

- API keys never read from environment by the SDK's auto-resolver. We pass
  the credential explicitly to `AsyncAzureOpenAI`.
- `.env.example` documents `FOUNDRY_USE_AAD=true` as the recommended path.
- All v2 endpoints accept `DefaultAzureCredential`; key auth is fallback only.

---

## [v2 prior commits — already on `origin/v2/main`]

These commits landed earlier in the v2 branch and are pushed:

- `4092007` — feat(v2): UI redesign with claude.com palette and Apple Design
  Studio polish (Phase 3). *(Palette has since been swapped for Apple-blue —
  see Unreleased.)*
- `71a1a66` — feat(v2): idiomatic Agent Framework backend with GPT-5.4 (Phase 1).
- `10af8c0` — chore(v2): remove inadvertent secret from .env.example.
- `c34f37a` — chore(v2): adopt GPT-5.4 on Azure AI Foundry as primary model.

The commit `3021df8` — feat(v2): real Microsoft Agent Framework orchestration
+ cinema PDF + live metrics — was the last one that existed only locally. It
and everything in [Unreleased] have since been committed, fast-forwarded onto
`master`, and deployed.

---

## [1.0.0] — 2026-03-21

Initial public release on `master`. Its documentation (`README.v1.md`) was
removed from the tree when v1 itself was deleted; it remains in the git
history.

- Six-agent sequential pipeline backed by raw `AsyncAzureOpenAI` calls.
- NCES Education Data integration (~130K schools).
- Multi-source grant aggregation (Grants.gov + ED.gov + K-12 portals).
- Azure Container Apps deployment via Bicep.
- jsPDF report generation (v1 format, not the cinema PDF).
