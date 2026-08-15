'use client';

import { useMemo, type CSSProperties, type FormEvent } from 'react';
import type { ChannelConfigValues, ConfigBracket } from '../lib/api';

type QueueMode = NonNullable<ChannelConfigValues['queue']>['mode'];
type StyleName = NonNullable<ChannelConfigValues['defaultStyle']>;

const styles: StyleName[] = ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'];
const locales = ['en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN', 'or-IN', 'as-IN', 'ur-IN'];
const anchors = ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right'];
const overflowPolicies: NonNullable<ConfigBracket['ttsOverflowPolicy']>[] = ['extend', 'truncate_speech', 'truncate_visual', 'visual_only', 'disable'];

const defaultBracket: ConfigBracket = {
  amountMinPaise: 1000,
  amountMaxPaise: null,
  charLimit: 120,
  ttsEligible: true,
  displayStyle: 'standard_card',
  displayMinMs: 8000,
  ttsOverflowPolicy: 'extend',
};

type Props = {
  version: number;
  draft: ChannelConfigValues;
  saving: boolean;
  onChange: (next: ChannelConfigValues) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function previewPlacement(anchor: string | undefined): Pick<CSSProperties, 'alignItems' | 'justifyContent'> {
  const [vertical, horizontal] = (anchor ?? 'bottom_center').split('_');
  return { alignItems: vertical === 'top' ? 'start' : vertical === 'center' ? 'center' : 'end', justifyContent: horizontal === 'left' ? 'start' : horizontal === 'right' ? 'end' : 'center' };
}

function label(value: string): string { return value.replaceAll('_', ' '); }

export function ChannelConfigEditor({version, draft, saving, onChange, onSubmit}: Props) {
  const brackets = draft.brackets?.length ? draft.brackets : [defaultBracket];
  const queue = draft.queue ?? {};
  const display = draft.display ?? {};
  const tts = draft.tts ?? {};
  const previewStyle = draft.defaultStyle ?? 'standard_card';
  const previewScale = display.scale ?? 1;
  const bracketSummary = useMemo(() => `${brackets.length} amount bracket${brackets.length === 1 ? '' : 's'}`, [brackets.length]);

  function updateBracket(index: number, patch: Partial<ConfigBracket>) {
    onChange({...draft, brackets: brackets.map((bracket, current) => current === index ? {...bracket, ...patch} : bracket)});
  }

  function addBracket() {
    const last = brackets[brackets.length - 1];
    const nextMin = last.amountMaxPaise === null ? last.amountMinPaise + 100_000 : last.amountMaxPaise + 1;
    const next = {...defaultBracket, amountMinPaise: nextMin};
    onChange({...draft, brackets: last.amountMaxPaise === null ? [...brackets.slice(0, -1), {...last, amountMaxPaise: nextMin - 1}, next] : [...brackets, next]});
  }

  function removeFinalBracket() {
    if (brackets.length <= 1) return;
    const previous = brackets[brackets.length - 2];
    onChange({...draft, brackets: [...brackets.slice(0, -2), {...previous, amountMaxPaise: null}]});
  }

  return <section className="panel config-panel" aria-labelledby="config-title">
    <div className="panel-heading"><div><p className="muted-label">Alert configuration · v{version}</p><h2 id="config-title">Set the default experience</h2></div><span className="helper-text">Changes apply to new alerts.</span></div>
    <form className="config-form" onSubmit={onSubmit}>
      <fieldset className="config-fieldset"><legend>Default alert</legend><div className="config-grid">
        <label>Minimum tip (₹)<input required type="number" min="10" max="10000000" step="1" value={Math.round((draft.minimumTipPaise ?? 1000) / 100)} onChange={(event) => onChange({...draft, minimumTipPaise: Math.round(Number(event.target.value) * 100)})} /><small>Platform minimum is ₹10.</small></label>
        <label>Display time (seconds)<input required type="number" min="4" max="60" step="1" value={draft.defaultDisplaySeconds ?? 8} onChange={(event) => onChange({...draft, defaultDisplaySeconds: Number(event.target.value)})} /><small>Longer messages may need more time.</small></label>
        <label>Default style<select value={previewStyle} onChange={(event) => onChange({...draft, defaultStyle: event.target.value as StyleName})}>{styles.map((style) => <option key={style} value={style}>{label(style)}</option>)}</select></label>
        <label>Language<select value={draft.locale ?? 'en-IN'} onChange={(event) => onChange({...draft, locale: event.target.value})}>{locales.map((locale) => <option key={locale} value={locale}>{locale}</option>)}</select></label>
      </div><label className="checkbox-label"><input type="checkbox" checked={draft.reducedMotion ?? false} onChange={(event) => onChange({...draft, reducedMotion: event.target.checked})} /> Reduce motion for this channel</label></fieldset>

      <fieldset className="config-fieldset"><legend>Screen and layout</legend><div className="config-grid">
        <label>Screen position<select value={display.anchor ?? 'bottom_center'} onChange={(event) => onChange({...draft, display: {...display, anchor: event.target.value}})}>{anchors.map((anchor) => <option key={anchor} value={anchor}>{label(anchor)}</option>)}</select></label>
        <label>Overlay scale<input required type="number" min="0.5" max="2" step="0.1" value={display.scale ?? 1} onChange={(event) => onChange({...draft, display: {...display, scale: Number(event.target.value)}})} /><small>0.5× to 2×; OBS can also resize the browser source.</small></label>
        <label>Horizontal offset (px)<input type="number" min="-10000" max="10000" value={display.offsetX ?? 0} onChange={(event) => onChange({...draft, display: {...display, offsetX: Number(event.target.value)}})} /></label>
        <label>Vertical offset (px)<input type="number" min="-10000" max="10000" value={display.offsetY ?? 0} onChange={(event) => onChange({...draft, display: {...display, offsetY: Number(event.target.value)}})} /></label>
        <label>Width (% of canvas)<input required type="number" min="10" max="100" value={display.widthPercent ?? 80} onChange={(event) => onChange({...draft, display: {...display, widthPercent: Number(event.target.value)}})} /></label>
        <label>Maximum visible alerts<input required type="number" min="1" max="10" value={display.maxVisibleItems ?? queue.stackLimit ?? 1} onChange={(event) => onChange({...draft, display: {...display, maxVisibleItems: Number(event.target.value)}, queue: {...queue, stackLimit: Number(event.target.value)}})} /><small>Only changes presentation; durable queue rows remain safe.</small></label>
      </div></fieldset>

      <fieldset className="config-fieldset"><legend>Amount brackets <span className="legend-detail">{bracketSummary}</span></legend><p className="helper-text">Each bracket controls message length, display style, minimum time and TTS behavior. Brackets must be contiguous and end with an open range.</p><div className="bracket-list">{brackets.map((bracket, index) => <div className="bracket-card" key={`${index}-${bracket.amountMinPaise}`}><div className="bracket-heading"><strong>Bracket {index + 1}</strong><span>{bracket.amountMaxPaise === null ? 'and above' : `₹${bracket.amountMinPaise / 100}–₹${bracket.amountMaxPaise / 100}`}</span></div><div className="config-grid"><label>Minimum (₹)<input required type="number" min="10" max="10000000" value={bracket.amountMinPaise / 100} onChange={(event) => updateBracket(index, {amountMinPaise: Math.round(Number(event.target.value) * 100)})} /></label><label>Maximum (₹)<input type="number" min="10" max="10000000" value={bracket.amountMaxPaise === null ? '' : bracket.amountMaxPaise / 100} placeholder="No maximum" onChange={(event) => updateBracket(index, {amountMaxPaise: event.target.value === '' ? null : Math.round(Number(event.target.value) * 100)})} /></label><label>Message limit (characters)<input required type="number" min="10" max="500" value={bracket.charLimit} onChange={(event) => updateBracket(index, {charLimit: Number(event.target.value)})} /></label><label>Display style<select value={bracket.displayStyle} onChange={(event) => updateBracket(index, {displayStyle: event.target.value as StyleName})}>{styles.map((style) => <option key={style} value={style}>{label(style)}</option>)}</select></label><label>Minimum display time (seconds)<input required type="number" min="4" max="60" value={bracket.displayMinMs / 1000} onChange={(event) => updateBracket(index, {displayMinMs: Number(event.target.value) * 1000})} /></label><label>TTS overflow policy<select value={bracket.ttsOverflowPolicy} onChange={(event) => updateBracket(index, {ttsOverflowPolicy: event.target.value as ConfigBracket['ttsOverflowPolicy']})}>{overflowPolicies.map((policy) => <option key={policy} value={policy}>{label(policy)}</option>)}</select></label></div><label className="checkbox-label"><input type="checkbox" checked={bracket.ttsEligible} onChange={(event) => updateBracket(index, {ttsEligible: event.target.checked})} /> Allow TTS for this bracket</label></div>)}</div><div className="control-actions"><button className="secondary-button" type="button" onClick={addBracket}>Add higher bracket</button><button className="secondary-button" type="button" onClick={removeFinalBracket} disabled={brackets.length <= 1}>Remove final bracket</button></div></fieldset>

      <fieldset className="config-fieldset"><legend>Text-to-speech</legend><div className="config-grid"><label>Voice ID<input maxLength={80} pattern="[A-Za-z0-9._:-]+" value={tts.voiceId ?? ''} placeholder="Optional provider voice" onChange={(event) => { const voiceId = event.target.value.trim(); if (voiceId) { onChange({...draft, tts: {...tts, voiceId}}); return; } const {voiceId: _removed, ...withoutVoiceId} = tts; onChange({...draft, tts: withoutVoiceId}); }} /></label><label>Language<select value={tts.language ?? draft.locale ?? 'en-IN'} onChange={(event) => onChange({...draft, tts: {...tts, language: event.target.value}})}>{locales.map((locale) => <option key={locale} value={locale}>{locale}</option>)}</select></label><label>Overflow policy<select value={tts.overflowPolicy ?? 'extend'} onChange={(event) => onChange({...draft, tts: {...tts, overflowPolicy: event.target.value as ConfigBracket['ttsOverflowPolicy']}})}>{overflowPolicies.map((policy) => <option key={policy} value={policy}>{label(policy)}</option>)}</select></label><label>Audio padding (ms)<input type="number" min="0" max="10000" value={tts.paddingMs ?? 0} onChange={(event) => onChange({...draft, tts: {...tts, paddingMs: Number(event.target.value)}})} /></label></div><label className="checkbox-label"><input type="checkbox" checked={tts.enabled ?? false} onChange={(event) => onChange({...draft, tts: {...tts, enabled: event.target.checked}})} /> Enable TTS where the selected bracket allows it</label><p className="helper-text">If the provider is slow or unavailable, the visual alert remains independently deliverable and the configured fallback policy applies.</p></fieldset>

      <fieldset className="config-fieldset"><legend>Queue behavior</legend><div className="config-grid"><label>Queue mode<select value={queue.mode ?? 'fifo'} onChange={(event) => onChange({...draft, queue: {...queue, mode: event.target.value as QueueMode}})}><option value="fifo">One by one (FIFO)</option><option value="stacked">Stacked</option><option value="pills">Pills</option><option value="aggregated">Aggregated</option><option value="priority">Priority</option></select></label><label>Visible stack limit<input required type="number" min="1" max="10" value={queue.stackLimit ?? 1} onChange={(event) => onChange({...draft, queue: {...queue, stackLimit: Number(event.target.value)}})} /></label><label>Aggregation window (seconds)<input type="number" min="1" max="300" value={queue.aggregationWindowSeconds ?? 30} onChange={(event) => onChange({...draft, queue: {...queue, aggregationWindowSeconds: Number(event.target.value)}})} /></label><label>Aggregation threshold<input type="number" min="2" max="100" value={queue.aggregationThreshold ?? 5} onChange={(event) => onChange({...draft, queue: {...queue, aggregationThreshold: Number(event.target.value)}})} /></label><label>Rate limit (alerts/minute)<input required type="number" min="1" max="1000" value={queue.rateLimitPerMinute ?? 60} onChange={(event) => onChange({...draft, queue: {...queue, rateLimitPerMinute: Number(event.target.value)}})} /><small>Limits presentation/dispatch policy only; accepted alerts stay durable.</small></label></div><label className="checkbox-label"><input type="checkbox" checked={queue.approvalRequired ?? false} onChange={(event) => onChange({...draft, queue: {...queue, approvalRequired: event.target.checked}})} /> Require operator approval before display</label><div className="quiet-row"><label className="checkbox-label"><input type="checkbox" checked={queue.quietMode?.enabled ?? false} onChange={(event) => onChange({...draft, queue: {...queue, quietMode: {...queue.quietMode, enabled: event.target.checked, timezone: queue.quietMode?.timezone ?? 'Asia/Kolkata'}}})} /> Quiet mode</label><label>Start<input type="time" value={queue.quietMode?.start ?? '23:00'} onChange={(event) => onChange({...draft, queue: {...queue, quietMode: {...queue.quietMode, enabled: true, start: event.target.value, timezone: queue.quietMode?.timezone ?? 'Asia/Kolkata'}}})} /></label><label>End<input type="time" value={queue.quietMode?.end ?? '07:00'} onChange={(event) => onChange({...draft, queue: {...queue, quietMode: {...queue.quietMode, enabled: true, end: event.target.value, timezone: queue.quietMode?.timezone ?? 'Asia/Kolkata'}}})} /></label><label>Timezone<input required maxLength={64} value={queue.quietMode?.timezone ?? 'Asia/Kolkata'} onChange={(event) => onChange({...draft, queue: {...queue, quietMode: {...queue.quietMode, enabled: true, timezone: event.target.value}}})} /></label></div></fieldset>

      <div className="config-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save configuration'}</button><span className="helper-text">Branding, templates and AI controls are separate authority-gated features.</span></div>
    </form>
    <div className="config-preview"><div className="panel-heading"><div><p className="muted-label">Live preview</p><h3>Safe sample alert</h3></div><span className="helper-text">Preview only · not a live event</span></div><div className="config-preview-stage" style={previewPlacement(display.anchor)}><div className="config-preview-alert" data-style={previewStyle} style={{transform: `scale(${previewScale})`, animation: draft.reducedMotion ? 'none' : undefined}}><span>{draft.locale ?? 'en-IN'} · ₹500</span><strong>Sample Viewer supported the stream</strong><p>This sample wraps long text safely and respects the selected display style.</p></div></div></div>
  </section>;
}
