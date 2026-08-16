'use client';

/*
 * Authenticated app shell — fixed sidebar + sticky topbar, replacing the
 * flat `TopNav` + `page-shell` treatment on every signed-in surface
 * (dashboard, companion, payments, settings, overlay setup). Ported from
 * the legacy dashboard's layout.tsx/nav.tsx structure (sidebar with live
 * identity + tier badge, active-route indicator, sticky topbar with a page
 * title slot) onto this app's own design tokens and component conventions
 * — class-based styling in styles.css, not legacy's inline `style={{}}`
 * objects, and a client-side identity fetch instead of legacy's
 * server-side cookie session (this app has no server session to read; the
 * bearer token lives in sessionStorage only).
 *
 * Each shell-wrapped page still owns its own data fetching and content —
 * this component only owns the chrome around it, plus one lightweight
 * identity fetch (current user + first channel + billing tier) for the
 * sidebar's live tier badge and handle, which legacy's server layout got
 * for free from the session but this app has to ask for.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearAccessToken, getBilling, getChannel, getCurrentUser, getTermsStatus, type CurrentUser, type PaidTier } from '../lib/api';
import { resolvePostAuthDestination } from '../onboarding/onboarding-routing';

type NavItem = { href: string; label: string; icon: ReactNode };

function IconGrid() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v2L2 10h12l-1.5-2V6A4.5 4.5 0 0 0 8 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6.5 10.5a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconOverlay() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 14.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M8 11.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconCreditCard() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M1.5 6.5h13" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 9.5h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1.5v1M8 13.5v1M1.5 8h-1M15.5 8h-1M3.4 3.4l-.7-.7M13.3 13.3l-.7-.7M3.4 12.6l-.7.7M13.3 2.7l-.7.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconSliders() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="5" cy="4" r="1.5" fill="currentColor" />
      <circle cx="11" cy="8" r="1.5" fill="currentColor" />
      <circle cx="7" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.5L2 4v4c0 3 2.5 5.5 6 6 3.5-.5 6-3 6-6V4L8 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.5 8l2 2 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconLink() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5 9.5a3.5 3.5 0 0 0 5 0l2-2a3.536 3.536 0 0 0-5-5l-1 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9.5 6.5a3.5 3.5 0 0 0-5 0l-2 2a3.536 3.536 0 0 0 5 5l1-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconReceipt() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 2h10v12l-2-1.5L9 14l-1-1.5L7 14l-2-1.5L3 14V2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.5 6h5M5.5 8.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconCast() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.5 11.5v2h2a2 2 0 0 0-2-2Z" fill="currentColor" />
      <path d="M1.5 8.5a5.5 5.5 0 0 1 5.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M1.5 5.5A8.5 8.5 0 0 1 10 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <rect x="7.5" y="1.5" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// Ordered to match legacy's flat sidebar grouping (Overview, Alerts,
// Payments, Customise, Mod console, Referrals, Settings, Billing — legacy's
// "Page Design" has no equivalent here and is intentionally omitted, not
// silently renamed), with this app's own Companion/Overlay surfaces
// appended after — legacy has no equivalent of either.
const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: <IconGrid /> },
  { href: '/dashboard/alerts', label: 'Alerts', icon: <IconBell /> },
  { href: '/payments', label: 'Payments', icon: <IconCreditCard /> },
  { href: '/dashboard/customise', label: 'Customise', icon: <IconSliders /> },
  { href: '/dashboard/mod', label: 'Mod console', icon: <IconShield /> },
  { href: '/dashboard/referrals', label: 'Referrals', icon: <IconLink /> },
  { href: '/settings', label: 'Settings', icon: <IconSettings /> },
  { href: '/dashboard/billing', label: 'Billing', icon: <IconReceipt /> },
  { href: '/companion', label: 'Companion', icon: <IconCast /> },
  { href: '/overlay/setup', label: 'Overlay', icon: <IconOverlay /> },
];

const TIER_LABEL: Record<PaidTier | 'free', string> = { free: 'Free', pro: 'Pro', creator: 'Creator', studio: 'Studio' };

type Props = { title: string; actions?: ReactNode; children: ReactNode };

export function AppShell({ title, actions, children }: Props) {
  const pathname = usePathname();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Distinct from "still loading" — set only once getCurrentUser() has
  // actually failed, so the sidebar can stop showing an indefinite
  // "Loading…" identity chip and a "Sign out" button that implies a session
  // exists when it doesn't. See the identityLabel/sign-out-button usage below.
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    // Terms re-acceptance gate. A channel cannot be created without terms
    // already accepted (POST /v1/channels requires requireAuthAndTerms
    // server-side), so this can't be reached on first-time onboarding —
    // but if a new terms/privacy document version is published after a
    // creator's channel already exists, they need to re-accept it, and
    // nothing about "does this channel exist" changes to reflect that.
    // Every shell-wrapped page used to rely on the one page that happened
    // to check terms (the old single-page dashboard); once the dashboard
    // split into five independently-routed pages, only the page that kept
    // the check (Overview) still had it — Companion/Payments/Settings/
    // Overlay-setup never had it either. Centralizing it here, in the
    // chrome every one of those pages shares, closes it in one place
    // instead of nine. The backend still fails closed on any mutation
    // either way; this only prevents the confusing "fully interactive
    // page that 403s on the first real action" experience /accept-terms
    // itself exists to avoid.
    let cancelled = false;
    getTermsStatus()
      .then((status) => {
        if (!cancelled && !status.accepted) window.location.assign('/accept-terms');
      })
      .catch(() => { /* Unreachable — fail open on this specific chrome check; each page's own data fetch surfaces the real error, and any mutation still fails closed server-side. */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getCurrentUser()
      .then(async (nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
        const first = nextUser.channels[0];
        if (!first) return;
        // Onboarding gate: every shell-wrapped page assumes a fully
        // onboarded account (channel created, payout step finished or
        // explicitly skipped). resolvePostAuthDestination already encodes
        // both checks — reusing it here means this can't drift from
        // /onboarding's own resolution of the same state. No channel case
        // isn't expected to reach AppShell at all (each page's own fetch
        // already redirects to /onboarding first), but is handled
        // identically here for defense in depth.
        const destination = resolvePostAuthDestination(nextUser);
        if (destination !== '/dashboard') { window.location.assign(destination); return; }
        try {
          const [channel, billing] = await Promise.all([getChannel(first.channelId), getBilling(first.channelId)]);
          if (cancelled) return;
          setHandle(channel.handle);
          setTier(billing.tier);
        } catch {
          // Identity chrome degrades quietly to the generic state — each
          // page's own content already surfaces the real error.
        }
      })
      .catch(() => { if (!cancelled) setSignedOut(true); });
    return () => { cancelled = true; };
  }, []);

  function signOut() {
    clearAccessToken();
    window.location.assign('/login');
  }

  const identityLabel = signedOut ? 'Not signed in' : handle ? `@${handle}` : user?.displayName ?? 'Loading…';
  const initials = (identityLabel.replace('@', '')[0] ?? 'B').toUpperCase();
  const role = user?.channels[0]?.role;

  return (
    <div className="app-shell">
      <button
        type="button"
        className="app-sidebar-toggle"
        aria-label={menuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          {menuOpen ? (
            <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          ) : (
            <path d="M3 5h12M3 9h12M3 13h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          )}
        </svg>
      </button>

      <aside className={`app-sidebar${menuOpen ? ' is-open' : ''}`}>
        <Link href="/" className="brand app-sidebar-brand">Bharat<span className="brand-accent">Studio</span></Link>
        <nav className="app-nav" aria-label="Dashboard navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/dashboard' && (pathname?.startsWith(item.href) ?? false));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`app-nav-item${isActive ? ' is-active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setMenuOpen(false)}
              >
                <span className="app-nav-icon" aria-hidden="true">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="app-sidebar-user">
          {tier && <span className="app-tier-badge" data-tier={tier}>{TIER_LABEL[tier as PaidTier] ?? tier}</span>}
          <div className="app-sidebar-identity">
            <span className="app-avatar" aria-hidden="true">{initials}</span>
            <div className="app-identity-text">
              <p className="app-identity-name">{identityLabel}</p>
              {role && <p className="app-identity-role">{role}</p>}
            </div>
          </div>
          {signedOut ? (
            <Link href="/login" className="app-sign-out">Sign in →</Link>
          ) : (
            <button type="button" className="app-sign-out" onClick={signOut}>Sign out</button>
          )}
        </div>
      </aside>
      {menuOpen && <div className="app-sidebar-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />}

      <div className="app-main">
        <header className="app-topbar">
          <h1>{title}</h1>
          <div className="app-topbar-actions">
            {actions}
            {handle && <a className="text-link app-topbar-link" href={`/tips/${handle}`} target="_blank" rel="noreferrer">Tip page →</a>}
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
