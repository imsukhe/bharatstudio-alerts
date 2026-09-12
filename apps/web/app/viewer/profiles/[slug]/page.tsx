'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ViewerShell } from '../../ViewerShell';
import { getPublicViewerProfile } from '../../lib/viewer-api';

export default function PublicViewerProfilePage() {
  const params = useParams<{ slug: string }>();
  const [profile, setProfile] = useState<{ displayName: string | null; profileSlug: string } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.slug) return;
    void getPublicViewerProfile(params.slug).then(setProfile).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Profile is temporarily unavailable'));
  }, [params.slug]);

  return <ViewerShell title="Viewer profile.">
    {error && <p className="error-text" role="alert">{error}</p>}
    {!error && profile === undefined && <p className="helper-text" role="status">Loading…</p>}
    {!error && profile === null && <p className="helper-text">This profile is private or does not exist.</p>}
    {!error && profile && <section className="panel"><h2>{profile.displayName ?? profile.profileSlug}</h2><p className="helper-text">@{profile.profileSlug}</p><p className="helper-text">This public profile shares no support amounts, payment history, or receipts.</p></section>}
  </ViewerShell>;
}
