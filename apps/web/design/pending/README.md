# Pending: login page redesign

**Status:** mockup delivered, awaiting user approval per this repo's L2 governance gate. Not implemented, not approved, not wired into the real app. Parked here so it isn't lost between sessions.

## What's here

- `login-v1.html` — standalone, self-contained preview of the new `/login` direction. Open directly in any browser (no build step, no server, no Google client ID needed). Not a Next.js page, not linked from `app/`, does not affect the real build.

## What changed vs. the current `/login`

Current page (`app/login/page.tsx` + `LoginClient.tsx`) is a plain centered card on flat black — functional but no product context or visual identity.

New direction — split-screen, deliberately calmer than the marketing-site redesign (a login screen's job is to feel trustworthy, not sell):
- **Left** — same real copy, a proper styled Google button instead of the raw Google-rendered widget, and a new trust row (`0% commission` / `No YouTube access requested` / `Google sign-in only`) surfacing facts that were buried mid-paragraph before.
- **Right** (hidden below 900px) — the actual production `.browser-alert` "celebration" component and CSS, copied verbatim from `app/overlay/[overlayId]/page.tsx` + `app/styles.css`, showing a real alert firing. Not a new graphic — the same component that renders on a creator's real stream.

Tokens used are this app's real `:root` set from `app/styles.css` (`--background: #0f0f10`, `--card: #1a1a1b`, `--border: #2e2e2f`, `--accent: #F7C948`, Rajdhani/DM Sans/JetBrains Mono) — not the marketing site's `--color-mktg-*` tokens, which are close but not identical. No new palette, no new type system.

## Governance — required before implementation

This repo's `AGENTS.md` → `../bharatstudio-requirements/governance/AGENTS.md` requires a stop-and-approve gate for L2 (product/UI) work before code changes. The scope already drafted and shared with the user:

| | |
|---|---|
| **Scope** | Visual/layout redesign of `/login` only — `apps/web/app/login/page.tsx`, `LoginClient.tsx`, and the relevant CSS rules in `app/styles.css` |
| **Explicitly NOT touched** | Google OAuth flow, credential exchange, terms-gate/onboarding redirect logic, error handling — all of `LoginClient.tsx`'s auth logic stays byte-identical |
| **Data impact** | None — no new fields, no new requests, no auth behavior change |
| **Test plan** | Manual check: sign-in still completes and redirects correctly (terms gate / onboarding / dashboard paths), responsive check at 375/768/1280, existing `LoginClient.tsx` tests (if any) still pass |
| **Rollback** | Revert the CSS/JSX diff — no schema/data change to unwind |

## Resuming this later

Get explicit approval (as-is, or with changes) on `login-v1.html`, then implement into the real files listed above. Nothing has been touched in `app/login/` or `app/styles.css` yet.
