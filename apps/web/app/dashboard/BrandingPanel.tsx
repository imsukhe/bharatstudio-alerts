'use client';

/*
 * Studio-tier Lottie/custom branding upload — v1 scope addendum item.
 * Reads/writes GET/PUT/DELETE /v1/channels/:id/branding/lottie/:displayStyle
 * (database-enforced Studio-tier + owner/admin-only; a non-Studio caller
 * gets a clear "requires Studio" message here rather than a silent
 * failure, since — unlike most role-based gates in this app — tier is
 * meaningful, actionable information for the caller). One upload slot per
 * displayStyle (the same six-value enum every alert bracket already
 * carries), not per bracket instance — see migration 0077's header
 * comment for why.
 */
import { useEffect, useState } from 'react';
import { deleteLottieAsset, getLottieAssets, uploadLottieAsset, type DisplayStyle, type LottieAssetSummary } from '../lib/api';

type Props = { channelId: string };

const SLOT_LABELS: Record<DisplayStyle, string> = {
  small_pill: 'Small pill', compact_card: 'Compact card', standard_card: 'Standard card',
  large_card: 'Large card', banner: 'Banner', celebration: 'Celebration',
};
const SLOTS: DisplayStyle[] = ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'];

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function BrandingPanel({ channelId }: Props) {
  const [assets, setAssets] = useState<Map<DisplayStyle, LottieAssetSummary>>(new Map());
  const [busySlot, setBusySlot] = useState<DisplayStyle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function refresh() {
    getLottieAssets(channelId)
      .then((page) => setAssets(new Map(page.items.map((item) => [item.displayStyle, item]))))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Branding data is temporarily unavailable'));
  }

  useEffect(refresh, [channelId]);

  async function handleUpload(slot: DisplayStyle, file: File) {
    setError(null); setNotice(null); setBusySlot(slot);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      await uploadLottieAsset(channelId, slot, parsed);
      setNotice(`${SLOT_LABELS[slot]} animation uploaded.`);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Upload failed. Please try again.');
    } finally {
      setBusySlot(null);
    }
  }

  async function handleDelete(slot: DisplayStyle) {
    setError(null); setNotice(null); setBusySlot(slot);
    try {
      await deleteLottieAsset(channelId, slot);
      setNotice(`${SLOT_LABELS[slot]} animation removed.`);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Removal failed. Please try again.');
    } finally {
      setBusySlot(null);
    }
  }

  return (
    <div className="branding-panel">
      <p className="helper-text">Upload a custom Lottie (.json) animation for any alert style. Files must be under 2 MB, cannot reference external assets or embed expressions, and are validated before saving.</p>
      {notice && <p className="inline-message" role="status">{notice}</p>}
      {error && <p className="inline-message error-text" role="alert">{error}</p>}
      <div className="channel-list">
        {SLOTS.map((slot) => {
          const asset = assets.get(slot);
          const busy = busySlot === slot;
          return (
            <div className="channel-row" key={slot}>
              <div>
                <strong>{SLOT_LABELS[slot]}</strong>
                <span>{asset ? `${formatSize(asset.byteSize)} · updated ${new Date(asset.updatedAt).toLocaleDateString('en-IN')}` : 'No custom animation'}</span>
              </div>
              <div className="control-actions">
                <label className="secondary-button branding-upload-label">
                  {busy ? 'Working…' : asset ? 'Replace' : 'Upload'}
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="branding-upload-input"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void handleUpload(slot, file);
                    }}
                  />
                </label>
                {asset && <button type="button" className="secondary-button" disabled={busy} onClick={() => void handleDelete(slot)}>Remove</button>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
