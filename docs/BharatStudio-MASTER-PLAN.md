# BharatStudio — Master Plan

**Version:** 3.0 · **Date:** 2026-09-02
**Supersedes:** `BharatStudio_Final_Product_Payments_Platform_Plan.md` (30 Aug 2026) and v1.0/v2.0 of this document.
**Basis:** verified code audit across 14 repos · binding governance (`bharatstudio-requirements`: tasks L00–L13 + PLATFORM-WP0, `active/launch/*` authorities) · Sept 2026 market research · independent product and GTM reviews.

> **This is the single plan.** No looking here and there. The 30-Aug document contained the exact product design; this document carries all of it forward, adds everything the codebase already has, and defines each item as a task with a status and an owner. Where the 30-Aug plan and the code disagree, this document states which one wins and why.

## Decisions locked in this revision — 2026-09-02

| # | Decision | Effect |
|---|---|---|
| 1 | **Queue counts 1 / 2 / 3 / 5** | Code has 1/3/5/10 (`app_private.tier_queue_count`, migration `0070`). Retier migration required. |
| 2 | **Eight entitlement dimensions, closed set** | `queueCount`, `ttsEnabled`, `allowedQueueModes`, `maxVisibleItems`, `maxCharLimit`, `maxDisplayMs`, `quietMode`, `approvalRequired`. No ninth without an explicit decision; `lottieEnabled` stays a hidden flag under L20. |
| 3 | **Studio ₹599; TTS 20K / 40K / 60K** | 64% worst-case gross margin. ₹799 list and the ₹499 founder SKU are dropped. |
| 4 | **Watermark on Free only** | Amends `04_TEMPLATE_LIBRARY_AUTHORITY.md`, which currently requires it on Free **and Pro**. |
| 5 | **TTS overage: hard stop + upgrade prompt** | No top-up SKU, no silent downgrade to the browser voice. Free keeps browser TTS as a tier feature. |
| 6 | **Viewer accounts: full Level 3 in v1** | L14 moves onto the critical path in full — a second auth surface, DPDP deletion, private lifetime dashboard, opt-in public profiles. Largest scope addition in this plan. |
| 7 | **Moderator seats 0 / 0 / 2 / 5** | Published in 3.6 — **but NOT ENFORCED. See 3.14.** The values are advertised on the pricing page and nothing in the schema or API limits seat counts. |
| 8 | **YouTube in v1, chat bot included** | Amends L10. Twitch and Kick stay Phase 2. **Enterprise stays out of v1.** Google OAuth verification and Data API quota become launch gates — start both today (10.2). |
| 9 | **Companion: nothing deferred** | Full remaining feature list in 7.11 — 22 items across web, mobile and desktop. |
| 10 | **Enterprise 85/15 is enterprise ↔ creator, via Razorpay Route** | BharatStudio takes 0% and holds nothing. Position on the Route parent: **enterprise-owned, and we hold that line** — enquiry sent now (9.2). |
| 11 | **The 600 templates already exist — import them later** | **QUALIFIED 2026-09-07: they exist in a form that cannot be imported. See 3.16.** L20's import pipeline is built (migration 0106); the catalogue is raw HTML per design, which the plan forbids at every tier. |
| 12 | **No tip-volume brackets** | Pricing stays per-month with no per-transaction dimension. Revisit at ~100 paying creators. |
| 13 | **Governance never gates code** | We build and test internally, continuously. Every governance record is still written and kept current — as documentation, not as an approval gate. Only external reviews (Google, Razorpay, counsel) gate *launch*, and never *development*. |
| 14 | **Four products, one brand, one domain** | Alerts, Companion, Stream, Mirror. Product areas under `bharatstudio.in`, differentiated by a per-route accent token — not separate sites. See 2.7–2.11. |
| 15 | **Companion is a separate product surface, corrected** | L07 says so in its own objective. Earlier revisions of this document called it "not a product" — that was wrong. See 1.1. |
| 16 | **Companion action catalogue is conditional** | Two-layer gate: entitlement decides what exists, activation decides what is enabled. Alerts actions appear only when Alerts is actually running; OBS / Mirror / Stream actions are available to everyone. New task **L24**. |
| 17 | **Companion is a separate product; its pricing is configurable** | Decided 2026-09-07. Companion access becomes an entitlement independent of the Alerts tier. `companion_action_limit()` (0042) and `companionActionGroups` (0089) both key off the Alerts tier today and cannot express "Companion, no Alerts" — schema change required. See 3.13. |
| 18 | **Mirror is sold on its own licence key** | Decided 2026-09-07. Validates L13's Keychain / Credential Manager storage. No account, no backend. Store listings unblocked. |

## Status legend

| Mark | Meaning |
|---|---|
| **DONE** | Implemented, tested, and recorded in a governance task file. |
| **BUILT–UNGATED** | Code exists and passes locally, but a deployment / provider / legal gate is still open. |
| **PARTIAL** | Some slices shipped; named slices remain. |
| **TODO** | Designed here, no code. |
| **[OWNER]** | Needs a decision from Sukhdev before anyone builds it. |
| **v2** | Deliberately out of v1. Retained here so it is not re-invented later. |

---

# PART 1 — PRODUCT DEFINITION

## 1.1 What actually exists

| # | Product / service | Repos | Governance | Reality |
|---|---|---|---|---|
| # | Product / service | Repos | Governance | Needs a BharatStudio account? | Reality |
|---|---|---|---|---|---|
| 1 | **BharatStudio Alerts** — creator tipping + live alerts | `alerts`, `marketing` | L00–L10 | Yes | v1 tipping loop feature-complete. Never deployed. Zero customers. |
| 2 | **BharatStudio Companion** — control surface: phone + native desktop helper, OBS pairing, push, configurable action grid | `companion-mobile`, `companion-desktop` | **L07** | Yes — bundled with Alerts entitlements | Core web/API/mobile slices implemented. Native + store gates open. |
| 3 | **BharatStudio Stream** — mobile live streaming, RTMP out to YouTube/Twitch/Kick/Facebook | `stream-ios`, `stream-android` | L11, L12 | No | Substantial. iOS ~83 commits, ~40 shipped features. Separate pricing. |
| 4 | **BharatStudio Mirror** — phone→desktop screen mirroring, AirPlay/CMIO/scrcpy, MP4 recording | `stream-mac`, `stream-windows` | **L13** | **No** — LAN-only, own license key | **Implemented 2026-08-28.** Device QA + code-signing remain. |
| 5 | **Platform** — shared identity + entitlements | `platform` | PLATFORM-WP0 | — | Real Go service, 5,716 LOC, 18 migrations, tests pass. |
| 6 | **Admin** — internal ops console | `admin` | FRD-001 | — | Real Next.js app, builds and tests pass. |

Support repos: `crons`, `infra`, `requirements`, `archive`.

**Corrected 2026-09-02.** An earlier revision of this document called Companion "a surface of Alerts, not a product." That was wrong. L07's own objective reads: *"Ship BharatStudio Companion as a **separate product surface** bundled with Alerts entitlements."* Companion has capability Alerts web cannot have — native OBS WebSocket pairing with signed scoped commands, Keychain / Credential Manager storage, APNs/FCM push, offline/reconnect, revocation, redacted support bundles, and a configurable 4/8/16 page grid over an 8/16/32/64 action-slot ladder. **A configurable grid of one-tap actions paired to your OBS is a Stream Deck**, which is a product category, not an accessory.

**Mirror is the most standalone thing in the portfolio.** L13 specifies "no network egress beyond local LAN for mirroring paths" and stores its license key in the OS credential store. It needs no BharatStudio backend, no account, and no other product to be complete.

## 1.2 Scope of this plan

**This plan covers BharatStudio Alerts and Companion** — the two products that share an account, an entitlement model and a subscription.

**Stream (L11/L12) and Mirror (L13) are separate product lines** with their own pricing and gates. They are not blocked on anything here and nothing here is blocked on them. They appear in this plan in exactly two places: the brand architecture in 2.7–2.10, because all four share one parent brand and one website, and the Companion action catalogue in L24, because Companion is the natural control surface for all four.

## 1.3 The core loop

```text
Viewer intent
    ↓
Creator-owned payment rail
    ↓
Verified payment status (webhook or reconciliation)
    ↓
Canonical BharatStudio LiveEvent
    ↓
Durable queue (sequenced, no-drop)
    ↓
Moderation / TTS / visual rules
    ↓
OBS overlay + platform chat + widgets
    ↓
Creator acknowledgement / community interaction
```

Every proposed feature is tested against one question:

> Does this reduce payment friction, increase meaningful viewer interaction, increase creator monetisation, or improve live operational reliability?

If not, it is not a launch priority.

## 1.4 Non-negotiable boundaries

### Two separate payment domains

1. **BharatStudio SaaS billing** — BharatStudio charges the creator ₹199 / ₹399 / ₹599. BharatStudio is merchant of record for its own software subscription only.
2. **Creator monetisation payments** — the viewer pays the creator. The creator owns the PSP merchant relationship. Settlement is provider → creator. BharatStudio receives only the status needed to create live events, and (where authorised) initiates refunds on the creator's behalf.

Separation must hold in code, data model, credentials, dashboards and legal terms. `PlatformBilling` and `CreatorPaymentConnections` are separate modules and must never share a table.

### These concepts must never exist in the schema

```text
creator_balance
withdrawable_amount
bharatstudio_held_funds
payout_request
```

**Verified:** absent from all 79 migrations as of 2026-09-02.

### No personal-UPI mode, no notification scraper

If BharatStudio cannot independently verify a payment through a merchant PSP/gateway/bank status API or signed webhook, that rail is not enabled. Client-side UPI "success" is not proof of settlement. No Android notification parsing, ever.

### Correctness is never a premium feature

Never paywalled on any tier, including Free: payment verification, immutable payment/event records, webhook dedupe, reconciliation, refund state tracking, no-drop queue durability, retry/replay, security/authorization, privacy controls, audit logging, accessibility, downgrade preservation, payment/legal disclosures.

## 1.5 What Stream gives Alerts in v2 (an asset, not a problem)

Stream already ships things Alerts does not have: OAuth for four platforms, YouTube/Twitch live chat ingestion, a native alert engine, and `AlertTTSBridge`. When Alerts needs connectors (Part 6, L15), the reference implementation already exists in `stream-ios` / `stream-android`. Note that `services/youtube-poller-go` in the Alerts repo is an **empty directory** — nothing there to reuse.

---

# PART 2 — POSITIONING AND BRAND ARCHITECTURE

## 2.1 Statement

> **Turn viewer support into live stream interaction.**
>
> Your creator account. Your payment provider. Your money. BharatStudio makes every verified support event interactive, visible and manageable on stream.

## 2.2 Avoid these framings

- "UPI donation alerts"
- "Cheap Streamlabs for India"
- "Razorpay alerts"
- "OBS alerts with Hindi TTS"
- "Super Chat alternative"

Those are features and can be copied in a sprint.

## 2.3 Where "0% commission" sits

0% is table stakes in this category, not a differentiator — several competitors also take 0% on the tip itself. Use it as a **trust statement**, not the headline. The headline is the interaction layer.

## 2.4 Gateway fees — the locked copy rule

BharatStudio takes 0% and does not charge the transaction. Whatever gateway the creator connects charges its own MDR, and that is between the creator and their gateway. Site copy must:

- state BharatStudio's 0% clearly;
- state that the creator's chosen provider sets its own fees;
- show provider fees in any calculator, on both sides of a comparison;
- never advertise "0% forever" as a property of the payment rail.

This is already implemented on the marketing site (footer disclaimer + commission calculator showing gateway fees in both columns). Do not regress it.

## 2.5 Differentiators, by how hard they are to copy

| Differentiator | Defensibility |
|---|---|
| No-drop durable delivery with sequenced replay | High — architectural, took 79 migrations |
| Indian-language premium TTS with amount-tiered character limits | Medium — Sarvam is available to anyone, the rules layer is not |
| Creator-direct settlement with zero custody | Medium — a business-model choice competitors can copy but rarely do |
| Interaction menu / paid challenges / support votes | Medium-high once shipped |
| Cross-platform normalised event model | High — the canonical LiveEvent is already ~80% source-agnostic |
| 0% commission | **Low** — table stakes |

## 2.6 Target users

Priority: creators who stream regularly, already use OBS/Streamlabs, already receive Super Chats / UPI QR tips / subs, care about stream presentation, have enough activity that ₹199–₹399/month is a tool decision, want Indian-language TTS, and dislike keeping a phone alive to scrape notifications.

Later: Twitch creators, Kick creators, Instagram professional creators, musicians / educators / artists / fitness creators, agencies and creator networks, esports/tournament channels, brands running live campaigns.

## 2.7 Brand architecture — one brand, one domain, four product areas

Four products, four domains, is four things that each rank nowhere. The masterbrand holds.

| | One site | Separate sites per product |
|---|---|---|
| SEO | One domain compounds authority | Four domains each start at zero |
| Legal surface | One set of privacy / terms / refunds / grievance | ×4 — and L08 is already stuck getting **one** set signed off |
| Support, status, analytics | One each | ×4, forever |
| Cross-sell | Free — same person, same stream | Paid, via ads or luck |
| Shared login | Matches what Platform already gives you | Four brands, one account, confusing |

The honest counter-argument is that these products have genuinely different acquisition motions: Stream and Mirror are app-store and download discovery, mobile-first or desktop-first; Alerts is web discovery through OBS. That is real — but it is a **page** problem, not a **domain** problem. Strong per-product pages on one domain solve it. Four domains solve it and cost the SEO, the cross-sell, and every shared surface.

### URL structure

```
bharatstudio.in/              parent home, product chooser
bharatstudio.in/alerts/       Alerts — subscription, account required
                              └── Companion shown here as an included surface
bharatstudio.in/stream/       Stream — app store, own pricing
bharatstudio.in/mirror/       Mirror — license key, no account needed
bharatstudio.in/pricing/      all tables, clearly separated
bharatstudio.in/legal/        shared
```

Do not buy separate domains. Any defensive domains already held get 301'd into the sections.

Companion gets its own top-level page **only** when it can control OBS without Alerts — see L24 and Part 13, decision 9.

## 2.8 Naming

- **Parent:** BharatStudio
- **BharatStudio Alerts** — get paid on stream
- **BharatStudio Stream** — go live from your phone
- **BharatStudio Mirror** — your phone on your desktop
- **Companion** — **rename required before it ships standalone.** See 2.9.

Descriptive names are correct here. There is no brand equity yet, so a name that says what the thing does is worth more than a clever one, and "BharatStudio Stream" is searchable in an app store in a way an invented name is not.

## 2.9 Two naming problems, one of them serious

**"Companion" is already taken in exactly this category.** *Bitfocus Companion* is a widely-used open-source Stream Deck controller for OBS. Shipping a paid OBS controller called Companion means launching into the one market where that name already means someone else's product. Rename before it ships standalone, not after.

**There is already a collision inside the repos.** L13 specifies *"Companion TCP: TCP server on port 27190 receiving stream from CompanionApp"* — that "CompanionApp" is a **different** Companion from L07's. And `bharatstudio-companion-desktop/` contains a `windows-mirror-test/` folder that belongs to Mirror. Two meanings, one word, already tangled in the tree.

## 2.10 Visual differentiation — the cheap mechanic

