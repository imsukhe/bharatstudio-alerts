'use client';

/*
 * Creator management UI for the L22 curated sticker catalogue. Lists every
 * catalogue entry available at the channel's current tier and lets an
 * owner/admin turn each one on or off for their own channel. There is no
 * upload control anywhere in this file — a creator can only toggle an
 * id that already exists in the BharatStudio-approved catalogue (see
 * apps/api/src/routes/stickers.ts and migration 0110).
 *
 * Reuses the shared useStatusMessage/StatusMessage pair and the ui/*
 * primitives — no new notification or toggle pattern is introduced here.
 */
import { useEffect, useState } from 'react';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { Button } from '../../components/ui/Button';
import { listStickers, setStickerEnabled, type Sticker } from './sticker-api';

const TIER_LABELS: Record<Sticker['minTier'], string> = {
  free: 'Free and up',
  pro: 'Pro and up',
  creator: 'Creator and up',
  studio: 'Studio only',
};

export function StickerPanel({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const [stickers, setStickers] = useState<Sticker[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const { message, messageKind, notify } = useStatusMessage();

  useEffect(() => {
    let cancelled = false;
    listStickers(channelId)
      .then((response) => { if (!cancelled) setStickers(response.items); })
      .catch((cause) => { if (!cancelled) notify(cause instanceof Error ? cause.message : 'Stickers are temporarily unavailable', 'error'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function onToggle(sticker: Sticker) {
    setPendingId(sticker.id);
    try {
      const result = await setStickerEnabled(channelId, sticker.id, !sticker.enabled);
      setStickers((current) => current?.map((item) => (item.id === sticker.id ? { ...item, enabled: result.enabled } : item)) ?? current);
      notify(result.enabled ? `${sticker.displayName} is now available on your stream.` : `${sticker.displayName} is turned off for your stream.`, 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'That sticker could not be updated', 'error');
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="stickers-panel">
      <StatusMessage message={message} kind={messageKind} />

      {!canManage && <p className="helper-text">Only the channel owner or an admin can turn stickers on or off.</p>}

      {stickers === null && <p className="helper-text" role="status">Loading…</p>}
      {stickers !== null && stickers.length === 0 && <p className="helper-text">No stickers are available at your current tier yet.</p>}
      {stickers !== null && stickers.length > 0 && (
        <ul className="stickers-list">
          {stickers.map((sticker) => (
            <li key={sticker.id} className="stickers-list-item">
              <div className="stickers-list-heading">
                <strong>{sticker.displayName}</strong>
                <span>{sticker.enabled ? 'On' : 'Off'}</span>
              </div>
              <p className="helper-text">{sticker.category} — {TIER_LABELS[sticker.minTier]}</p>
              {canManage && (
                <Button type="button" onClick={() => void onToggle(sticker)} disabled={pendingId === sticker.id}>
                  {pendingId === sticker.id ? 'Updating…' : sticker.enabled ? 'Turn off' : 'Turn on'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
