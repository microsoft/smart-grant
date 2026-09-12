# Contributing to Smart Grant Request

First — thank you. Every contribution, no matter the size, helps schools secure
funding faster and better. We hold the bar high: contributions should be
**clear, tested, and considered**.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Contributor License Agreement](#contributor-license-agreement)
- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Branching Model](#branching-model)
- [Commit Style](#commit-style)
- [Pull Requests](#pull-requests)
- [Testing](#testing)
- [Design & UX Guidelines](#design--ux-guidelines)
- [Reporting Security Issues](#reporting-security-issues)

---

## Code of Conduct

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or
comments.

## Contributor License Agreement

Most contributions require you to agree to a Contributor License Agreement (CLA)
declaring that you have the right to, and actually do, grant us the rights to use your
contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need
to provide a CLA and decorate the PR appropriately (e.g., status check, comment). Simply
follow the instructions provided by the bot. You will only need to do this once across
all repositories using our CLA.

## Ways to Contribute

- 🐛 **Bug reports** — open an issue using the *Bug Report* template
- ✨ **Feature requests** — open an issue using the *Feature Request* template
- 📖 **Documentation** — typo fixes, clarifications, new guides
- 🧪 **Tests** — increase coverage of agents, routes, components
- 🎨 **Design** — UI polish, accessibility, new component variants
- 🌐 **Localization** — translations of UI strings and prompts

## Development Setup

Prerequisites: **Node 20+**, **Python 3.11+**, **Docker** (optional but recommended).

```bash
git clone https://github.com/microsoft/smart-grant.git
cd smart-grant

# Frontend deps
npm install

# Backend deps
cd agent_framework_backend
python -m venv .venv
. .venv/Scripts/Activate.ps1   # Windows PowerShell
# requirements-dev.txt traz pytest e ruff, que a producao nao carrega.
# Sem ele os comandos da secao de testes nao existem.
pip install -r requirements.txt -r requirements-dev.txt
cd ..

# Configure environment
cp .env.example .env.local
# Fill in Azure OpenAI / Foundry credentials

# Run both (concurrently)
npm run dev
```

Open http://localhost:3000.

### Working on Pulse (usage analytics)

Pulse writes an append-only event log to Azure Blob Storage. In production it
authenticates with Entra ID only — the storage account is provisioned with
`allowSharedKeyAccess: false`, so a shared key cannot work there even by
accident.

To develop it locally without an Azure account, run Microsoft's emulator:

```bash
npx --yes -p azurite azurite-blob --location ./.azurite --blobPort 10000
```

Then set, in `.env.local`:

```
PULSE_STORAGE_CONNECTION_STRING=UseDevelopmentStorage=true
```

Leave `PULSE_STORAGE_ACCOUNT_URL` empty — when it is set it always wins, so a
forgotten variable can never downgrade a real install to key auth.

With the emulator running, `pytest` also picks up
`tests/test_event_log_integration.py`, which exercises the real Azure SDK
(append semantics, the create-race guard, 404-as-empty). Without it those
tests skip with an explicit reason and the rest of the suite still runs.

Pulse is entirely optional: with nothing configured the dashboard says it is
not recording rather than inventing numbers.

## Branching Model

| Branch       | Purpose                                              |
| ------------ | ---------------------------------------------------- |
| `main`       | Development trunk. **Target this for PRs.**          |
| `feat/*`     | Feature branches off `main`.                         |
| `fix/*`      | Bugfix branches.                                     |
| `docs/*`     | Documentation-only changes.                          |

## Commit Style

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(agents): add Claude Sonnet provider via Azure AI Foundry
fix(ui): correct contrast ratio on primary buttons (a11y AA)
docs(readme): add deploy-to-Azure button
chore(deps): bump next from 14.2.0 to 14.2.5
```

Scopes: `agents`, `ui`, `api`, `data`, `pdf`, `deploy`, `docs`, `deps`, `ci`.

## Pull Requests

1. Fork → branch from `main` → commit → push → open PR against `main`.
2. Fill the PR template completely. Screenshots/GIFs are required for UI changes.
3. CI must be green (lint, type-check, tests, build).
4. At least one maintainer approval required.
5. Squash-merge with a Conventional Commit title.

## Testing

```bash
# Frontend
npm run lint
npm run build         # type-checks + production build

# Backend
cd agent_framework_backend
pytest -q
```

Add tests for any new agent, route, or non-trivial UI logic.

## Design & UX Guidelines

Smart Grant Request aims for **Apple Design Studio quality**. UI contributions
must respect:

- **Palette** — light, warm; never pure black or pure white as primary surfaces
- **Spacing** — generous, on an 8px grid
- **Typography** — serif for headings, sans for body, `tabular-nums` for numbers
- **Motion** — subtle, purposeful; avoid bouncy easings
- **Accessibility** — WCAG AA minimum, keyboard navigable, semantic HTML

See [`docs/design-system.md`](docs/design-system.md) for tokens and components.

## Reporting Security Issues

**Do not open a public issue.** See [`SECURITY.md`](SECURITY.md) for our
responsible-disclosure process.

---

Thank you for making Smart Grant Request better. ✨