The token layer in `bharatstudio-marketing/app/globals.css` already supports this: `--color-gold: #F7C948` as the brand accent, `--color-cta: #3B7EF6`, and a full `--color-mktg-*` neutral ramp.

**Vary per product:** one accent token, scoped by route, plus one wordmark lockup.

| Product | Accent direction |
|---|---|
| Alerts | Gold — keep it, it is the flagship |
| Stream | A live/broadcast hue (red or magenta family) |
| Mirror | A cool neutral-tech hue (cyan or steel) |
| Companion | Inherits Alerts gold while bundled; gets its own the day it splits |

**Share everything else:** typeface, spacing scale, the card-bezel component system, nav, footer, every legal page. Four accents off one system reads as a family. Four design languages reads as four weak brands.

## 2.11 Site work required

The marketing site is currently wrong in two directions at once. `/features` opens with **"Two products. Zero commission."** and names Alerts and Companion as co-equals — but Companion is bundled, and a grep of the entire site for Stream or Mirror returns **zero references**. Two real product lines are invisible.

| # | Item | Effort |
|---|---|---|
| 1 | Fix `/features` — Companion is a bundled surface of Alerts, not a co-equal product | Small |
| 2 | Build `/stream/` product page | Copy + screenshots, not engineering |
| 3 | Build `/mirror/` product page | Copy + screenshots, not engineering |
| 4 | Move `/apps/alerts/` → `/alerts/`; fold `/apps/companion/` in as a section | Small |
| 5 | Add per-product accent scoping to the token layer | Small |
| 6 | Split the pricing page into clearly-labelled per-product tables | Small |
| 7 | Rename Companion before it ships standalone | Naming, not code |

Roughly a day of engineering. The heavier item is that Stream and Mirror have **no marketing copy at all**.

---

# PART 3 — PRICING & ENTITLEMENTS (FINAL — LOCKED)

This part is the single source of truth for every number. It replaces §42–§51 of the 30-Aug plan and every earlier draft in this document. Nothing here changes again without a governance amendment.

## 3.1 Plan prices

| Plan | Price (GST-inclusive) | Net after 18% GST |
|---|---:|---:|
| Free | ₹0 | ₹0 |
| Pro | ₹199 / month | ₹168.64 |
| Creator | ₹399 / month | ₹338.14 |
| Studio | ₹599 / month | ₹507.63 |
| Enterprise | Custom | Contract |

BharatStudio transaction commission: **0% on every tier**, including Enterprise.

**Changed from 30-Aug:** that plan proposed Studio ₹799 list with a ₹499 founder price. That is dropped. One Studio price, ₹599. There are zero paying subscribers today, so no grandfathering obligation exists yet and no founder SKU is needed.

## 3.2 The eight entitlement dimensions — FINAL VALUES

These eight are the complete set. No ninth dimension gets added without an explicit decision.

| Key | Free | Pro | Creator | Studio | Currently in code |
|---|---|---|---|---|---|
| `queueCount` | **1** | **2** | **3** | **5** | 1 / 3 / 5 / 10 — **must change** |
| `ttsEnabled` | false | true | true | true | boolean, not tier-gated — **must change** |
| `allowedQueueModes` | `fifo` | `fifo`, `stacked`, `pills`, `aggregated` | + `priority` | same as Creator | **published — migration 0083** |
| `maxVisibleItems` | 3 | 5 | 8 | 12 | wired, values unset |
| `maxCharLimit` | 100 | 150 | 300 | 500 | wired, values unset |
| `maxDisplayMs` | 6,000 | 8,000 | 12,000 | 20,000 | wired, values unset |
| `quietMode` | false | true | true | true | wired, values unset |
| `approvalRequired` | false | false | true | true | wired, values unset |

**Premium TTS monthly character quota** is carried on the entitlement alongside `ttsEnabled`:

| Plan | Premium TTS chars/month | Sarvam cost at ₹0.003/char |
|---|---:|---:|
| Free | 0 (browser/device TTS only) | ₹0 |
| Pro | 20,000 | ₹60 |
| Creator | 40,000 | ₹120 |
| Studio | 60,000 | ₹180 |

**Changed from 30-Aug:** that plan proposed 20K / 50K / 100K, which is what made ₹499 Studio unviable. 20K / 40K / 60K at ₹599 is viable — see 3.3.

### Overage behaviour — DECIDED

When a paid creator exhausts the monthly premium quota: **hard stop plus an upgrade prompt.** No paid top-up, and **no silent downgrade to the browser voice.**

- The alert still fires — visual only, with the message shown on screen.
- The overlay and dashboard both show that premium TTS is exhausted.
- The dashboard surfaces an upgrade prompt naming the next tier's quota.
- A quota bar is visible from ~70% consumption so exhaustion is never a surprise mid-stream.

**This does not remove browser TTS from Free.** Free's baseline is still basic device/browser TTS (§7.5) — that is a tier feature, not an overage fallback. The decision is that a *paid* creator who runs out does not get quietly swapped onto a worse voice; they get told.

`lottieEnabled` exists in the schema (one reference) but is not one of the eight. It is folded into the template/asset entitlement under L20 and is not an independent plan dimension.

## 3.3 Margin check on the locked structure

Worst case = the creator burns 100% of the TTS quota every month.

| Plan | Net revenue | Max TTS cost | Worst-case gross margin |
|---|---:|---:|---:|
| Pro | ₹168.64 | ₹60 | **64.4%** |
| Creator | ₹338.14 | ₹120 | **64.5%** |
| Studio | ₹507.63 | ₹180 | **64.5%** |

At a realistic 25% quota utilisation: Pro 91%, Creator 91%, Studio 91%.

TTS is the only meaningful variable cost per creator. Infra (Cloud Run + Postgres + Cloud Tasks) is shared and does not scale per-creator at this size.

## 3.4 Watermark and attribution — DECIDED

- **Free:** BharatStudio attribution appears on the public tip page **and** on the OBS alert.
- **Pro, Creator, Studio, Enterprise:** no watermark anywhere.

**This amends approved governance.** `active/launch/04_TEMPLATE_LIBRARY_AUTHORITY.md` currently requires the watermark on Free **and Pro**. Removing Pro requires an amendment record before the entitlement values are published (Part 12, item 2).

The 30-Aug plan's §45 line "Do not add a BharatStudio watermark to OBS alerts on Free" is **rejected**. Free is the acquisition surface; the watermark is how Free advertises. Without it, Free is pure cost.

## 3.5 Limits already configured in code — no change

| Limit | Value | Source |
|---|---|---|
| Companion action/layout page size per tier | 8 / 16 / 32 / 64 | migration `0042` |
| Minimum tip | ₹10 (1,000 paise), creator-configurable upward | `apps/api/src/routes/public.ts:139` |
| Tip-page rate limit | 20 requests / minute / IP | `apps/api/src/routes/public.ts` |
| TipIntent expiry | 15 minutes | `apps/api/src/routes/public.ts:209` |
| TTS synthesis hard caps | 2,000,000 bytes, 60,000 ms | `apps/api/src/routes/tts.ts` |
| Public history read cap | 60 default, 100 max | `apps/api/src/routes/public.ts:75` |

## 3.6 Public tier summary (this is the marketing table)

| Capability | Free | Pro ₹199 | Creator ₹399 | Studio ₹599 | Enterprise |
|---|---|---|---|---|---|
| Unlimited verified tips | Yes | Yes | Yes | Yes | Yes |
| BharatStudio commission | 0% | 0% | 0% | 0% | 0% |
| Public tip page | Yes | Yes | Yes | Yes | Yes |
| OBS alerts | Yes | Yes | Yes | Yes | Yes |
| No-drop durable delivery | Yes | Yes | Yes | Yes | Yes |
| Basic (browser) TTS | Yes | Yes | Yes | Yes | Yes |
| Premium AI TTS (11 Indian languages) | — | 20K chars | 40K chars | 60K chars | Custom |
| Active queues | 1 | 2 | 3 | 5 | Custom |
| Queue modes | FIFO | + stacked, aggregated | + priority | + approval | Custom |
| Quiet mode | — | Yes | Yes | Yes | Yes |
| On-screen items at once | 3 | 5 | 8 | 12 | Custom |
| Message character ceiling | 100 | 150 | 300 | 500 | Custom |
| Alert display time | 6s | 8s | 12s | 20s | Custom |
| BharatStudio watermark | Yes | — | — | — | — |
| Custom branding / Lottie | — | Basic | Yes | Advanced | Shared brand kit |
| Searchable history | 30 days | 90 days | 1 year | Long term | Contract |
| CSV export | — | Yes | Yes | Yes | Yes |
| Moderator seats | 0 | 0 | 2 | 5 | Custom |
| Support goals | 1 | 3 | 10 | 10 | Custom |
| External platform connectors | 0 | 1 | 2 | 3 | Custom |
| Paid challenges | — | — | v2 | v2 | Custom |
| Advanced analytics | — | Basic | Yes | Yes | Custom |

Rows below the watermark line are v2 unless marked; they are published only when the underlying task closes.

## 3.7 Internal commercial limits — not published

| Capability | Free | Pro | Creator | Studio | Enterprise |
|---|---:|---:|---:|---:|---:|
| BharatStudio channels at launch | 1 | 1 | 1 | 1 | Contracted |
| Additional channels | No | No | v2 | v2 | Yes |
| Pending visual items | 20 | 50 | 150 | 500 | Contracted |
| Event bindings | 3 | 5 | 10 | 20 | Custom |
| Saved alert presets | 1 | 2 | 4 | 8 | Custom |
| Web read-only sessions | 2 | 3 | 5 | 8 | Custom |
| Owner/control sessions | 1 | 1 | 2 | 4 | Custom |
| Asset storage | 0 | 100 MB | 250 MB | 1 GB | Contract |

These stay out of the pricing page. They exist so support and engineering have a defined ceiling.

## 3.8 Retention

Dashboard visibility is separate from required payment/audit retention.

| Plan | Searchable creator history |
|---|---|
| Free | 30 days |
| Pro | 90 days |
| Creator | 1 year |
| Studio | Long term |
| Enterprise | Contract |

**A downgrade never deletes accepted payments, refunds, or audit history.** It only narrows what the dashboard will search. This is already enforced: `enforce_queue_count_entitlement` pauses excess queues oldest-first and never deletes or closes one.

## 3.9 Grandfathering and downgrade

- Stored subscription price is authoritative for an active subscriber.
- Price is held for 12 months from subscription start, with a 30-day grace on renewal.
- On downgrade, excess queues are **paused**, newest-first, never deleted (migration `0070`).
- On downgrade, stored assets over the new quota become read-only, not deleted.

## 3.10 Referral

Approved parameters, no change: the referral/growth engine shipped in `9679213` / migration `0076`. Two accepted risks are already recorded against L03 — self-referral via a second account, and credit stacking with a promotional price. Both are accepted for v1 at zero-subscriber scale and revisited at 100 paying creators.

## 3.11 Deliberately NOT set now

Do not invent values for these before there is usage data:

- Tip-volume brackets or any per-transaction pricing tier.
- TTS overage pricing (see Part 13, decision 1).
- Enterprise seat pricing.
- Annual-plan discount.
- Regional pricing.

---

> **Corrected 2026-09-07.** This table previously listed Studio as `+ approval` and
> omitted `pills` entirely. Both were wrong and were fixed in code long before this
> document caught up — migration `0083_v1_l03_queue_mode_ladder_correction.sql`.
>
> `approval` is **not a queue mode**. The real type is
> `fifo | stacked | pills | aggregated | priority`
> (`apps/api/src/domain/entitlement-policy.ts:1`), and `approvalRequired` is a separate
> boolean in the same `EntitlementPolicy`. The original table conflated a mode with a
> flag that already existed independently, and silently dropped `pills`, a real mode.
>
> Studio and Creator having the same mode list is correct: Studio's additional power is
> `approvalRequired` plus the other dimensions, not another mode. `pills` sits at Pro
> (owner decision, 2026-09-06) because it is a display variant, not a capability.
>
> This stale row was caught when it caused the marketing site to be built to the wrong
> ladder. Anything downstream that was generated from the old table needs rechecking.

## 3.14 Moderator seats are advertised but not enforced — found 2026-09-07

**Decision 7 records moderator seats as 0 / 0 / 2 / 5, section 3.6 publishes them as
the marketing table, and the pricing page now advertises "2 moderator seats" and
"5 moderator seats". Nothing enforces any of it.**

Verified by search across the whole repository: `moderator` exists only as a
`channel_memberships.role` value. There is no seat-count column, no
`tier_moderator_seat_limit()` function, no CHECK constraint, and no route-level
check. A Free-tier channel can add unlimited moderators today.

This was surfaced while amending `06_BACKEND_GAP_REMEDIATION_AUTHORITY.md`, when the
amending agent could not find a citation for the claim and said so rather than
recording it as implemented.

**The plan also contradicts itself here.** Decision 7 and 3.6 present seats as
decided and published, while 10.5 lists "Moderator seats" under *"Do not start these
until there are paying creators generating numbers"*, triggered by "creators with
teams". Both cannot be true, and the marketing site was built from the first one.

**Why this matters more than an unenforced limit usually would:** the failure is
ordered the wrong way round. Enforcement is absent *now*, when the numbers are
already advertised, so the first creators can freely exceed a limit they were told
exists. Adding enforcement later is then a breaking change that removes access
people already have — the most expensive kind of correction, and one that lands on
exactly the team-sized creators a Studio plan is aimed at.

**Options, in order of my preference:**

1. **Build the enforcement before launch.** Small: a per-tier seat function in the
   same shape as `tier_queue_count()`, plus a check at the point a membership is
   added. The advertised numbers become true and nobody is grandfathered into a
   state that has to be taken away.
2. **Remove the seat rows from the pricing page** and reinstate them when 10.5's
   trigger fires. Honest, and costs nothing but a marketing edit.
3. Leave it. Cheapest today, most expensive later, and it publishes a limit that is
   not real.

Doing nothing is the one option that gets worse with every creator who signs up.
[OWNER] decision required.


## 3.15 BharatStudio cannot issue a refund — established 2026-09-07

Found while extracting the `CreatorPaymentProvider` interface (L19). The codebase
**reconciles refund status** from the provider (`services/payment-webhook-go/
internal/reconcile/refund.go`, and the POST refund route only re-runs that
reconciliation) but contains **no call that initiates a refund**. Razorpay's
capability object therefore reports `supportsRefunds: false`, and the unimplemented
provider methods throw rather than returning a fabricated success.

**This is correct, not a gap.** Under 1.4 BharatStudio holds no funds and is not in
the settlement path; money lands in the creator's own connected account. A refund is
therefore the creator's action in their provider dashboard, and BharatStudio's job
is to observe it and reflect it — which is exactly what it does.

**Three places already depend on this being true, and they are consistent:**

- Support-goal progress is a live sum of captured payments minus **processed**
  refunds (3.x / migration 0102), so an observed refund reduces progress with no
  action required from us.
- Part 11's "refund failures" reliability metric watches `refunds.status='failed'` —
  an observation, not an operation we perform.
- 10.7 cut refundable multi-contributor challenges precisely because N independent
  refund operations could each fail. That cut is reinforced by this finding: we
  could not perform those refunds even if we wanted to.

