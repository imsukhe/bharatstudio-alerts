'use client';

/*
 * The catalogue picker for JOB 1: lets an operator assign one of the 17
 * Companion actions to a free slot in the channel's action layout.
 *
 * Two-layer gate, rendered as two visually distinct states (this is the
 * whole point of the L24 design — see apps/api/src/routes/companion.ts's
 * header comment):
 *   - LOCKED (entitlement): the channel's plan does not include this
 *     action's group at all. Shown dimmed, with the reason, and no way to
 *     add it — this is a plan limitation, not a live-connection problem.
 *   - INACTIVE (activation): the action IS on the plan, but its target
 *     isn't live right now. Still selectable — you may want to pre-wire a
 *     slot before turning on the overlay/OBS/mirror/stream connection.
 * Today only the 'alerts' group has a real activation signal
 * (CompanionState.overlayConnected) — see companion.ts's header comment on
 * why 'obs'/'mirror'/'stream' have no live signal at this layer yet. Those
 * three groups render as available (entitlement-only) rather than
 * fabricating a false "not live" reading; this is called out explicitly so
 * it never gets read as "these are always live."
 */
import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Field } from '../components/ui/Field';
import type { ActionTargetKind, CatalogueEntry, CompanionActionGroup } from './action-catalogue';
import { ACTION_CATALOGUE, GROUP_LABELS, GROUP_ORDER, buildTargetLabel } from './action-catalogue';
import type { Queue } from '../lib/api';

type GateState = 'locked' | 'inactive' | 'available';

function gateStateFor(entry: CatalogueEntry, entitledGroups: Set<CompanionActionGroup>, overlayConnected: boolean): GateState {
  if (!entitledGroups.has(entry.group)) return 'locked';
  if (entry.group === 'alerts' && !overlayConnected) return 'inactive';
  return 'available';
}

function lockedReason(entry: CatalogueEntry): string {
  return `Not available on this channel's current plan (${GROUP_LABELS[entry.group]} actions are not entitled).`;
}

function inactiveReason(): string {
  return 'Not currently live: the Alerts overlay is not connected. The slot can still be configured now.';
}

export function CompanionActionPicker({
  maxSlots,
  takenSlotCount,
  entitledGroups,
  overlayConnected,
  activeQueues,
  canOperate,
  busy,
  onAssign,
}: {
  maxSlots: number;
  takenSlotCount: number;
  entitledGroups: Set<CompanionActionGroup>;
  overlayConnected: boolean;
  activeQueues: Queue[];
  canOperate: boolean;
  busy: boolean;
  onAssign: (entry: CatalogueEntry, targetId: string, targetLabel: string | undefined, label: string) => void;
}) {
  const [openAction, setOpenAction] = useState<string | null>(null);
  const [queueId, setQueueId] = useState<string>('');
  const [text, setText] = useState('');
  const [sceneItemId, setSceneItemId] = useState('');

  const full = takenSlotCount >= maxSlots;

  function resetDraft() {
    setOpenAction(null);
    setQueueId('');
    setText('');
    setSceneItemId('');
  }

  function targetIsReady(entry: CatalogueEntry): { targetId: string; targetLabel: string | undefined } | null {
    if (entry.target === 'queue') {
      const queue = activeQueues.find((candidate) => candidate.queueId === queueId);
      return queue ? { targetId: queue.queueId, targetLabel: undefined } : null;
    }
    if (entry.target === 'none') {
      return globalThis.crypto?.randomUUID ? { targetId: globalThis.crypto.randomUUID(), targetLabel: undefined } : null;
    }
    const targetLabel = buildTargetLabel(entry.target, { text, sceneItemId });
    if (targetLabel === null || !globalThis.crypto?.randomUUID) return null;
    return { targetId: globalThis.crypto.randomUUID(), targetLabel };
  }

  function targetFieldsFor(entry: CatalogueEntry) {
    switch (entry.target) {
      case 'queue':
        return (
          <Field label="Target queue">
            <select value={queueId} onChange={(event) => setQueueId(event.target.value)} disabled={activeQueues.length === 0}>
              <option value="">Choose a queue…</option>
              {activeQueues.map((queue) => <option key={queue.queueId} value={queue.queueId}>{queue.name}</option>)}
            </select>
          </Field>
        );
      case 'sceneName':
        return <Field label="Scene name"><input value={text} onChange={(event) => setText(event.target.value)} maxLength={200} placeholder="e.g. Starting Soon" /></Field>;
      case 'inputName':
        return <Field label="Audio input name"><input value={text} onChange={(event) => setText(event.target.value)} maxLength={200} placeholder="e.g. Mic/Aux" /></Field>;
      case 'transitionName':
        return <Field label="Transition name"><input value={text} onChange={(event) => setText(event.target.value)} maxLength={200} placeholder="e.g. Fade" /></Field>;
      case 'sceneAndItem':
        return (
          <>
            <Field label="Scene name"><input value={text} onChange={(event) => setText(event.target.value)} maxLength={200} placeholder="e.g. Main Scene" /></Field>
            <Field label="Scene item ID (numeric)"><input value={sceneItemId} onChange={(event) => setSceneItemId(event.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="e.g. 12" /></Field>
          </>
        );
      case 'none':
        return <p className="helper-text">This action needs no target — it runs immediately when triggered.</p>;
    }
  }

  return (
    <Card title="Add an action to a slot" eyebrow="Action catalogue" helper={full ? 'This tier has no free slots left. Remove a slot before adding another.' : 'Locked actions are not on this plan. Inactive actions are on the plan but not live right now — both can be told apart below.'}>
      {GROUP_ORDER.map((group) => (
        <div className="companion-catalogue-group" key={group}>
          <h3>{GROUP_LABELS[group]}</h3>
          <div className="queue-list">
            {ACTION_CATALOGUE.filter((entry) => entry.group === group).map((entry) => {
              const gate = gateStateFor(entry, entitledGroups, overlayConnected);
              const isOpen = openAction === entry.action;
              const ready = isOpen ? targetIsReady(entry) : null;
              return (
                <div className="queue-row companion-catalogue-row" key={entry.action} data-gate={gate}>
                  <div>
                    <strong>{entry.label}</strong>
                    <small>{entry.description}</small>
                    {gate === 'locked' && <p className="helper-text error-text">{lockedReason(entry)}</p>}
                    {gate === 'inactive' && <p className="helper-text">{inactiveReason()}</p>}
                  </div>
                  {canOperate && gate !== 'locked' && (
                    isOpen ? (
                      <div className="companion-catalogue-draft">
                        {targetFieldsFor(entry)}
                        <div className="control-actions">
                          <Button type="button" variant="primary" disabled={busy || !ready} onClick={() => {
                            if (!ready) return;
                            onAssign(entry, ready.targetId, ready.targetLabel, entry.label);
                            resetDraft();
                          }}>Add to layout</Button>
                          <Button type="button" onClick={resetDraft}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <Button type="button" disabled={busy || full} onClick={() => { resetDraft(); setOpenAction(entry.action); }}>Add</Button>
                    )
                  )}
                  {gate === 'locked' && <span className="helper-text">Unavailable</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Card>
  );
}

export type { ActionTargetKind };
