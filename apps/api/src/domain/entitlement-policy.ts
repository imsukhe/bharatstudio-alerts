type QueueMode = 'fifo' | 'stacked' | 'pills' | 'aggregated' | 'priority';

export type EntitlementPolicy = {
  allowedQueueModes?: QueueMode[];
  maxVisibleItems?: number;
  maxCharLimit?: number;
  maxDisplayMs?: number;
  ttsEnabled?: boolean;
  quietMode?: boolean;
  approvalRequired?: boolean;
};

export type EntitlementIssue = { code: string; message: string; path: string };

function policyFromValues(values: Record<string, unknown>): EntitlementPolicy {
  const raw = values.configFeatures;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as EntitlementPolicy : {};
}

export function validateConfigEntitlement(config: Record<string, unknown>, entitlementValues: Record<string, unknown>): EntitlementIssue[] {
  const policy = policyFromValues(entitlementValues);
  const issues: EntitlementIssue[] = [];
  const queue = config.queue && typeof config.queue === 'object' && !Array.isArray(config.queue) ? config.queue as Record<string, unknown> : {};
  const mode = queue.mode;
  if (Array.isArray(policy.allowedQueueModes) && typeof mode === 'string' && !policy.allowedQueueModes.includes(mode as QueueMode)) {
    issues.push({ code: 'ERR_ENTITLEMENT_QUEUE_MODE', message: 'This queue presentation mode is not available on the channel plan.', path: '/queue/mode' });
  }
  const maxVisibleItems = policy.maxVisibleItems;
  if (typeof maxVisibleItems === 'number' && typeof config.display === 'object' && config.display && !Array.isArray(config.display)) {
    const value = (config.display as Record<string, unknown>).maxVisibleItems;
    if (typeof value === 'number' && value > maxVisibleItems) issues.push({ code: 'ERR_ENTITLEMENT_VISIBLE_ITEMS', message: 'The visible alert count exceeds the channel plan.', path: '/display/maxVisibleItems' });
  }
  if (typeof policy.maxCharLimit === 'number' && Array.isArray(config.brackets)) {
    config.brackets.forEach((bracket, index) => {
      if (bracket && typeof bracket === 'object' && !Array.isArray(bracket) && typeof (bracket as Record<string, unknown>).charLimit === 'number' && ((bracket as Record<string, unknown>).charLimit as number) > policy.maxCharLimit!) {
        issues.push({ code: 'ERR_ENTITLEMENT_CHAR_LIMIT', message: 'A message limit exceeds the channel plan.', path: `/brackets/${index}/charLimit` });
      }
    });
  }
  const tts = config.tts && typeof config.tts === 'object' && !Array.isArray(config.tts) ? config.tts as Record<string, unknown> : {};
  if (policy.ttsEnabled === false && tts.enabled === true) issues.push({ code: 'ERR_ENTITLEMENT_TTS', message: 'TTS is not available on the channel plan.', path: '/tts/enabled' });
  if (policy.quietMode === false && (queue.quietMode as Record<string, unknown> | undefined)?.enabled === true) issues.push({ code: 'ERR_ENTITLEMENT_QUIET_MODE', message: 'Quiet mode is not available on the channel plan.', path: '/queue/quietMode' });
  if (policy.approvalRequired === false && queue.approvalRequired === true) issues.push({ code: 'ERR_ENTITLEMENT_APPROVAL', message: 'Approval mode is not available on the channel plan.', path: '/queue/approvalRequired' });
  if (typeof policy.maxDisplayMs === 'number' && Array.isArray(config.brackets)) {
    config.brackets.forEach((bracket, index) => {
      if (bracket && typeof bracket === 'object' && !Array.isArray(bracket) && typeof (bracket as Record<string, unknown>).displayMinMs === 'number' && ((bracket as Record<string, unknown>).displayMinMs as number) > policy.maxDisplayMs!) {
        issues.push({ code: 'ERR_ENTITLEMENT_DISPLAY_TIME', message: 'A display duration exceeds the channel plan.', path: `/brackets/${index}/displayMinMs` });
      }
    });
  }
  return issues;
}