**What must not happen:** any future feature that assumes it can issue a refund —
L17 paid challenges is the obvious candidate — must gate on
`connectionCapabilities().supportsRefunds` rather than assuming. Building a refund
path would mean either entering the settlement flow (forbidden by 1.4) or driving
the creator's provider account on their behalf, which is a different product with a
different compliance posture. Neither is a small change.


## 3.16 The 600 templates cannot be imported in their current form — found 2026-09-07

Decision 11 says the 600 templates already exist and only need an import pipeline.
The pipeline is now built (migration 0106, `scripts/template-import/`). Checking the
real catalogue against it produced two facts that change what that decision means.

**Verified directly in `contracts/template-catalogue.json`:**

| Field | Value |
|---|---|
| `catalogueId` | `visuals-v6` |
| `designIdPattern` | `BSA-{001..600}` |
| `runtimePackageShape` | `visuals-v6/designs/BSA-{id}/{index.html,design.json,review.md}` |
| `runtimePackagesVerified` | **241** |

**Problem one: the format is the one thing the plan forbids.** Each design's runtime
package is an `index.html` — raw HTML per template. This document's own capability
table says *"Arbitrary HTML/CSS/JS — Never"* at every tier, twice (lines 1277 and
1524). The overlay renders on a live stream inside the creator's OBS; importing
authored HTML would make the template catalogue an arbitrary-code execution surface
aimed straight at it. The import validator correctly rejects them, and that rejection
is the system working, not a bug to route around.

There is no HTML-to-safe-render-document converter, and writing one is not a small
job: it is a rendering-semantics problem, not a parsing one.

**Problem two: 359 of the 600 are unverified.** Only 241 runtime packages passed the
catalogue's own integrity check. Whatever format is chosen, the import is partial.

**What is actually importable today:** `design.json` metadata — name, category, tier.
Enough to populate a catalogue listing; not enough to render anything.

**This does not block v1.** v1 ships the four built-in themes and L20 was already
post-launch. What it does is invalidate the assumption underneath decision 11: the
remaining work was believed to be an import, and it is a re-expression of up to 600
designs into a schema-safe render format, plus re-verification of 359 packages.

**[OWNER] decision required — the options are genuinely different sizes:**

1. **Convert to the existing Lottie-shaped schema.** Reuses the validated pipeline
   and the `0077` bounds. Cost is per-design conversion work and probably some
   designs that do not survive the translation.
2. **Define a new declarative template format** expressive enough for these designs
   and still safe (no script, no expressions, no external refs). More upfront design,
   better long-term fit, and it needs its own validator and security review.
3. **Ship metadata only** — list the catalogue, render nothing — and treat the visual
   import as a separate project.
4. **Relax the HTML prohibition** with sandboxing. I would not: the rule is stated
   four times in this document, the render target is a live broadcast, and the
   blast radius of getting a sandbox wrong is a creator's stream.


## 3.12 TTS overage behaviour — amended 2026-09-07

**A paid tier that exhausts its monthly TTS quota now falls back to the browser
voice rather than going silent.** This reverses part of decision 1.

The original decision (2026-09-02) was a hard stop: visual alert plus an upgrade
prompt, and explicitly *"no silent downgrade to the browser voice."* Section 10.3
item 5 simultaneously called for browser fallback on both non-entitlement *and*
quota exhaustion. The two were contradictory and the contradiction survived
unnoticed until the fallback was built — the implementing agent flagged it rather
than picking a side.

**Resolved in favour of the fallback.** The behaviour now is:

| Condition | Viewer experience | Paid quota consumed |
|---|---|---|
| Free tier (`ttsEnabled=false`) | visual card + browser voice | no |
| Paid tier, quota exhausted | visual card + browser voice | no |
| Browser has no Web Speech API | visual card only, silent, no error | no |
| Provider audio succeeds | provider voice | yes |
| Provider audio fails (not entitlement) | existing chime | no |

**The trade-off, stated plainly:** a silent downgrade removes the moment that
would otherwise prompt an upgrade. A creator whose quota runs out mid-stream may
never notice, because the alerts keep speaking. The revenue case for the hard stop
was real, and it was set aside in favour of not putting dead air into a live
stream.

**Consequence to watch:** if TTS quota is meant to drive tier upgrades, that
pressure no longer exists at the moment of exhaustion, and nothing else currently
surfaces it to the creator. If upgrade conversion on TTS is weak once there are
paying creators, this is the first thing to revisit — an exhaustion notice in the
dashboard (the third option considered) restores visibility without restoring dead
air.


## 3.13 Companion entitlement must be configurable — decided 2026-09-07

Companion is a separate product (decision 9). Whether a given Alerts plan includes
it, and at what price it is sold alone, is **not decided** and must not be baked in.

That makes this an architectural constraint rather than a pricing footnote:

- Companion access is its own entitlement, evaluated independently of the Alerts tier.
- An Alerts plan may **grant** it. That grant is data, not code — changing which
  plans include Companion must not require a migration or a deploy.
- It must be grantable to an account with **no Alerts subscription at all**, since a
  Companion-only customer is now a supported case.
- The existing two-layer gate is unchanged: entitlement decides whether an action may
  exist, activation decides whether its target is live (L24, migration 0093). What
  changes is that the entitlement source for the `obs` / `mirror` / `stream` groups is
  no longer implied by an Alerts tier.

**Consequence already visible in the code:** `app_private.companion_action_limit()`
(migration 0042) returns 8/16/32/64 keyed on the Alerts tier, and `tier_entitlement_
dimensions()` carries `companionActionGroups` per Alerts tier. Both assume Companion
is a facet of an Alerts plan. Neither can express "Companion, no Alerts". Reworking
that is the first task of the Companion-separation work, and it is a schema change,
not a config change.

**Also unblocked:** L24's implicit-channel provisioning (a Companion-only signup has
no Alerts channel to scope against, yet every Companion route is channel-scoped) moves
from optional to required.


# PART 4 — DOMAIN MODEL

## 4.1 Backend modules

`PlatformBilling` and `CreatorPaymentConnections` must never merge.

| Module | Status |
|---|---|
| Identity | DONE (`app_users`, `user_sessions`, `channel_memberships`) |
| Channel | DONE (`channels`, `channel_configs`) |
| Entitlements | DONE (`channel_entitlement_versions`) — values half-published |
| CreatorPaymentConnections | DONE (`payment_accounts`) — Razorpay only |
| Payments | DONE (`payments`, `payment_order_intents`, `payment_webhook_deliveries`) |
| Refunds | DONE (`refunds`) |
| LiveEvents | DONE (`alert_events`) — canonical, ~80% source-agnostic |
| Queues | DONE (`alert_queues`, `queue_bindings`) |
| Delivery | DONE (`event_outbox`, `event_outbox_deliveries`, `overlay_sessions`, `overlay_cursors`) |
| AlertStudio | PARTIAL — presets + Lottie/branding shipped, depth in L20 |
| Assets | PARTIAL (`channel_lottie_assets`) |
| TTS | DONE (Sarvam, content-addressed SHA-256 cache) |
| Moderation | DONE (`alert_moderation_actions`) |
| Audit | DONE (`audit_events`, `archive_records`) |
| Reconciliation | DONE (`reconciliation_work_items`) |
| PlatformBilling | DONE (`channel_subscriptions`, `subscription_lifecycle_requests`) |
| TipIntent | PARTIAL — `payment_order_intents` covers the tip-page case, not chat-originated |
| PlatformConnections | TODO — L15 |
| Widgets | TODO — L16 |
| Challenges | TODO — L17 |
| ViewerProfiles | TODO — L14 |
| Memberships | TODO — L18 |

## 4.2 Core data model

Entities in **bold** exist today. The rest are designed here and owned by a task in Part 6.

**Account:** **User**, Workspace *(L21)*, **Channel**, **SubscriptionPlan**, **Entitlement**, **ModeratorMembership**

**Connections:** LivePlatformConnection *(L15)*, **PaymentProviderConnection**, OAuthTokenMetadata *(L15)*, ProviderCapabilitySnapshot *(L19)*

**Viewer:** ViewerAccount *(L14)*, ViewerPlatformIdentity *(L14)*, AnonymousBrowserIdentity *(L14)*, CreatorSupporterRelation *(L14)*

**Payment / event:** TipIntent *(partial)*, **CreatorPayment**, **ProviderWebhookEvent**, **Refund**, **ReconciliationRun**, Receipt *(L14)*

**Live:** **LiveEvent**, **QueueDefinition**, **QueueItem**, **DeliverySession**, **DeliveryAck**

**Experience:** **AlertPreset**, **Asset**, **TtsUsage**, WidgetConfig *(L16)*, SupportGoal *(L16)*, InteractionDefinition *(L16)*

**Challenges:** Challenge, ChallengeProposal, ChallengePaymentLink, ChallengeStatusEvent, ChallengeDispute — all *(L17)*

**Membership:** ExternalMembership, BharatStudioMembership, MembershipPeriod, MembershipRenewalEvent — all *(L18)*

**Safety:** **ModerationRule**, **ModerationDecision**, **AuditEvent**

## 4.3 Canonical LiveEvent

The queue and alert engine must not care where the event came from.

```json
{
  "source": "YOUTUBE",
  "sourceEventType": "SUPER_CHAT",
  "channelId": "...",
  "viewerIdentityId": "...",
  "amount": 500,
  "currency": "INR",
  "message": "...",
  "occurredAt": "..."
}
```

```json
{
  "source": "BHARATSTUDIO",
  "sourceEventType": "TIP",
  "channelId": "...",
  "viewerIdentityId": "...",
  "amount": 500,
  "currency": "INR",
  "message": "...",
  "occurredAt": "..."
}
```

**Today's schema is close.** `alert_events` has a `source_type` CHECK constraint over `('payment','manual','companion')`. Adding `youtube`, `twitch`, `kick` is a constraint widening plus a `source_event_type` column — not a rewrite. This is the single most valuable thing about the existing model, and L15 depends on it.

## 4.4 TipIntent

```json
{
  "id": "TIP_7AK2",
  "channelId": "ch_1",
  "viewerIdentityId": "vid_12",
  "source": "YOUTUBE_CHAT",
  "amount": 10000,
  "currency": "INR",
  "message": "play GTA bhai",
  "status": "PAYMENT_PENDING",
  "expiresAt": "..."
}
```

The provider order/payment references this ID. **The token must be opaque.** Never encode a mutable amount, name or message in a query parameter — that is a free fraudulent-alert generator.

## 4.5 Payment webhook transaction boundary

One transaction, in this order, no exceptions:

```text
BEGIN
  1. Verify provider signature (HMAC-SHA256 over the raw body)
  2. Insert provider webhook event
  3. Deduplicate on provider event ID
  4. Validate merchant connection belongs to this channel
  5. Validate amount / currency / reference
  6. Upsert immutable payment state
  7. Resolve TipIntent
  8. Create canonical LiveEvent on a new capture only
  9. Route to durable QueueItem(s)
 10. Write Outbox
COMMIT
```

Then, asynchronously, outbox workers fan out to: OBS/SSE overlay, TTS, platform chat, widgets, analytics.

**Status: DONE.** Implemented with raw-body HMAC verification and `X-Razorpay-Event-Id` dedup backed by a DB unique constraint.

## 4.6 Idempotency

```text
UNIQUE(provider, provider_event_id)
UNIQUE(provider, provider_payment_id)
```

Repeated webhooks produce one payment, one LiveEvent, one alert. **DONE.**

## 4.7 Reconciliation

Webhook is the fast path; the provider API is the recovery path.

```text
PENDING locally
→ webhook missing
→ reconciliation worker
→ fetch provider
→ CAPTURED
→ repair local state
→ create the missing LiveEvent
```

**DONE** — `reconciliation_work_items`, plus a manual-review quarantine (`0059`) and account attribution (`0034`).

## 4.8 State machines

### Payment (DONE)

```text
CREATED → PENDING → CAPTURED
                  → FAILED
CAPTURED → REFUND_PENDING → REFUNDED
                          → REFUND_FAILED
CAPTURED → CHARGEBACK
```

### Challenge (TODO — L17). Kept strictly separate from payment state.

```text
DRAFT → PUBLISHED → AWAITING_PAYMENT → FUNDED → IN_PROGRESS
      → COMPLETION_SUBMITTED → COMPLETED
                             → DECLINED
FUNDED → FAILED_BY_CREATOR → (payment REFUND_PENDING)
PUBLISHED → EXPIRED | CANCELLED
any → DISPUTED
```

### Membership (TODO — L18). Store periods and renewal events, never a single current boolean.

```text
CREATED → MANDATE_PENDING → ACTIVE → RENEWED
ACTIVE → PAST_DUE → ACTIVE | EXPIRED
ACTIVE → PAUSED | CANCELLED_AT_PERIOD_END | CANCELLED | EXPIRED
```

---

# PART 5 — TASK REGISTER: EXISTING GOVERNANCE

Every task in `bharatstudio-requirements/tasks/`. Status verified against code, not against status prose.

## L00 — Legacy freeze and inventory · **DONE**

Legacy surface frozen, inventory recorded 2026-08-15. Nothing pending.

## L01 — Contracts and database baseline · **DONE**

79 migrations in `packages/db/migrations`. Shared contracts package. Windows C# consumer boundary recorded. Nothing pending.

**Pending under this plan:** two migrations, both listed in Part 12 — the `queueCount` retier (1/2/3/5) and the `source_type` CHECK widening for L15.

## L02 — Security, RLS and archive-integrity proof · **DONE**

RLS across tenant tables, `app_private.*` security-definer functions, transaction-scoped tenant context, archive owner RLS hardening (`0058`), account lifecycle consent (`0061`), fail-closed terms (`0066`), seeded terms documents (`0068`). Deep-audit remediation closed 2026-08-16.

**Pending:** nothing in code. The DPDP data-rights self-service flow is shipped; the published policy text still needs dated legal sign-off (L08).

## L03 — Alerts web and Creator API · **DONE through L03-44**

The largest task. Shipped slices, each with a commit:

| Slice | Commit |
|---|---|
| Billing lifecycle: request side | `661a4d6` |
| Downgrade enforcement + entitlement production values | `08f3d22` |
| Billing lifecycle UI | `ad99f1b` |
| Terms acceptance, DPDP privacy self-service, Razorpay payout onboarding UI | `ea39e83` |
| Server-side queue-mode dispatch semantics | `5ca128f` |
| Payments ledger page; tip-page donor-visibility scope check | `297adb8` |
| Admin DLQ tooling | `18df411` |
| Admin entitlement management | `e2b6d17` |
| Featured-creator public API | `6afa05f` |
| Email delivery integration | `ea2fe98` |
| Referral / growth engine | `9679213` |
| Lottie / custom branding upload | `31b7ae9` |
| L03-41 resumable onboarding wizard | — |
| L03-42 dashboard multi-page IA | — |
| L03-43 unsubscribed-channel billing shape regression fix | — |
| L03-44 payout onboarding as a real dashboard gate | — |

Plus the 2026-08-17 production-readiness audit remediation: 19 dashboard findings fixed, `tsc` clean, 18 routes build, 64/64 tests pass, all nine signed-out states live-verified.

**Pending in L03:**
1. Publish the eight entitlement values from 3.2 into `channel_entitlement_versions` — six of eight are wired with no published value.
2. Retier `queueCount` to 1/2/3/5.
3. Wire `ttsEnabled` to the tier instead of the current bare boolean, and add the monthly character quota.

