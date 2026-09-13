'use client';

/*
 * L22 gap-fill: creator-authored sticker pack management. Distinct from
 * StickerPanel.tsx (the BharatStudio-approved catalogue toggle-only UI) —
 * this panel is the one place in the whole L22 surface where a creator
 * supplies their own asset. It never accepts a viewer-supplied asset:
 * only the channel owner/admin sees this panel (canManage), and the
 * upload itself still passes through server-side content-safety
 * validation (apps/api/src/domain/sticker-creator-pack-validation.ts)
 * before it is ever stored.
 *
 * The render-document field is a raw JSON textarea rather than a file
 * picker — matches this codebase's existing Lottie/branding upload UX
 * (synthetic/small hand-authored documents), and keeps this file from
 * inventing a binary-upload widget that does not exist anywhere else in
 * the app.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { StatusMessage } from '../../components/StatusMessage';
import { useStatusMessage } from '../../hooks/useStatusMessage';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { listCreatorPack, setCreatorPackStickerEnabled, uploadCreatorPackSticker, type CreatorPackSticker } from './creator-pack-api';

const STATUS_LABELS: Record<CreatorPackSticker['status'], string> = {
  active: 'Live',
  pending_review: 'Pending review',
};

export function CreatorPackPanel({ channelId, canManage }: { channelId: string; canManage: boolean }) {
  const [pack, setPack] = useState<CreatorPackSticker[] | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [category, setCategory] = useState('');
  const [renderDocumentText, setRenderDocumentText] = useState('');
  const [creatorAttested, setCreatorAttested] = useState(false);
  const [uploading, setUploading] = useState(false);
  const { message, messageKind, notify } = useStatusMessage();

  function refresh() {
    return listCreatorPack(channelId)
      .then((response) => setPack(response.items))
      .catch((cause) => notify(cause instanceof Error ? cause.message : 'Your creator pack is temporarily unavailable', 'error'));
  }

  useEffect(() => {
    let cancelled = false;
    listCreatorPack(channelId)
      .then((response) => { if (!cancelled) setPack(response.items); })
      .catch((cause) => { if (!cancelled) notify(cause instanceof Error ? cause.message : 'Your creator pack is temporarily unavailable', 'error'); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  async function onToggle(sticker: CreatorPackSticker) {
    setPendingId(sticker.id);
    try {
      const result = await setCreatorPackStickerEnabled(channelId, sticker.id, !sticker.enabled);
      setPack((current) => current?.map((item) => (item.id === sticker.id ? { ...item, enabled: result.enabled } : item)) ?? current);
      notify(result.enabled ? `${sticker.displayName} is now available on your stream.` : `${sticker.displayName} is turned off for your stream.`, 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'That pack sticker could not be updated', 'error');
    } finally {
      setPendingId(null);
    }
  }

  async function onUpload(event: FormEvent) {
    event.preventDefault();
    let renderDocument: unknown;
    try {
      renderDocument = JSON.parse(renderDocumentText);
    } catch {
      notify('Render document must be valid JSON', 'error');
      return;
    }
    setUploading(true);
    try {
      await uploadCreatorPackSticker(channelId, displayName, category, renderDocument, creatorAttested);
      setDisplayName('');
      setCategory('');
      setRenderDocumentText('');
      setCreatorAttested(false);
      notify('Pack sticker uploaded.', 'success');
      await refresh();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'That pack sticker could not be uploaded', 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="creator-pack-panel">
      <StatusMessage message={message} kind={messageKind} />

      {!canManage && <p className="helper-text">Only the channel owner or an admin can manage the creator pack.</p>}

      {pack === null && <p className="helper-text" role="status">Loading…</p>}
      {pack !== null && pack.length === 0 && <p className="helper-text">You haven&apos;t added any pack stickers yet.</p>}
      {pack !== null && pack.length > 0 && (
        <ul className="creator-pack-list">
          {pack.map((sticker) => (
            <li key={sticker.id} className="creator-pack-list-item">
              <div className="creator-pack-list-heading">
                <strong>{sticker.displayName}</strong>
                <span>{STATUS_LABELS[sticker.status]} — {sticker.enabled ? 'On' : 'Off'}</span>
              </div>
              <p className="helper-text">{sticker.category}</p>
              {sticker.status === 'pending_review' && <p className="helper-text">Awaiting platform review before it appears to viewers.</p>}
              {canManage && (
                <Button type="button" onClick={() => void onToggle(sticker)} disabled={pendingId === sticker.id}>
                  {pendingId === sticker.id ? 'Updating…' : sticker.enabled ? 'Turn off' : 'Turn on'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <form onSubmit={(event) => void onUpload(event)} className="creator-pack-upload-form">
          <h3>Add a pack sticker</h3>
          <Field label="Display name">
            <input type="text" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={120} required />
          </Field>
          <Field label="Category">
            <input type="text" value={category} onChange={(event) => setCategory(event.target.value)} maxLength={60} required />
          </Field>
          <Field label="Render document (JSON)">
            <textarea value={renderDocumentText} onChange={(event) => setRenderDocumentText(event.target.value)} rows={6} required />
          </Field>
          <Field label="I confirm I hold the rights to this asset">
            <input type="checkbox" checked={creatorAttested} onChange={(event) => setCreatorAttested(event.target.checked)} />
          </Field>
          <Button type="submit" disabled={uploading}>{uploading ? 'Uploading…' : 'Upload'}</Button>
        </form>
      )}
    </div>
  );
}
