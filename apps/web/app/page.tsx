'use client';

/*
 * / — no static homepage. This app's whole purpose is sign-in → dashboard,
 * and the marketing site (bharatstudio-marketing, a separate static
 * export) already owns the "explain the product" job — its own "Get
 * started" CTA links straight to this app's /login, not to /. So this
 * root route is a pure redirect: signed in → resolve onward exactly like
 * /onboarding does (terms, then channel existence, then dashboard);
 * signed out → /login.
 *
 * Previously this rendered a real marketing-style hero page (built
 * earlier in the same redesign this file is now part of) — replaced on
 * explicit direction once the login/onboarding/dashboard chain existed to
 * redirect into.
 */
import { useEffect } from 'react';
import { getAccessToken } from './lib/api';

export default function RootPage() {
  useEffect(() => {
    window.location.replace(getAccessToken() ? '/onboarding' : '/login');
  }, []);

  return null;
}