## L04 — Go payment boundary · **BUILT–UNGATED**

Implemented: payment intent idempotency hardening (`0056`), subscription billing projection, Go SQLStore subscription-creation adapter, reconciliation account attribution, internal payment-service response hardening, creator payment account onboarding (`0060`), payout onboarding gate (`0079`).

**Open gates (not code):**
- Razorpay Technology Partner approval — **not a revenue blocker**, see 6.1 below.
- Production creator-direct connected-account test evidence.
- Production provider/runtime readiness.

## L05 — Go alert worker and Cloud Tasks dispatch · **BUILT–UNGATED**

Implemented: SQL ready-row pump adapter, bounded concurrent Cloud Tasks pump, cross-replica replay security correction, shared overlay recovery regression fix, queue-mode ordering (`0065`), queue claim regression fix (`0063`).

**Open gate:** deployment-boundary evidence on real Cloud Run + Cloud Tasks.

## L06 — Scheduler boundary and private maintenance handlers · **BUILT–UNGATED**

v1 scheduled responsibilities defined and implemented; local audit clean 2026-08-15.

**Open gate:** deployed Cloud Scheduler configuration and a missed-schedule fault injection run.

## L07 — Companion web, mobile and native desktop helper · **PARTIAL — see Part 7.11**

Implemented: server-owned control-session lease, macOS native policy boundary, React Native response-boundary hardening, Windows C# response-boundary hardening, mobile transport boundary, mobile API projection, mobile screen-set, Google exchange contract, secure session storage, session controller, runtime/bootstrap wiring, offline/reconnect policy, notification/background policy, native APNs/FCM + server registration (`0057`), control-session lifecycle, macOS Keychain storage, native OBS WebSocket security boundary, web Companion screen-set, notification settings + foreground delivery.

API surface today (`apps/api/src/routes/companion.ts`): `GET state`, `GET layout`, `PATCH layout`, `POST control-session`, `DELETE control-session/:id`, `POST actions`.

**Per your instruction, nothing in Companion is deferred.** The full remaining feature list is Part 7.11.

## L08 — Marketing, support, legal and launch communications · **PARTIAL**

Implemented: full migration to Next.js 16 static export, visual-system correction, five dropped pages restored, 31/31 routes build, 8/8 tests pass, and the 2026-08-17 production-readiness audit remediation (16 findings — plan-carrying download CTAs, comparison-table consolidation, icon-box consistency, flagship-claim propagation, data-rights links).

**Pending:**
1. Dated legal sign-off on privacy, terms, refunds, grievance, data-rights.
2. Pricing page updated to Studio ₹599 and the 3.2 limits — currently shows the old figures.
3. Support staffing and contact routes staffed before launch.
4. `D-C053` must hold: no competitor names in rendered HTML.

## L09 — Observability, load, failure and recovery proof · **TODO — largest real gap**

Nothing here can be closed locally. All seven tasks need a deployed environment:

1. Declare staging targets (payment ack error budget, dispatch latency, queue age, SSE concurrency, recovery time, DB pool/CPU).
2. Complete the deployed trace path web → Creator API → payment service → outbox → Cloud Tasks → alert worker → SSE overlay.
3. Dashboards and alerts for payment mismatch, webhook verification failures, duplicate/missing Razorpay event IDs, outbox/task backlog, DLQ, SSE disconnect/resync, cross-replica fan-out lag, entitlement-cache staleness, DB saturation.
4. Staged load tests at normal and peak.
5. Fault injection: DB write failure, Cloud Tasks retry, duplicate/out-of-order webhook, worker crash, SSE disconnect, replica outage, TTS outage, Razorpay status delay, scheduler miss, rollback, restore drill.
6. Prove no alert/purchase loss and no duplicate financial effect.
7. Record every result as a dated measurement — the legacy Neon latency number is **not** production proof.

**This is the gate between "the code works on my machine" and "we can take money."**

## L10 — Release readiness and production rollout · **TODO**

Go/no-go criteria, verbatim from the task file:

- All L00–L09 acceptance criteria have evidence; no unowned critical/high finding remains.
- **v1 contains no YouTube or Enterprise capability/claim.**
- Payment, queue, overlay and scheduler recovery are proven in final staging.
- Provider/legal/store gates are affirmative, current and documented.
- Deployment and rollback are rehearsed; monitoring/on-call/support are live.

> **Amended 2026-09-02.** The second bullet is now **"v1 contains no Enterprise capability/claim."** YouTube enters v1 in full — read scopes, chat-write scope, Super Chat / Super Sticker / membership normalisation, `!tip`, and bot acknowledgement (L15). Enterprise remains excluded. The amendment itself still has to be filed — Part 12, item 4.
>
> Two new external gates join the go/no-go as a result: **Google OAuth app verification** (read + chat-write) and **YouTube Data API quota** sufficient for projected concurrent live-chat polling. Neither is under our control, so both start now.

The earlier "Phase 7 can launch same day" claim was withdrawn. The audit returned REQUIRES_CHANGES_BEFORE_BETA. `tasks/LAUNCH-EXECUTION-PLAN.md` is the operational authority.

## L11 / L12 / L13 — Stream iOS / Android / macOS+Windows · **SEPARATE PRODUCT LINE**

Out of scope for this plan. Recorded so nobody re-plans them here. L11 has mandatory login approved 2026-08-28; L12 has open approvals in Appendix B of Doc 153; L13 has Phase-5 remaining work.

## PLATFORM-WP0 — Platform governance, threat model, architecture · **DONE**

Real Go service: 5,716 LOC, 18 migrations, tests pass. Implementation boundary defined post-approval. Alerts does not yet consume it — entitlements are still local to Alerts. Migrating Alerts onto Platform entitlements is **v2** and deliberately not in this plan's critical path.

---

# PART 6 — NEW TASK REGISTER

Everything the 30-Aug plan specified that no existing governance task owns. Each gets a task ID, an objective, a scope, an ordered task list, acceptance criteria, and its dependencies — the same shape as L00–L13, so these can be dropped into `bharatstudio-requirements/tasks/` as real task files.

---

## L14 — Viewer identity and supporter history

**Objective.** Give a viewer optional identity so their support history survives across devices and platforms, without ever making login a condition of tipping.

**Scope: all three levels in v1** (decided 2026-09-02). Level 3's platform-linking sub-features activate per connector as L15 lands; the account itself does not wait for L15.

**Why it does not exist today.** Verified: the schema has `donor_display_name` and `donor_message` as free text on the payment row. There is no viewer table, no supporter relation, no receipt entity. A viewer who tips twice is two unrelated rows.

### The three identity strengths

| Level | How it is established | What it can carry | What it cannot |
|---|---|---|---|
| **1 — Anonymous / browser-scoped** | `localStorage` on the tip page | Local display name, preferred UPI app, local recent receipts | Cross-device anything |
| **2 — Platform-scoped** | `!tip` from YouTube/Twitch/Kick gives a stable platform user ID | Lifetime support to that creator, tip count, streak, challenge history, membership correlation, leaderboard identity | Cross-platform merge |
| **3 — BharatStudio account** | Viewer signs up and links platform accounts via OAuth | Cross-device, cross-platform, recoverable, private lifetime dashboard | — |

Level 2 requires **no BharatStudio login at all**. That is the important one: it delivers most of the value with zero signup friction, and it comes free with L15.

### Tasks

1. `viewer_identities` table with a discriminator for anonymous / platform / account.
2. `viewer_platform_identities` — (provider, provider_user_id) unique, linked to a viewer identity.
3. `anonymous_browser_identities` — opaque cookie token, no PII, expiring.
4. `creator_supporter_relations` — (channel_id, viewer_identity_id) with first support, last support, lifetime amount to **this creator only**, tip count, challenge count, current member state.
5. Add `viewer_identity_id` to `alert_events` and `payments`, nullable, backfilled null.
6. Receipt entity and a viewer-facing receipt page reachable from a payment without login.
7. Optional viewer account: signup, login, session, deletion (DPDP-compliant).
8. Platform account linking via OAuth, and **historical claiming**: when a viewer links YouTube `UC123`, attach that platform identity's existing history to the account.
9. Streaks: consecutive-stream support counted per platform identity.
10. Public badges, opt-in and non-financial: *Supporter since 2026*, *3-month member*, *12-month member*, *Challenge Champion*, *10 Challenges Completed*, *Stream Streak ×5*, *Founding Supporter*, *Top 10 Supporter*.
11. Opt-in searchable viewer profile.

### Privacy rules — binding

- A creator sees a viewer's relationship with **their own channel only**: first/last support, lifetime support to this creator, tip count, challenge count, current member state.
- **A creator must never see cross-creator spend.**
- A viewer sees their own lifetime support across all creators, receipts, refunds, challenges, memberships, streaks.
- Public profiles are opt-in. Exact lifetime spend is private by default and never published.
- **Never claim history from a typed display name.** Only from an OAuth-verified platform identity.

### Acceptance criteria

- Tipping works end to end with no viewer login, unchanged from today.
- A `!tip` from a known platform user attaches to a Level-2 identity with no signup.
- Linking YouTube to a new BharatStudio account attaches prior `UC123` history exactly once and is idempotent on repeat.
- A creator API response containing supporter data is proven by test to exclude any other channel's amounts.
- Deleting a viewer account removes profile and linkage but preserves the immutable payment/audit record.

**Depends on:** L15 for Level 2 and for Level 3's YouTube linking — both now in v1, so viewer accounts can offer YouTube linking at launch. Twitch and Kick linking activate in Phase 2 as those connectors land. Level 1 is independent of everything.

---

## L15 — Live-platform connectors and chat commands

**Objective.** Ingest YouTube, Twitch and Kick events as canonical LiveEvents, and let a viewer start a tip from chat.

> **DECIDED 2026-09-02 — YouTube ships in v1, including the chat bot.** L10 currently states "v1 contains no YouTube or Enterprise capability/claim"; it is amended for YouTube only (Part 12, item 4). **Enterprise stays out of v1.**
>
> **Start Google OAuth app verification today.** It is the long pole and nothing else in this task can shorten it. Required: a published privacy policy on the verified domain, a demo video, and per-scope justification. `youtube.readonly` is a routine approval; the **chat-write scope for bot acknowledgement is high-sensitivity** and can bounce. Every other item in L15 can be built in parallel while it is in review. Also file the **Data API quota increase** — live-chat polling burns units per stream per creator, and that is a second Google review.
>
> **Twitch and Kick remain Phase 2.** This decision covers YouTube only.

### Tasks

1. **Widen the event model.** `alert_events.source_type` CHECK is currently `('payment','manual','companion')`. Widen to include `youtube`, `twitch`, `kick`; add `source_event_type` and `source_user_id` columns. This is the whole reason the connector work is cheap — the queue, delivery, moderation and overlay layers do not change.
2. `live_platform_connections` + `oauth_token_metadata`, with encrypted tokens in the existing vault reference pattern.
3. **YouTube:** OAuth; live status; `streamList` low-latency chat; text messages; Super Chats; Super Stickers; member events; member milestone chats; gifted memberships; polls where authorised; moderation events; bot text messages. Members API gives membership level, total months, and time at level where authorised.
4. **Twitch:** EventSub for chat messages, subscriptions, subscription end, gifts, resub messages, Cheers/Bits, Channel Points, follows, stream state. Bot messages and announcements with proper authorisation. Resub data carries cumulative months.
5. **Kick:** official OAuth + signed webhooks — chat, follows, subscription new/renewal/gift, channel rewards, livestream state, moderation. Renewal events include duration. **Label the connector Beta**: the ecosystem is newer and open webhook/subscription issues exist. Verify signatures, dedupe on Kick event message IDs, reconcile where possible.
6. **Normalise natives** into LiveEvent: Super Chat, Super Sticker, Cheer, Sub, Resub, Gift Sub, Channel Points, Kick subs.
7. **`!tip` command.** `!tip`, `!tip 100`, `!tip 100 message` → create TipIntent → bot replies with a short opaque link:
   ```text
   @Rahul — ₹100 support ready ❤️
   b.st/7AK2
   ```
   The token is opaque. Amount, name and message live server-side, never in the URL.
8. **Confirmation page** at that short link — no form:
   ```text
   RAKA GAMING

   Rahul
   ₹100
   "play GTA bhai"

   [ Google Pay ₹100 ]
   [ PhonePe ]
   [ Other UPI ]
   ```
9. **Bot acknowledgement** back into chat on verified capture.
10. `!challenge` and `!challenge 500 message` — gated on L17.
11. Connector entitlement: a single generic `External Live Platform Connector` count — Free 0, Pro 1, Creator 2, Studio 3. This supports simulcasters without forcing multiple BharatStudio channels.
12. Always keep the QR and short-URL fallback working when chat is unavailable.

### Acceptance criteria

- A Super Chat and a BharatStudio tip of the same amount produce LiveEvents that the queue engine cannot distinguish except by `source`.
- A duplicate platform webhook produces no second event.
- Revoking the OAuth grant on the platform side degrades to a clean disconnected state, not an error loop.
- Financial truth always comes from the payment provider, never from a platform event.

**Depends on:** L01 (constraint widening). Reference implementations exist in `stream-ios`/`stream-android`.

---

## L16 — Interaction menu, goals and widgets

**Objective.** Turn a tip amount into a chosen interaction, and put the stream's support state on screen.

### Interaction menu

The creator defines availability, amount, target queue, TTS behaviour, moderation requirement, visuals, and refund behaviour where applicable.

```text
INTERACT WITH RAKA

₹20   Show sticker
₹50   Read message with TTS
₹100  Mega alert
₹199  Choose next loadout
₹299  Priority question
₹499  Challenge creator
```

### Interaction types

| # | Type | Creator obligation | Task |
|---|---|---|---|
| 1 | Tip | None | DONE |
| 2 | TTS tip | None | DONE |
| 3 | Sticker / reaction — approved assets only | None | L22 |
| 4 | Mega alert — threshold visual | None | L16 |
| 5 | Priority question — enters creator queue | Soft | L16 |
| 6 | Support vote — viewer supports a choice | Soft | L16 |
| 7 | Community support goal — collective target | Soft | L16 |
| 8 | Hype mode — time-limited engagement meter | None | L16 |
| 9 | Paid challenge — conditional obligation | **Hard** | L17 |

No arbitrary viewer media upload at launch, in any type.

### Widgets

| Widget | Free | Pro | Creator | Studio |
|---|---|---|---|---|
| Main alert | Yes | Yes | Yes | Yes |
| Support goal | 1 | 3 | 10 | 10 |
| Recent tips | Basic | Yes | Branded | Multi-source |
| Top supporters | Private/basic | Stream/weekly | Weekly/monthly | Advanced |
| Supporter ticker | — | Basic | Branded | Multi-source |
| Public leaderboard | — | Stream/weekly | Monthly | Advanced |
| Mega-tip banner | — | — | Yes | Yes |
| Widget placement | Fixed | Approved | Per-widget | Layered |
| Preview data | Yes | Yes | Yes | Yes |
| Privacy controls | Yes | Yes | Yes | Yes |

### Tasks

1. `interaction_definitions` per channel — amount, label, queue binding, TTS rule, moderation rule, visual.
2. `support_goals` — target, current, window, reset policy, public/private.
3. `widget_configs` — type, placement, style, data source, privacy scope.
4. Widget browser sources sharing the existing overlay session/cursor/replay machinery. **Do not build a second delivery path.**
5. Support votes: option set, per-option tally, resolution.
6. Hype mode: time-boxed meter, decay, threshold visual.
7. Leaderboard windows: stream / weekly / monthly, with the privacy rules from L14 (no exact lifetime spend published by default).

