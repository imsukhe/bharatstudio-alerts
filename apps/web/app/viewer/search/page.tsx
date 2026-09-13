'use client';

/*
 * L14 public-profile search. Calls GET /v1/public/viewer-profiles (no
 * auth) via searchPublicViewerProfiles — that endpoint's own where clause
 * is not caller-supplied (see apps/api/src/routes/viewer.ts's comment on
 * the route), so it structurally cannot return a private profile. This
 * page adds no client-side filtering, caching, or merging of its own: it
 * renders exactly the rows the last search call returned and nothing
 * carried over from an earlier one, so a viewer who goes private between
 * two searches never sees their own stale public row reappear.
 */
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Card } from '../../components/ui/Card';
import { ViewerShell } from '../ViewerShell';
import { searchPublicViewerProfiles } from '../lib/viewer-api';

type ProfileRow = { displayName: string | null; profileSlug: string };

export default function ViewerSearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProfileRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function search(event: FormEvent) {
    event.preventDefault();
    setSearching(true);
    setError(null);
    try {
      // Always a fresh call, never a merge with the previous `results` —
      // whatever comes back this time fully replaces what was on screen.
      const rows = await searchPublicViewerProfiles(query.trim());
      setResults(rows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Search is temporarily unavailable');
      setResults(null);
    } finally {
      setSearching(false);
    }
  }

  return (
    <ViewerShell title="Find a viewer profile.">
      <Card eyebrow="Public profiles" title="Search" helper="Only viewers who opted in to a public profile can be found here. Support amounts, payments, and receipts are never shown.">
        <form onSubmit={(event) => void search(event)} className="stack-form">
          <label>Display name or link<input aria-label="Search public profiles" value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} placeholder="ravi" /></label>
          <button className="button-primary" type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
        </form>
        {error && <p className="error-text" role="alert">{error}</p>}
        {!error && results !== null && results.length === 0 && <p className="helper-text">No public profiles found.</p>}
        {!error && results !== null && results.length > 0 && (
          <ul className="viewer-search-results">
            {results.map((profile) => (
              <li key={profile.profileSlug}>
                <Link href={`/viewer/profiles/${profile.profileSlug}`}>{profile.displayName ?? profile.profileSlug}</Link>
                <span className="helper-text"> @{profile.profileSlug}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </ViewerShell>
  );
}