**Depends on:** L14 for supporter identity on leaderboards; L20 for the visual layer.

---

## L17 — Paid challenges

**Objective.** Let a viewer pay for a conditional creator action, with an explicit refund path and no escrow.

**Challenges are not tips.** A tip has no creator obligation. A challenge does.

### Viewer-proposed is the better default

```text
Viewer proposes challenge + amount
→ creator or moderator approves
→ payment link activates
→ viewer pays
→ FUNDED
```

This avoids refunding unwanted challenges, which is the main operational cost of the creator-published flow.

### The refund boundary — say this exactly

Enable challenges **only** on a provider that supports verified payment **and** a refund API **and** refund status. BharatStudio invokes the refund on the **creator's** merchant account.

Because there is no escrow: the payment may already have settled, the refund may be pending or fail, and the provider may require merchant balance.

Product language, verbatim:

> Refund automatically initiated through the creator's connected payment provider.

**Never promise unconditional or instant refunds.**

### Public challenge board

```text
LIVE CHALLENGES

🟢 IN PROGRESS   ₹500 — Knife-only next round      Rahul
🟡 NEXT          ₹800 — Play horror game           Aman
✅ COMPLETED     ₹300 — Pistol only                Jay
```

OBS can show the current challenge. This turns support into stream content.

### Community challenges

Treat multi-contributor targets as **support goals** (L16), not refundable contracts. Refundable multi-contributor challenges are v2+ — a failure means N individual refund operations, each of which can fail independently.

### Tasks

1. `challenges`, `challenge_proposals`, `challenge_payment_links`, `challenge_status_events`, `challenge_disputes`.
2. Challenge state machine from 4.8, stored strictly separately from payment state.
3. Capability gate: challenges are invisible unless `PaymentProviderConnection.capabilities.refunds` is true.
4. Creator/moderator approval flow for viewer proposals.
5. Completion submission and creator confirmation.
6. Failure → refund initiation → refund status surfaced to both parties.
7. Dispute record.
8. Public challenge board page + OBS widget.
9. `!challenge` chat command (L15).

**Depends on:** L15 for the command, L19 for capability introspection.

---

## L18 — Memberships

**Objective.** Normalise native platform memberships first; only then consider BharatStudio-native recurring support.

### Normalise natives before building our own

| Platform | Store |
|---|---|
| YouTube | Member identity, membership level, total duration, duration at level |
| Twitch | Tier, new/resub/gift, cumulative months where provided |
| Kick | New/renewal/gift, renewal duration, expiry where available — reconcile conservatively |

All three normalise into `ExternalMembership` + `MembershipPeriod` + `MembershipRenewalEvent`.

### BharatStudio monthly support — v2, gated on economics

```text
Join Raka Support Club
₹99 / month   ₹299 / month   ₹499 / month
```

Money still flows viewer → creator's connected recurring-payment provider → creator. BharatStudio never holds recurring support money; it consumes the provider webhook to grant entitlement.

For BharatStudio-native recurring membership, **viewer login is required** — cancellation, receipts, plan management, recovery and cross-device entitlement all need it.

**Do not assume standard UPI 0% pricing applies to UPI AutoPay / recurring mandates.** Paytm, for one, publishes separate UPI Subscription pricing. Confirm the recurring rate before pricing a membership tier.

### Tasks

1. `external_memberships`, `membership_periods`, `membership_renewal_events`.
2. Ingest membership events from each L15 connector.
3. Surface member state on the supporter relation (L14).
4. Member badges (L14).
5. *(v2)* BharatStudio-native recurring: mandate creation, state machine from 4.8, cancellation, receipts, entitlement grant.

**Depends on:** L15, L14.

---

## L19 — Payment provider abstraction and multi-rail

**Objective.** Make the payment layer provider-neutral from day one, so a cheaper verified UPI rail can be added without touching the event model.

### The interface

```java
interface CreatorPaymentProvider {
    ConnectCapabilities connectionCapabilities();
    CreatePaymentResult createPayment(TipIntent intent);
    CreateQrResult      createQr(TipIntent intent);
    PaymentStatus       fetchPayment(String providerPaymentId);
    RefundResult        refund(String providerPaymentId, Money amount);
    void                verifyWebhook(WebhookRequest request);
    boolean supportsUpiIntent();
    boolean supportsDynamicQr();
    boolean supportsRefunds();
    boolean supportsRecurringPayments();
    boolean supportsCards();
    boolean supportsInternationalPayments();
}
```

The creator UI exposes **capabilities**, never provider plumbing.

### Rail plan

| Rail | Status | Policy |
|---|---|---|
| **Razorpay** | Live via manually-pasted `acc_XXX` | Cleanest launch connection. Technology Partner OAuth is the upgrade, not the gate. ~2% + GST published. |
| **Razorpay OAuth (Technology Partner)** | Applied | Replaces the manual `acc_XXX` paste with a scoped grant. No raw creator secret. |
| **Paytm** | Not started | 0% standard UPI published — the strongest economics. But the public Partner Program is referral-oriented; no verified Razorpay-style OAuth. **Do not ship a "Connect Paytm" button** until all eight conditions below are confirmed in writing. |
| **Cashfree** | Not started | Embedded Merchant Onboarding is publicly documented — KYC stays with Cashfree. Do not assume the old 0% offer applies; published eligibility required signup before 31 July 2026. |
| **PhonePe** | Not started | PG Partner Program exists; no public OAuth spec. Confirm connection model, direct settlement, authorisation, refund/status APIs, post-promo pricing. |
| **Direct merchant UPI / PSP-bank** | Strategic target | Creator becomes a merchant customer of a PSP/bank; BharatStudio receives scoped merchant UPI intent, status, QR and refund APIs. Best combination of cost + UX + verification. |

### Paytm — the eight conditions

Do not promise "Connect Paytm" until Paytm confirms, in writing:

1. BharatStudio can be a platform/technology partner.
2. The creator completes KYC directly with Paytm.
3. An existing or new creator merchant can be linked without BharatStudio collecting PAN or bank documents.
4. BharatStudio receives scoped or tokenised authorisation, or another safe credential model.
5. Standard UPI keeps the applicable commercial 0% pricing.
6. BharatStudio can create UPI orders / intents / QRs.
7. BharatStudio receives payment and refund status server-side.
8. Settlement remains creator-direct.

If Paytm offers only MID + Merchant Key, make it an **advanced** connection behind a proper secret-vault design. Never the primary onboarding path — the Merchant Key is a raw secret.

### Direct UPI intent

Where the creator is a verified UPI merchant and status is independently verifiable:

```text
upi://pay
  ?pa=raka-merchant@psp
  &pn=Raka%20Gaming
  &tr=BS_TIP_8492
  &tn=Tip%20for%20Raka
  &am=100
  &cu=INR
```

This gives near-one-tap payment, no generic gateway selection screen, creator-direct settlement, and a verifiable payment. The hard part is getting each creator a merchant UPI relationship with a merchant VPA, MCC metadata, server-side status, refunds, and secure authorisation for BharatStudio.

### Tasks

1. Extract the current Razorpay implementation behind `CreatorPaymentProvider`.
2. `provider_capability_snapshots` — persist what a connection can do, so features gate on capability not provider name.
3. Razorpay OAuth connection alongside the manual `acc_XXX` path; both supported, OAuth preferred.
4. Dynamic/order-bound QR for desktop.
5. Preferred-UPI-app local preference (non-sensitive, browser-scoped): first payment offers Google Pay / PhonePe / BHIM-Other; subsequent visits lead with the remembered choice. **Never store banking credentials.**
6. Per-rail integrations as each provider's conditions are met.

**Do not build automatic routing.** Make the model provider-neutral and let the creator choose.

---

## L20 — Alert Studio depth

**Objective.** Extend the shipped preset/branding system to the full studio, using schema-validated templates only.

| Capability | Free | Pro | Creator | Studio |
|---|---|---|---|---|
| Alert library | Free set | Larger | Full eligible | Full |
| Global style | 1 | Approved | Custom eligible | Advanced |
| Per-event styling | No | Approved | Yes | Yes |
| Per-queue styling | No | Approved | Yes | Yes |
| Position | Fixed | Approved | Per event/queue | Layered |
| Resize | Safe fixed | Profiles | Per alert | Advanced |
| Overlap warnings | Basic | Yes | Yes | Layer tools |
| Custom text | No | Approved | Bounded | Advanced |
| Character ceiling | 100 | 150 | 300 | 500 |
| Custom templates | No | Approved | 5/channel | 12/channel |
| Animation presets | Basic | More | Advanced | Lottie/advanced |
| Creator media | No | Small | 5 | 20 |
| Creator sounds | No | Small | 5 | 20 |
| **Arbitrary HTML/CSS/JS** | **Never** | **Never** | **Never** | **Never** |

Character ceiling here is the same `maxCharLimit` from 3.2 — one value, not two.

### Asset storage and safety

| Plan | Storage |
|---|---|
| Free | none |
| Pro | 100 MB |
| Creator | 250 MB |
| Studio | 1 GB |
| Enterprise | Contract |

Every upload requires: type validation, malware scanning, sanitisation/transcoding, size and duration limits, and a takedown/reporting path. Lottie upload already ships (`0077`) — extend the same pipeline, do not add a second one.

### The 600-template catalogue — DECIDED 2026-09-02

The 600 templates **already exist**. They are not rebuilt and not discarded — they get **imported later**.

What this means for L20:

- v1 ships the four built-in themes. Nothing changes there.
- L20's job on templates is an **import pipeline**, not artwork: convert the existing catalogue into the schema-validated template format, run each through the same type-validation / scanning / sanitisation path the Lottie upload already uses (`0077`), and expose them through the tiered alert library in the table above.
- Import is incremental. Ship the pipeline, bring templates across in batches, gate visibility by tier.
- **No arbitrary HTML/CSS/JS survives the import.** Anything in the catalogue that cannot be expressed in the validated schema does not get imported.

---

## L21 — Enterprise workspace

See Part 9 for the corrected money flow. Governance-blocked in v1 by L10.

**Adds:** multi-channel allocations, SSO, RBAC, shared brand kits, licensed design packs, campaigns, cross-channel analytics, API/webhooks, finance/audit exports, SLA/support. A workspace can allocate a different tier per channel.

---

## L22 — Stickers and safe media

Viewer-selected assets must be BharatStudio-approved or creator-approved. **No arbitrary viewer upload at launch.**

| Capability | Free | Pro | Creator | Studio |
|---|---|---|---|---|
| Sticker library | Small | Larger | Full eligible | Full |
| Viewer selection | Yes | Yes | Yes | Yes |
| Creator pack | — | Small | Limited | Larger |
| Viewer upload | No | No | No | v2, controlled |
| Moderation | Catalogue | Catalogue | Scan + attest | Review workflow |

---

## L23 — AI assist, bounded

AI is **not** the launch message.

**Allowed:** configuration suggestions, challenge copy, translation/localisation, style proposals, moderation assistance.

**AI must never autonomously:** capture money, refund, change payment destinations, mark a challenge complete, or create a financial obligation without explicit human confirmation.

---

## L24 — Companion action catalogue and standalone mode

**Objective.** Turn Companion's fixed three-action contract into a conditional catalogue: show Alerts actions when the account actually runs Alerts, show OBS / Mirror / Stream actions to everyone. This is what makes Companion sellable without forking it into a second app.

### The constraint today

Migration `0041` constrains `companion_commands.action` to exactly three values — `pause_queue`, `resume_queue`, `send_test_alert`. **All three are Alerts actions.** L07 task 8 reads OBS scene/source *state*, but nothing ships scene switching, source toggling, or start/stop. So Companion has standalone *potential* and no standalone *capability*: strip Alerts away and there is nothing left to control.

The pairing, the security boundary, the secure storage and the action-slot ladder are all built. Only the catalogue is missing.

### The two-layer gate

Gating on "is Alerts subscribed?" alone is wrong in both directions — **Free is an Alerts subscription at ₹0**, and a paid subscriber who has not connected Razorpay yet would still see live-looking queue buttons. So gate on two things:

| Layer | Question | Where it lives |
|---|---|---|
| **1 — Entitlement** | May this action exist in your catalogue at all? | Server-authoritative. `0042` already validates "approved action names… and tier limits". |
| **2 — Activation** | Is the thing this action points at actually live? | Companion state endpoint. |

**Entitled → the action appears in the picker. Activated → it is enabled in the grid.**

Activation predicates:

| Action group | Enabled when |
|---|---|
| `pause_queue`, `resume_queue` | Channel has ≥1 active queue **and** a connected payment account |
| `send_test_alert` | An overlay session exists |
| `obs_*` | Helper paired **and** OBS WebSocket connected |
| `mirror_*` | Mirror running and reachable on local TCP 27190 |
| `stream_*` | Stream app paired |

A Free Alerts user keeps their queue controls — they genuinely have a queue. A Companion-only user never sees a dead Alerts button.

### The action catalogue

Bounded allowlist, OBS WebSocket 5.x:

| Action | Target shape |
|---|---|
| `obs_set_scene` | scene name |
| `obs_toggle_source` | scene + source |
| `obs_toggle_mute` | audio input |
| `obs_start_stream` / `obs_stop_stream` | none |
| `obs_start_record` / `obs_stop_record` | none |
| `obs_save_replay_buffer` | none |
| `obs_set_transition` | transition name |

Plus the rest of the portfolio — this is the part that makes Companion a product rather than an OBS controller among many:

| Action | Product |
|---|---|
| `mirror_start` / `mirror_stop` / `mirror_screenshot` | Mirror (L13 already has LAN-only paths and TCP 27190) |
| `stream_go_live` / `stream_end` | Stream (L11/L12) |

### The architectural blocker — every Companion route is channel-scoped

```
GET    /v1/channels/:channelId/companion/state
GET    /v1/channels/:channelId/companion/layout
PATCH  /v1/channels/:channelId/companion/layout
POST   /v1/channels/:channelId/companion/control-session
POST   /v1/channels/:channelId/companion/actions
```

A channel is an Alerts concept — it carries the entitlement version, the queues, the tip page. "Companion without Alerts" has nothing to scope to.

**Resolution: give every Companion user an implicit channel. Do not build a second scope.** A channel already *is* the unit of entitlement + membership + role, which is everything Companion needs. A Companion-only signup gets a channel with no payment account connected and no tip page published; in the UI it stops reading as "your tip page" and reads as "your workspace."

The alternative — a non-channel scope — means new routes, new RLS policies, a parallel entitlement path, and two authorization models to keep in sync forever. Rejected.

### Tasks

1. Migration: extend the `0041` CHECK allowlist beyond the three actions. Keep it `NOT VALID` for the reason it already is — historical command rows stay append-only evidence.
2. Migration: `0042`'s layout slots validate "active same-channel queue targets". OBS actions carry a different target shape, so slots need a **target-type discriminator** with per-type validation. Scene, source, input and transition names are free text and need the same bounds treatment every other `0042` field received.
3. Entitlement: add the OBS / Mirror / Stream action groups to the tier matrix. **This does not need a ninth entitlement dimension** — it fits the existing per-tier list pattern used by `allowedQueueModes`.
4. Activation state: the Companion state endpoint already returns overlay connection and pending count. Add payment-account-connected, helper-paired, OBS-connected, Mirror-reachable, Stream-paired.
5. Implicit channel provisioning on signup through a Companion entry point.
6. Generic OBS control in the native helpers (macOS SwiftUI, Windows WinUI 3) behind the existing paired, signed, scoped command boundary.
7. Catalogue UI: picker filtered by entitlement, grid slots disabled by activation, with an explanation of *why* a slot is disabled rather than a silent grey-out.

### Acceptance criteria

- A Companion-only account with no payment connection sees zero Alerts actions and a working OBS grid.
- A Free Alerts account sees its queue controls enabled and OBS controls disabled until a helper is paired.
- Every action the client can send is rejected server-side unless both layers pass — the client filter is convenience, never authority.
- Layout validation rejects an OBS action whose target shape does not match its action type.
- No historical `companion_commands` row is rewritten or deleted by any migration in this task.

### What must not change

L07's acceptance criteria are the boundary and they hold verbatim: *"Desktop helper is local-only, consented, revocable, and has no general-purpose local/public API"* and *"no arbitrary command execution."*

The OBS action set stays a **server-validated allowlist**. It never becomes an OBS WebSocket passthrough. The temptation once `obs_set_scene` exists is to expose the raw request surface "for flexibility" — that is precisely the change that converts a paired helper into a remote-code-execution path on the creator's machine. The `0041` pattern is correct: extend the list, never remove the constraint.

**Depends on:** L07 (pairing, secure storage, control-session lease — all built). Blocks Companion being sold separately (Part 13, decision 9).

---

# PART 7 — FEATURE REGISTER

Every feature named in the 30-Aug plan or present in the code, mapped to an owning task and a status. If a feature is not in this register, it is not in the plan.

## 7.1 Payments and rails

| Feature | Task | Status |
|---|---|---|
| Razorpay creator-direct via manual `acc_XXX` | L04 | DONE — takes real HMAC-verified webhook-confirmed payments today |
| HMAC-SHA256 raw-body webhook verification | L04 | DONE |
| `X-Razorpay-Event-Id` dedup with DB unique constraint | L04 | DONE |
| Payment intent idempotency | L04 | DONE (`0056`) |
| Refund state tracking | L04 | DONE (`refunds`, `0014`) |
| Reconciliation worker + manual-review quarantine | L04 | DONE (`0034`, `0059`) |
| Creator payment account onboarding | L04 | DONE (`0060`) |
| Payout onboarding dashboard gate | L03 | DONE (`0079`, L03-44) |
| Payments ledger + CSV export | L03 | DONE (`297adb8`, `0071`) |
| Razorpay Technology Partner OAuth | L19 | TODO — an upgrade, not a launch gate |
| `CreatorPaymentProvider` abstraction | L19 | TODO |
| Provider capability snapshots | L19 | TODO |
| Dynamic / order-bound QR (desktop) | L19 | TODO |
| Preferred UPI app memory | L19 | TODO |
| Direct UPI intent (`pa`/`pn`/`tr`/`tn`/`am`/`cu`) | L19 | TODO — needs merchant VPA |
| Paytm | L19 | Blocked on the eight conditions |
| Cashfree | L19 | Blocked on partner confirmation |
| PhonePe | L19 | Blocked on partner confirmation |
| Direct PSP-bank rail | L19 | Strategic, unscheduled |

## 7.2 Viewer-facing / tip page

| Feature | Task | Status |
|---|---|---|
| Public tip page per creator | L03 | DONE |
| Amount required, name optional, message optional | L03 | DONE |
| No phone/email fields | L03 | DONE |
| Minimum tip ₹10, creator-configurable | L03 | DONE |
| Provider-confirmed payment status shown to viewer | L03 | DONE |
| Stalled-payment recovery — order reference + "Check status" | L03 | DONE (2026-08-17 remediation) |
| Pending order survives a page reload | L03 | DONE |
| Rate limit 20/min/IP | L03 | DONE |
| Featured-creator public listing | L03 | DONE (`6afa05f`, `0072`) |
| Amount presets (4, up to 6 on Creator+) | L20 | TODO |
| Saved page profiles, banner, social links, custom colours, logo | L20 | TODO |
| Desktop QR-first layout | L19 | TODO |
| Short opaque `!tip` confirmation page | L15 | TODO |
| Optional YouTube `/live` support page (embed + chat iframe) | L15 | TODO — optional only, keep "Open in YouTube", chat iframe is desktop-only |
| Receipt page reachable without login | L14 | TODO |

## 7.3 Alerts, queues and delivery

| Feature | Task | Status |
|---|---|---|
| Canonical LiveEvent model | L01/L03 | DONE — ~80% source-agnostic |
| Durable queues with sequence numbers | L03/L05 | DONE |
| Transactional outbox + per-queue deliveries | L05 | DONE |
| SSE overlay with `Last-Event-Id` cursor and explicit POST ack | L03 | DONE |
| Reconnect replay from last acknowledged sequence | L03/L05 | DONE |
| 72-hour replay buffer with auto-resync | L03 | DONE |
| Cross-replica fan-out | L05 | DONE |
| Unacknowledged-replay guard | L03 | DONE (`0055`) |
| Overlay policy replay guard | L03 | DONE (`0064`) |
| Queue pause / dispatch guard | L05 | DONE (`0023`) |
| Server-side queue-mode dispatch semantics | L03 | DONE (`5ca128f`, `0065`) |
| Queue policy enforcement | L03/L05 | DONE (`0062`) |
| Overlay invisible unless `?debug=1` | L03 | DONE (2026-08-17 remediation) |
| Multi-queue routing / bindings | L03 | DONE (`queue_bindings`) |
| Queue modes: FIFO | L03 | DONE |
| Queue modes: stacked, pills/compact, aggregated bursts | L03 | DONE — entitlement values pending |
| Queue modes: priority, approval | L03 | DONE — entitlement values pending |
| Quiet hours / quiet mode | L03 | DONE — entitlement value pending |
| Pause / replay / skip | L03 | DONE |
| Rate controls | L03 | DONE |
| No-drop guarantee on every tier | L03/L05 | DONE |

## 7.4 Alert Studio, templates, assets

| Feature | Task | Status |
|---|---|---|
| Approved template library | L03 | DONE within the v1 boundary |
| 4 built-in themes | L03 | DONE |
| Lottie animation | L03 | DONE (`31b7ae9`, `0077`) |
| Custom branding upload | L03 | DONE |
| Custom sound | L03 | DONE |
| Per-event / per-queue styling | L20 | TODO |
| Position, resize, overlap warnings, layer tools | L20 | TODO |
| Custom templates (5 / 12 per channel) | L20 | TODO |
| Creator media and sound libraries (5 / 20) | L20 | TODO |
| Asset storage quotas + scanning pipeline | L20 | PARTIAL — pipeline exists for Lottie |
| Arbitrary HTML/CSS/JS | — | **Never** |

## 7.5 TTS

| Feature | Task | Status |
|---|---|---|
| Sarvam Bulbul premium TTS, 11 Indian languages | L03 | DONE |
| Content-addressed SHA-256 audio cache | L03 | DONE |
| TTS event enrichment | L03 | DONE (`0067`) |
| Synthesis hard caps (2 MB, 60 s) | L03 | DONE |
| Basic browser/device TTS for Free | L03 | TODO — Free currently has no TTS path at all |
| `ttsEnabled` gated by tier | L03 | TODO — currently a bare boolean |
| Monthly character quota metering per tier | L03 | **TODO — highest-priority gap.** Nothing meters TTS spend today. |
| Amount-tiered character limits (₹1–49 visual only, ₹50–199 → 150, ₹200–499 → 300, ₹500+ → 500) | L03 | TODO |
| Profanity filter, URL removal, Unicode normalisation, repeated-character suppression | L03 | PARTIAL |
| Blocked terms / blocked users | L03 | TODO |
| Minimum amount for TTS | L03 | TODO |
| Moderator approval before TTS | L03 | TODO |
| Cancel an in-flight TTS | L07 | TODO |
| Visual-only alert + upgrade prompt on quota exhaustion (no voice downgrade) | L03 | TODO — decided 2026-09-02, see 3.2 |
| Visual / chime fallback when the TTS **provider** fails | L03 | TODO |
| Quota bar visible from ~70% consumption | L03 | TODO |

## 7.6 Widgets and engagement

Everything in this block is L16, all TODO: support goals, recent tips, top supporters, supporter ticker, public leaderboard, mega-tip banner, widget placement, preview data, privacy controls, support votes, hype mode, interaction menu, mega alert, priority question.

## 7.7 Challenges

Everything is L17, all TODO: creator-published flow, viewer-proposed flow, challenge state machine, capability gate on refund support, completion submission, refund initiation and status, dispute record, public challenge board, OBS challenge widget, `!challenge` command. Community challenges are handled as support goals (L16), not refundable contracts.

## 7.8 Connectors and chat commands

All L15, all TODO. Split by phase after the 2026-09-02 decision:

| Feature | Phase | Status |
|---|---|---|
| Google OAuth app verification (read + chat-write scopes) | **v1 — long pole, start first** | TODO, external |
| YouTube Data API quota increase | **v1 — external** | TODO, external |
| `alert_events.source_type` CHECK widening + `source_event_type`, `source_user_id` | **v1** | TODO — one migration |
| YouTube OAuth connection + token storage | **v1** | TODO |
| YouTube live status + `streamList` low-latency chat polling | **v1** | TODO — `services/youtube-poller-go` is empty, build from scratch |
| Super Chat + Super Sticker normalisation | **v1** | TODO |
| Member events, milestone chats, gifted memberships | **v1** | TODO |
| `!tip`, `!tip 100`, `!tip 100 message` | **v1** | TODO |
| Opaque short-link confirmation page | **v1** | TODO |
| Bot acknowledgement into YouTube chat | **v1** | TODO — needs the write scope |
| Connector entitlement counts (0/1/2/3) | **v1** | TODO |
| Optional YouTube `/live` support page | v2 | TODO |
| Twitch EventSub connector | Phase 2 | TODO |
| Kick connector (Beta label) | Phase 2 | TODO |
| `!challenge` | Phase 2 | Gated on L17 |
| Chat display, retention, filtering | Phase 2 | TODO |
| Instagram | Phase 4 | Never a launch dependency |

## 7.9 Viewer identity, profiles, badges

Everything is L14, all TODO, **all in v1** (decided 2026-09-02): anonymous browser identity, platform-scoped identity, full BharatStudio viewer account with signup/login/sessions/DPDP deletion, historical claiming, supporter relations, streaks, badges, opt-in searchable profiles, receipts, the creator/viewer privacy split.

## 7.10 Memberships

Everything is L18, all TODO: YouTube / Twitch / Kick membership normalisation, membership periods and renewal events, member state on the supporter relation, member badges. BharatStudio-native recurring is v2 and gated on recurring-mandate pricing.

## 7.11 Companion — nothing deferred

Per your instruction, no Companion feature is deferred. This is the complete list.

**Companion is a separate product surface** (L07's own wording), bundled with Alerts entitlements today. The conditional action catalogue that makes it standalone-capable is **L24**; the items below are the surface work regardless of how it is sold.

### Shipped

| Feature | Surface |
|---|---|
| Server-owned control-session lease | API + all surfaces |
| Control-session create / delete / lifecycle | API, web, mobile, native |
| Companion state read | API, web, mobile |
| Companion layout read + patch | API, web, mobile |
| Bounded actions with idempotency key and server-side role/lease check | API, web, mobile |
| Action/layout page-size entitlement (8/16/32/64) | API |
| Response-boundary hardening — no donor or payment payload leakage | web, RN, macOS, Windows C# |
| Secure session storage | RN (secure store), macOS (Keychain) |
| Session controller + runtime/bootstrap wiring | RN |
| Offline / reconnect policy | RN |
| Notification / background policy | RN |
| Native APNs + FCM registration, server-side device registry | RN + API (`0057`) |
| Notification preferences and foreground delivery | API, web, RN |
| Google exchange contract | RN |
| Native OBS WebSocket security boundary | macOS, Windows |
| macOS native policy boundary | macOS |
| Signed-out state on every screen | web (2026-08-17 remediation) |
| Auth-gate error/loading shared states | web |

### To build — all of it

| # | Feature | Surface | Notes |
|---|---|---|---|
| 1 | Stream health panel: payment provider, OBS overlay, platform connectors, realtime, TTS, queue — each with a live status and last-heartbeat age | web, mobile, desktop | The 30-Aug §41 panel. Mirrors the creator dashboard. |
| 2 | **Run full test** button — fires a synthetic alert end-to-end and reports each hop | web, mobile, desktop | Also the activation gate in 7.13 |
| 3 | Current and next queue item, live | web, mobile, desktop | |
| 4 | Replay / skip / pause per queue item | web, mobile, desktop | Server actions exist; surfaces need the controls |
| 5 | **Mute TTS** and **cancel in-flight TTS** | web, mobile, desktop | New server action |
| 6 | Approve / reject for approval-mode queues | web, mobile, desktop | Moderation exists in the dashboard; not yet in Companion |
| 7 | Moderation reason capture (inline form, never `window.prompt`) | web, mobile, desktop | Dashboard pattern already fixed; port it |
| 8 | Recent tips list with the donor-visibility scope check applied | web, mobile, desktop | |
| 9 | Payment status per event — pending / captured / failed / refunded | web, mobile, desktop | |
| 10 | Refund status surfacing | web, mobile, desktop | |
| 11 | Challenge state — current, next, awaiting approval | all | Gated on L17 |
| 12 | Support goal progress | all | Gated on L16 |
| 13 | Connection state and reconnect action per platform connector | all | Gated on L15 |
| 14 | Push notification for: new tip above a threshold, queue stalled, overlay disconnected, payment failed, refund failed, TTS quota exhausted | mobile | Registry exists; these event types do not |
| 15 | Per-notification-type preference toggles | web, mobile | Preferences table exists; types need defining |
| 16 | Session and device list with revoke | web, mobile | Server-owned account surface |
| 17 | Consented local OBS scene control — switch scene, toggle source, start/stop | desktop (macOS, Windows) | Security boundary already built; the control surface is not |
| 18 | Desktop helper diagnostics — local port, OBS version, websocket auth state | desktop | |
| 19 | Recovery guidance for connection / session / stream setup failures | all | Bounded, no free-text support channel |
| 20 | Offline queue-of-intent — actions taken offline replay on reconnect, or fail visibly | mobile | Policy exists; the queue does not |
| 21 | iOS App Store and Google Play release | mobile | L10 gate |
| 22 | macOS notarisation, Windows code signing and distribution | desktop | L10 gate |
| 23 | Conditional action catalogue — entitlement × activation two-layer gate | all | **L24** |
| 24 | Generic OBS control: scene, source, mute, stream, record, replay buffer, transition | desktop helpers | **L24** — the switch that makes Companion standalone-capable |
| 25 | Mirror controls: start, stop, screenshot | all | **L24** — L13 already exposes local TCP 27190 |
| 26 | Stream controls: go live, end | all | **L24** |
| 27 | Implicit channel provisioning for Companion-only signups | API | **L24** |
| 28 | Disabled-slot explanations — say *why* a slot is inactive, never a silent grey-out | all | **L24** |

**Boundary that stays.** Companion never exposes donor PII or payment payloads beyond what the creator dashboard already shows for that role. Generic OBS scene control is secondary — BharatStudio's value is monetisation-aware control, not being a worse OBS remote.

## 7.12 Chat display and moderation

| Capability | Free | Pro | Creator | Studio | Task |
|---|---|---|---|---|---|
| Chat display | — | Read-only ephemeral | Filtered | Team | L15 |
| Retention | Disabled | Disabled by default | Opt-in | Team opt-in | L15 |
| Filtering | Platform | Basic | Advanced | Team policy | L15 |
| Moderation actions | — | — | Approved | Role-scoped | L03 (partial) |
| Commands | Template | `!tip` | `!tip` + `!challenge` | Multi-platform | L15 |
| Audit | — | Basic | Yes | Full | L02 (DONE) |

Alert moderation (approve / hold / suppress / replay without deleting the accepted record) is **DONE** in L03. Chat moderation is L15.

## 7.13 Creator onboarding and activation

The 30-Aug §40 sequence, mapped:

1. Sign in — **DONE**
2. Create channel and handle — **DONE** (L03-41 resumable wizard, terms folded in as step 1 of 3)
3. Connect a verified merchant provider — **DONE** (payout onboarding gate, L03-44)
4. Generate the public page — **DONE**
5. Add the OBS browser source — **DONE**
6. Run a full test alert — **PARTIAL**, the one-button end-to-end test is 7.11 item 2
7. Optionally connect YouTube/Twitch/Kick — L15

**A creator is not activated until:** payment provider connected **and** OBS connected **and** a test alert has rendered. Instrument all three (Part 11).

## 7.14 Admin and ops

| Feature | Status |
|---|---|
| Admin console (Next.js, builds, tests pass) | DONE |
| DLQ tooling | DONE (`18df411`, `0073`) |
| Entitlement management | DONE (`e2b6d17`, `0074`) |
| Email delivery + outbox | DONE (`ea2fe98`, `0075`) |
| Featured-creator curation | DONE |
| Reconciliation manual-review queue | DONE (`0059`) |
| Runbooks per critical alert | TODO — L09 |
| On-call rotation | TODO — L10 |

## 7.15 Platform / identity service

| Feature | Status |
|---|---|
| Go service, 18 migrations, tests pass | DONE |
| Threat model + architecture definition | DONE (WP0) |
| Alerts consuming Platform entitlements | v2 — Alerts entitlements stay local for v1 |

---

# PART 8 — GUEST AND VIEWER ACCOUNTS

**Your question: does the plan have a login option for guests so they have history?**

**Short answer: no — not today, and not in v1 as governance currently stands.** Here is the exact position.

### What exists in the code right now

Verified against all 79 migrations: there is **no viewer identity of any kind**. The only viewer data is `donor_display_name` and `donor_message` — free text stored on the payment row. A viewer who tips the same creator ten times produces ten unrelated rows. There is no receipt page, no history, no cross-device anything, and no way for a viewer to prove a past tip was theirs.

### What the 30-Aug plan said

It designed the full three-level model (§20, §21, §22, §55) but placed all of it in **Phase 3** — after Twitch, Kick, challenges and moderators.

### What this plan does with it

L14 (Part 6) carries the complete design forward, and the phasing is deliberately split, because the three levels have very different costs:

| Level | Cost | Value | This plan's position |
|---|---|---|---|
| **1 — Anonymous browser-scoped** | Low. `localStorage` plus a receipt page keyed on an opaque token. | Medium. The viewer can find their receipt and their name is remembered. | **v1.** |
| **2 — Platform-scoped** | Free once L15 exists. The platform user ID arrives with the `!tip`. | High. Lifetime support to that creator, tip count, streak, leaderboard identity — all with **zero signup**. | Ships with L15. Do not build it separately. |
| **3 — BharatStudio viewer account** | High. Signup, sessions, OAuth linking, historical claiming, DPDP deletion, a second auth surface to secure and support. | Medium at launch, high later. Needed for cross-platform merge and for native recurring memberships. | **v1 — DECIDED 2026-09-02.** |

### DECIDED 2026-09-02 — full Level 3 ships in v1

All three levels are in v1. L14 moves onto the critical path in full, which pulls the following onto the launch gate:

| # | Item | Consequence |
|---|---|---|
| 1 | Viewer signup, login, session management, password reset | A **second authentication surface** — separate from the creator surface, with its own rate limits, CSRF, session revocation and abuse handling |
| 2 | Viewer account deletion, DPDP-compliant | Must delete profile and linkage while **preserving the immutable payment and audit record** (§3.8). Needs its own legal review under L08. |
| 3 | Platform OAuth linking (YouTube/Twitch/Kick) for viewers | **Depends on L15.** Without a connector there is nothing to link to, so Level 3 in v1 ships initially as email-based accounts with linking enabled per connector as each lands. |
| 4 | Historical claiming | Idempotent attach of a platform identity's prior history to a new account. Test coverage required for repeat-claim and contested-claim. |
| 5 | Private viewer dashboard — lifetime support, receipts, refunds, memberships, streaks | The cross-creator view. Must be provably invisible to creators (§ privacy rules below). |
| 6 | Opt-in public profile and profile search | Opt-in by default-off. Adds a public surface to moderate. |
| 7 | Badges | Non-financial, opt-in. |
| 8 | Viewer-side support and account-recovery paths | Staffing consequence for L08/L10 — viewers become a second support population. |

**Two things to keep honest about this decision.**

First, **tipping must still never require a login.** Level 3 is additive. If a viewer-account outage ever blocks an anonymous tip, that is a P0.

Second, **L14 is now the largest single addition to v1 scope in this plan** — a full second auth surface plus a public profile system. It widens L02 (security review), L08 (legal review of viewer data handling and deletion), L09 (a second auth surface to load- and fault-test) and L10 (support staffing). Budget for that rather than treating it as a dashboard feature.

### Rules that apply the moment any level ships

- Tipping never requires a login. Not at any level, not ever.
- Never claim history from a typed display name — OAuth-verified platform identity only.
- A creator sees only their own channel's relationship with a viewer. Cross-creator spend is invisible to creators, permanently.
- Public profiles and searchable profiles are opt-in.
- Exact lifetime spend is private by default.

---

# PART 9 — ENTERPRISE (PHASE 2)

## 9.1 How the money actually flows — corrected

An earlier draft of this document framed the 85/15 split as BharatStudio taking a cut and called it a contradiction of the zero-custody rule. **That was wrong.** The corrected model:

- The split is **enterprise ↔ creator**, not BharatStudio ↔ anyone.
- The enterprise defines it. They set a default percentage for creators under their umbrella and may configure a different percentage — or a flat amount — per creator.
- It is executed by **Razorpay Route** as a linked-account split at capture time.
- **BharatStudio takes 0% and holds nothing.** No custody, no wallet, no settlement, no payout. Consistent with 1.4.

```text
Viewer pays ₹1,000
        ↓
Razorpay Route split at capture, per the enterprise's configured rule
        ↓
   ┌────────────────┬──────────────────┐
   │ Creator ₹850   │ Enterprise ₹150  │
   └────────────────┴──────────────────┘

BharatStudio: ₹0. Never in the flow.
```

## 9.2 The one real open question

**Whose Razorpay account hosts the Route?** Route splits require a parent account with linked accounts beneath it. If that parent must be BharatStudio's, BharatStudio is arguably in the flow in a way that 1.4 forbids — even though no money is retained.

This needs Razorpay's answer **in writing** before any Enterprise commitment is made. Part 13, decision 5.

**DECIDED 2026-09-02 — this is the position, and we hold it.** The **enterprise** holds the parent Razorpay account, creators are linked accounts beneath it, and BharatStudio only reads webhooks and writes the split instructions the enterprise configured. BharatStudio is never the parent.

Ask Razorpay now, in writing, even though Enterprise is excluded from v1 — the answer has a long lead time and discovering the constraint mid-deal is the worst possible moment. Specifically confirm:

1. A merchant (the enterprise) can hold a Route parent account with linked sub-accounts.
2. A third-party platform (BharatStudio) can write split instructions against that parent under a scoped grant, without holding or routing funds.
3. Settlement to each linked account is direct, with no intermediate custody.
4. Split rules can differ per linked account, and can be a percentage **or** a flat amount.
5. What happens to an in-flight split if a linked account is suspended.

If Razorpay says a BharatStudio-owned parent is the only supported shape, that is a **product decision to reopen**, not something to accept quietly — it puts BharatStudio structurally in the money flow and contradicts §1.4.

## 9.3 Enterprise capability set

Governance, not features:

- Multi-channel allocations — a workspace can assign a different tier per channel
- SSO
- RBAC beyond owner/moderator
- Shared brand kits and licensed design packs
- Campaigns
- Cross-channel analytics
- API and outbound webhooks
- Finance and audit exports
- SLA and named support

## 9.4 Governance status

**Blocked in v1.** L10's go/no-go states plainly: *"v1 contains no YouTube or Enterprise capability/claim."* The marketing site must not carry an Enterprise tier, an Enterprise CTA, or a "contact sales" flow until L10 is amended. This is currently correct on the site — keep it that way.

---

# PART 10 — SEQUENCED ROADMAP

## 10.1 The unlock: launch is not gated on Razorpay Partner approval

The 30-Aug plan treated Phase 0 as a wall — nothing ships until Razorpay Technology Partner approval lands. **That is not true.**

The manually-pasted `acc_XXX` connection already takes real payments, HMAC-verified, webhook-confirmed, creator-direct, with dedup and reconciliation. Partner OAuth is a **UX upgrade** — it removes a copy-paste step and a scary "paste your account ID" moment. It is not a revenue gate.

What *is* actually gating launch: **L09** (nothing is proven in a deployed environment), **L08** (legal documents lack dated sign-off, now widened to cover viewer account data), and — after the 2026-09-02 decision to ship YouTube in v1 — **Google OAuth app verification and Data API quota**. See 10.2.

## 10.2 Start today — the external long poles

These are not code. They are multi-week external reviews that now sit on the launch critical path, and nothing we build shortens them. **File all three before writing another line of code.**

| # | Item | Owner | Why first |
|---|---|---|---|
| A | **Google OAuth app verification** — read scopes + chat-write scope, with published privacy policy, demo video, per-scope justification | External (Google) | Longest pole in v1. The chat-write scope is high-sensitivity and can bounce; a bounce costs weeks. |
| B | **YouTube Data API quota increase** for concurrent live-chat polling | External (Google) | Second Google review. Without it, chat polling caps out at a handful of creators. |
| C | **Legal sign-off** on privacy, terms, refunds, grievance, data-rights — now including **viewer** account data handling and DPDP deletion | External (counsel) | Blocks public launch, and viewer accounts (L14) widened its scope. |
| D | **Razorpay Route enquiry** — the five questions in 9.2, insisting on an enterprise-owned parent | External (Razorpay) | Not a v1 gate. Sent now purely because the answer has a long lead time and shapes L21 before anyone commits to an enterprise deal. |

None of these blocks development. Build against all four in parallel — they gate launch, not code.

## 10.3 Now — no external dependency

Everything here can be done today, in parallel with the reviews above.

| # | Item | Task |
|---|---|---|
| 1 | Publish the eight entitlement values from 3.2 | L03 |
| 2 | Retier `queueCount` to 1/2/3/5 | L01/L03 |
| 3 | Tier-gate `ttsEnabled` and add the monthly character quota | L03 |
| 4 | **Meter TTS spend.** Nothing does today. Ship this before the first paid creator. | L03 |
| 5 | Browser/device TTS fallback for Free and for quota exhaustion | L03 |
| 6 | Amount-tiered TTS character limits | L03 |
| 7 | Watermark on Free only — after the governance amendment | L03 |
| 8 | Update the pricing page to Studio ₹599 and the 3.2 limits | L08 |
| 9 | Level-1 viewer receipt page + browser-scoped preferences | L14 |
| 9a | **Viewer accounts, full Level 3** — signup, login, sessions, DPDP deletion, private lifetime dashboard, historical claiming, opt-in profiles, badges | L14 |
| 9b | Security and legal review of the viewer auth surface and viewer data handling | L02 / L08 |
| 10 | Companion: stream health, run-full-test, mute/cancel TTS, approve/reject, payment and refund status, recent tips | L07 |
| 11 | Deploy to staging and start L09 | L09 |
| 12 | Legal documents to counsel for dated sign-off, incl. viewer data | L08 |
| 13 | Widen `alert_events.source_type`; add `source_event_type`, `source_user_id` | L01/L15 |
| 14 | YouTube OAuth connection + encrypted token storage | L15 |
| 15 | YouTube live-status + `streamList` chat poller (Go, from scratch — the existing directory is empty) | L15 |
| 16 | Super Chat / Super Sticker / membership normalisation into LiveEvent | L15 |
| 17 | `!tip` parsing, TipIntent creation, opaque short-link confirmation page | L15 |
| 18 | Bot acknowledgement into YouTube chat (behind the write scope) | L15 |
| 19 | Connector entitlement counts 0/1/2/3 | L15 |

## 10.4 Next — after staging exists

| # | Item | Task |
|---|---|---|
| 13 | L09 in full: targets, trace path, dashboards, load, fault injection, recorded measurements | L09 |
| 14 | Runbooks and on-call | L09/L10 |
| 15 | Razorpay Partner OAuth alongside the manual path | L19 |
| 16 | `CreatorPaymentProvider` abstraction extraction | L19 |
| 17 | Support goals and the first widgets | L16 |
| 18 | Companion mobile store submission, desktop signing/notarisation | L07/L10 |
| 19 | Production rehearsal, go/no-go, limited launch cohort | L10 |

## 10.5 Gated on real usage data

Do not start these until there are paying creators generating numbers.

| # | Item | Trigger |
|---|---|---|
| 20 | TTS overage pricing | Actual quota-utilisation distribution |
| 21 | Alert Studio depth (L20) | Creators asking for it |
| 22 | Moderator seats | Creators with teams |
| 23 | Tip-volume brackets | Evidence that high-volume creators are underpriced |
| 24 | Platform-entitlement migration | More than one product needing shared entitlements |

## 10.6 Phases, restated against reality

| Phase | 30-Aug definition | This plan |
|---|---|---|
| **0 — external validation** | Razorpay Partner, Paytm/Cashfree/PhonePe discussions, YouTube OAuth verification, Sarvam production setup, legal review | **Partly done.** Sarvam is live. Razorpay works via the manual path. Legal review is the real open item; the rest are not launch gates. |
| **1 — Free + Pro core** | Creator/channel, Razorpay OAuth, tip page, verified payments, OBS, durable alerts, dashboard/replay, basic TTS, Sarvam TTS, one goal, stream health, YouTube OAuth, `!tip`, bot ack | **Mostly done.** Missing: browser-TTS baseline, support goals, stream-health panel, and the whole YouTube block — **which stays in v1** (decided 2026-09-02), gated on Google verification. |
| **1.5 — low-cost verified UPI** | Paytm/direct PSP connection, UPI intent buttons, status API, desktop QR, provider-neutral selection | **Not started.** Blocked on provider confirmations (L19). |
| **2 — Creator / Studio** | Twitch, Kick Beta, multi-queue, priority/approval, moderators, advanced Alert Studio, interaction menu, challenge beta, support votes, hype, advanced analytics | Multi-queue and priority/approval are **done**; moderator seats decided (0/0/2/5). Twitch and Kick stay here — only YouTube moved to v1. Rest is L16, L17, L20. |
| **3 — viewer identity / recurring** | Optional viewer account, cross-platform linking, private lifetime history, creator-scoped supporter history, streaks, opt-in profiles/search, BharatStudio monthly support, membership badges | **L14 moved entirely into v1** (decided 2026-09-02). Only BharatStudio-native recurring support (L18) remains in Phase 3. |
| **4 — Instagram** | Professional integration, live-comment trigger, private reply flow, Reel/post support, investigate compositor path | Unscheduled. `live_comments` webhook + private reply solves link friction but puts no BharatStudio visual inside the Instagram video. **Never a launch dependency.** |
| **5 — Enterprise** | Multi-channel, SSO, campaigns, shared brands, API, audit/finance, SLA | L21. Governance-blocked until L10 is amended. |

## 10.7 Deliberately cut

| Cut | Reason |
|---|---|
| Studio ₹799 list + ₹499 founder SKU | Zero subscribers; one price, ₹599, is simpler and defensible |
| TTS quotas of 20K/50K/100K | Made ₹599 unviable; 20K/40K/60K holds 64% worst-case margin |
| "No watermark on Free" | Free is the acquisition surface; without a watermark it is pure cost |
| Automatic multi-rail payment routing | Provider-neutral yes, automatic routing no — complexity with no proven demand |
| Refundable multi-contributor community challenges | N independent refund operations, each able to fail; treat as goals |
| Arbitrary viewer media upload | Moderation and legal exposure with no offsetting revenue |
| Android notification scraper / personal-UPI trust mode | Non-negotiable, see 1.4 |

---

# PART 11 — SECURITY, RELIABILITY AND METRICS

## 11.1 Security — every plan, no exceptions

Webhook signature validation · OAuth state and PKCE where required · secret vault · encrypted provider tokens · server-side entitlement evaluation · RBAC · CSRF protection · rate limits · immutable financial audit · idempotency · secure short-lived TipIntent tokens · moderator audit · asset scanning · refund authorisation policy.

**Verified present today:** all of the above except OAuth state/PKCE (no OAuth connection ships yet) and asset scanning beyond the Lottie pipeline.

## 11.2 Reliability principles

```text
Lost captured payment    = unacceptable
Duplicate financial event = unacceptable
```

Reliability metrics to instrument in L09: captured payment without a LiveEvent · duplicate LiveEvent · lost delivery · reconnect replay success · webhook lag · refund failures · TTS failures.

## 11.3 Funnels to instrument

**Creator activation:**
```text
signup → channel → payment provider connected → OBS connected
      → test alert rendered → page shared → first real payment → second stream
```

**Viewer:**
```text
tip page → amount / TipIntent → payment launched → payment captured
```

**Chat command (post-L15):**
```text
!tip → TipIntent → link opened → payment launched → captured
```

## 11.4 The KPI that decides whether this business works

**Tip revenue lift**, measured against the creator's prior QR or static setup:

- tips per viewer-hour
- average tip
- repeat supporter rate
- TTS-driven tips
- threshold uplift
- goal-driven tips
- `!tip` conversion
- challenge revenue
- support-vote revenue

If BharatStudio measurably increases creator revenue, the subscription and the provider's fees both become rational purchases. If it does not, no amount of pricing work saves it. **Instrument this from the first cohort** — you cannot reconstruct it later.

## 11.5 Key risks and mitigations

| Risk | Mitigation |
|---|---|
| Paytm connection model unconfirmed | Commercial confirmation of all eight conditions before implementing anything |
| Provider pricing changes | Never advertise permanent 0% on a rail you do not control |
| Challenge refunds fail (no escrow) | Capability-gated launch + explicit refund state + honest copy |
| Platform API changes | Connector abstraction + feature flags |
| Kick ecosystem maturity | Ship as Beta; financial truth always from the payment provider |
| TTS abuse and cost | Quotas + amount rules + moderation + metering *(metering does not exist yet — 10.3 item 4)* |
| Privacy | Cross-creator history never visible to creators; public profiles opt-in |
| Product bloat | Every feature tested against the 1.3 question |

---

# PART 12 — GOVERNANCE ACTIONS REQUIRED

**Working rule, set 2026-09-02: governance never gates code.** We build and test internally on a continuous basis; no implementation waits on an approval, an amendment, or a sign-off. What governance *does* get is a complete written record — every record below is still written, kept current, and filed. It documents what was built and why. It does not hold anything up.

The one class of exception is external and unavoidable: **Google OAuth verification, the Data API quota, Razorpay's Route answer, and dated legal sign-off** cannot be self-approved. Code against them freely — the review is a launch gate, not a build gate.

| # | Action | Where | Blocks |
|---|---|---|---|
| 1 | **Pricing amendment** — Studio ₹599; drop the ₹799 list and the ₹499 founder SKU | `active/launch/00_LAUNCH_SCOPE_AUTHORITY.md` | Pricing page update (L08) |
| 2 | **Watermark amendment** — remove Pro from the Free/Pro watermark requirement; Free only | `active/launch/04_TEMPLATE_LIBRARY_AUTHORITY.md` | Entitlement publication (L03) |
| 3 | **Entitlement values record** — the eight dimensions from 3.2 plus TTS quotas | L03 + `06_BACKEND_GAP_REMEDIATION_AUTHORITY.md` | Everything tier-gated |
| 4 | **L10 amendment — YouTube only.** Replace *"v1 contains no YouTube or Enterprise capability/claim"* with *"v1 contains no Enterprise capability/claim."* Record the YouTube v1 scope as: read scopes + chat-write scope, Super Chat / Super Sticker / membership normalisation, `!tip`, bot acknowledgement. **Enterprise stays excluded.** | `tasks/L10-release-readiness-and-rollout.md` | L15, and any marketing claim about YouTube |
| 4a | **Add two external gates to L10's go/no-go:** Google OAuth app verification approved (read + chat-write scopes), and YouTube Data API quota sufficient for projected concurrent live-chat polling | `tasks/L10-release-readiness-and-rollout.md` | Launch |
| 5 | **New task files** — L14 through **L24** from Part 6 | `tasks/` | All post-v1 work |
| 5a | **L07 amendment** — record the conditional action catalogue and the extended allowlist as in-scope, superseding the three-action `0041` contract | `tasks/L07-companion-web-mobile-desktop.md` | L24 |
| 5b | **L08 amendment** — record the brand architecture from 2.7–2.11 and the site restructure | `tasks/L08-marketing-support-legal.md` | Site work |
| 6 | **Test records** — TC entries for each new task | `tests/` | Task closure |
| 7 | **Legal sign-off** — dated approval on privacy, terms, refunds, grievance, data-rights, **plus viewer-account data handling and DPDP deletion** (new, from the L14 decision) | L08 + `05_SUPPORT_AND_EXTERNAL_EVIDENCE_REGISTER.md` | Public launch |
| 8 | **This document** committed and referenced as the product authority | `bharatstudio-alerts/docs/` + L03 | — |
| 9 | **Razorpay Route enquiry** — the five questions in 9.2, sent in writing | External | Enterprise commitment (not v1) |

**Column 3 reads "blocks" for launch, not for development.** Every row can be written after the code it describes, as long as it is written.

---

# PART 13 — OPEN DECISIONS [OWNER]

Decisions 1–8 are **closed**, kept as a record of what was chosen and why so none of it gets re-litigated. Decisions 9–11 are **open** — all three arrived with the 2026-09-02 brand and Companion work. New open decisions get appended here rather than argued in chat.

| # | Decision | Options | Consequence |
|---|---|---|---|
| 1 | ~~TTS overage behaviour~~ | **DECIDED 2026-09-02: hard stop + upgrade prompt.** **AMENDED 2026-09-07: browser-voice fallback on exhaustion, keeping what shipped.** No top-up SKU. | See 3.2 and 3.12. The original decision said "no silent downgrade to the browser voice"; that is now reversed. Metering (10.3 item 4) still required and is shipped (migration 0081). |
| 2 | ~~Viewer accounts (Level 3)~~ | **DECIDED 2026-09-02: full Level 3 in v1.** | L14 moves onto the v1 critical path in full. See Part 8 and 10.3. |
| 3 | ~~The 600-template catalogue~~ | **DECIDED 2026-09-02: the 600 already exist; import them later.** Not rebuilt, not discarded. | L20 builds an **import path** for the existing catalogue, not new artwork. v1 ships the four built-in themes. See L20. |
| 4 | ~~Moderator seats~~ | **DECIDED 2026-09-02: 0 / 0 / 2 / 5.** | Published in 3.6. Role-scoping and moderator audit already exist (L02/L03). |
| 5 | ~~Whose Razorpay account hosts the Enterprise Route~~ | **DECIDED 2026-09-02: ask Razorpay now, and hold the line on an enterprise-owned parent.** | The stated requirement is in 9.2. Opened now despite Enterprise being out of v1, because the answer has a long lead time and finding out mid-deal is the worst case. |
| 6 | ~~YouTube connector~~ | **DECIDED 2026-09-02: full YouTube in v1, chat bot included.** Twitch and Kick stay Phase 2. Enterprise stays out of v1. | L10 amendment required (Part 12, item 4). Google verification is the launch long pole — start it before any other L15 work. |
| 7 | ~~Tip-volume brackets~~ | **DECIDED 2026-09-02: wait for data.** | Revisit at ~100 paying creators, when there is a real volume distribution to bracket against. Pricing stays cleanly per-month with no per-transaction dimension. |
| 8 | ~~`lottieEnabled`~~ | **DECIDED: stays a hidden per-tier flag under L20.** Closed by the instruction that eight dimensions is the complete set. | Not a ninth public dimension. |
| 9 | ~~Is Companion bundled or sold separately?~~ | **DECIDED 2026-09-07: Companion is a SEPARATE PRODUCT.** Whether its price is included in an Alerts plan or charged on its own is deliberately left open — and must therefore be **configurable, not hardcoded**. | This is an architectural requirement, not a pricing note. Companion access becomes its own entitlement that an Alerts plan may grant OR that may be sold alone. See 3.13. Decision 11 (naming) is now **unblocked and required**. |
| 10 | ~~How is Mirror sold?~~ | **DECIDED 2026-09-07: its own licence key.** Perpetual or subscription to be set later. | Confirms L13's existing Keychain / Credential Manager licence storage was the right build. Mirror needs no account and no backend. Piracy exposure is accepted as the cost of the simplest distribution. Store listings unblocked. |
| 11 | **Companion's new name** [OWNER] | **NOW REQUIRED** — unblocked by decision 9. A separately-sold product cannot keep a name another vendor owns in its own category. | *Bitfocus Companion* owns the term in the OBS-controller category (2.9). Also collides internally: L13's "CompanionApp TCP 27190" is a different Companion, and `companion-desktop/windows-mirror-test/` belongs to Mirror. Needed before any store listing or marketing page ships. |

---

# PART 14 — REFERENCES

## Payments

- Razorpay Technology Partners — https://razorpay.com/docs/partners/technology-partners/
- Razorpay OAuth for sub-merchants — https://razorpay.com/docs/partners/technology-partners/onboard-businesses/integrate-oauth/
- Razorpay pricing — https://razorpay.com/pricing/
- Razorpay Route — linked-account splits
- Paytm pricing (standard UPI currently published at 0%) — https://business.paytm.com/pricing
- Paytm Partner Program — https://business.paytm.com/paytm-partner-program
- Paytm callback/webhook — https://business.paytm.com/docs/callback-and-webhook/
- Paytm custom checkout — https://business.paytm.com/docs/v1/custom-checkout
- Cashfree Embedded Merchant Onboarding — https://www.cashfree.com/docs/partners/embedded/embedded-merchant-onboarding
- Cashfree pricing / offer terms — https://www.cashfree.com/payment-gateway-charges/
- PhonePe PG Partner Program — https://www.phonepe.com/business-solutions/payment-gateway/partner-program/register/
- PhonePe PG pricing — https://www.phonepe.com/business-solutions/payment-gateway/pricing/

## Direct UPI / Google Pay

- Google Pay for India, Web — https://developers.google.com/pay/india/api/web/intro
- Google Pay India merchant API reference — https://developers.google.com/pay/india/api/merchant-sdk/reference/api
- Google Pay India in-app UPI — https://developers.google.com/pay/india/api/android/in-app-payments
- NPCI merchant intent / deep-link circular — https://www.npci.org.in/PDF/npci/upi/circular/2017/Circular18_BankCompliances_to_enbaleUPIMerchantecosystem_0.pdf

## Platforms

- YouTube LiveChatMessages — https://developers.google.com/youtube/v3/live/docs/liveChatMessages
- YouTube Members — https://developers.google.com/youtube/v3/docs/members
- YouTube embedded live chat — https://support.google.com/youtube/answer/2524549
- Twitch EventSub — https://dev.twitch.tv/docs/eventsub/
- Twitch chat send/receive — https://dev.twitch.tv/docs/chat/send-receive-messages/
- Twitch EventSub subscription types — https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/
- Kick developer docs — https://docs.kick.com
- Kick public API repository — https://github.com/KickEngineering/KickDevDocs
- Meta Instagram API / private reply — https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api

## TTS

- Sarvam API pricing — https://docs.sarvam.ai/api/getting-started/pricing
- Sarvam Text-to-Speech — https://www.sarvam.ai/apis/text-to-speech

## Internal authorities

- `bharatstudio-requirements/tasks/L00`–`L13`, `PLATFORM-WP0`
- `bharatstudio-requirements/active/launch/00_LAUNCH_SCOPE_AUTHORITY.md`
- `bharatstudio-requirements/active/launch/01_MASTER_RELEASE_AUTHORITY.md`
- `bharatstudio-requirements/active/launch/04_TEMPLATE_LIBRARY_AUTHORITY.md`
- `bharatstudio-requirements/active/launch/05_SUPPORT_AND_EXTERNAL_EVIDENCE_REGISTER.md`
- `bharatstudio-requirements/active/launch/06_BACKEND_GAP_REMEDIATION_AUTHORITY.md`
- `bharatstudio-alerts/tasks/LAUNCH-EXECUTION-PLAN.md`

---

# FINAL PRODUCT DEFINITION

BharatStudio is **not** a payment aggregator, a creator wallet, a payout service, a notification scraper, a social network, or a YouTube replacement.

It is:

> **A creator-controlled interaction layer above creator-owned merchant payment accounts and live-platform APIs.**

```text
                       BHARATSTUDIO

        ┌──────────────┬──────────────┬──────────────┐
        │   GET PAID   │  ENGAGE LIVE │ OPERATE LIVE │
        ├──────────────┼──────────────┼──────────────┤
        │ Merchant UPI │ TTS          │ Queues       │
        │ Razorpay     │ Alerts       │ Moderation   │
        │ Paytm        │ Goals        │ Replay       │
        │ Cashfree     │ Votes        │ Team control │
        │ PhonePe      │ Stickers     │ Health       │
        │ Direct PSP   │ Challenges   │ Analytics    │
        │              │ Memberships  │ History      │
        └──────────────┴──────────────┴──────────────┘

                   PLATFORM CONNECTORS
            YouTube      Twitch      Kick
                          │
                    Instagram later
```
