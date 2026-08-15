export const channelConfigSchema = {
  $id: 'https://contracts.bharatstudio.invalid/v1/channel-config.schema.json',
  type: 'object',
  additionalProperties: false,
  maxProperties: 128,
  properties: {
    minimumTipPaise: { type: 'integer', minimum: 1000, maximum: 1_000_000_000 },
    defaultDisplaySeconds: { type: 'integer', minimum: 4, maximum: 60 },
    defaultStyle: { type: 'string', enum: ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'] },
    locale: { type: 'string', enum: ['en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN', 'or-IN', 'as-IN', 'ur-IN'] },
    reducedMotion: { type: 'boolean' },
    brackets: {
      type: 'array', minItems: 1, maxItems: 32,
      items: {
        type: 'object', additionalProperties: false,
        required: ['amountMinPaise', 'amountMaxPaise', 'charLimit', 'ttsEligible', 'displayStyle', 'displayMinMs', 'ttsOverflowPolicy'],
        properties: {
          amountMinPaise: { type: 'integer', minimum: 1000, maximum: 1_000_000_000 },
          amountMaxPaise: { type: ['integer', 'null'], minimum: 1000, maximum: 1_000_000_000 },
          charLimit: { type: 'integer', minimum: 10, maximum: 500 },
          ttsEligible: { type: 'boolean' },
          displayStyle: { type: 'string', enum: ['small_pill', 'compact_card', 'standard_card', 'large_card', 'banner', 'celebration'] },
          displayMinMs: { type: 'integer', minimum: 4_000, maximum: 60_000 },
          ttsOverflowPolicy: { type: 'string', enum: ['extend', 'truncate_speech', 'truncate_visual', 'visual_only', 'disable'] },
        },
      },
    },
    tts: {
      type: 'object', additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        voiceId: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9._:-]+$' },
        language: { type: 'string', enum: ['en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'pa-IN', 'or-IN', 'as-IN', 'ur-IN'] },
        overflowPolicy: { type: 'string', enum: ['extend', 'truncate_speech', 'truncate_visual', 'visual_only', 'disable'] },
        paddingMs: { type: 'integer', minimum: 0, maximum: 10_000 },
      },
    },
    display: {
      type: 'object', additionalProperties: false,
      properties: {
        anchor: { type: 'string', enum: ['top_left', 'top_center', 'top_right', 'center_left', 'center', 'center_right', 'bottom_left', 'bottom_center', 'bottom_right'] },
        offsetX: { type: 'integer', minimum: -10_000, maximum: 10_000 },
        offsetY: { type: 'integer', minimum: -10_000, maximum: 10_000 },
        scale: { type: 'number', minimum: 0.5, maximum: 2 },
        widthPercent: { type: 'integer', minimum: 10, maximum: 100 },
        maxVisibleItems: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
    queue: {
      type: 'object', additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['fifo', 'stacked', 'pills', 'aggregated', 'priority'] },
        stackLimit: { type: 'integer', minimum: 1, maximum: 10 },
        aggregationWindowSeconds: { type: 'integer', minimum: 1, maximum: 300 },
        aggregationThreshold: { type: 'integer', minimum: 2, maximum: 100 },
        rateLimitPerMinute: { type: 'integer', minimum: 1, maximum: 1_000 },
        approvalRequired: { type: 'boolean' },
        quietMode: {
          type: 'object', additionalProperties: false, required: ['enabled', 'timezone'],
          properties: {
            enabled: { type: 'boolean' },
            start: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' },
            end: { type: 'string', pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' },
            timezone: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_./+-]+$' },
          },
        },
      },
    },
  },
} as const;

// Fastify embeds this object under the request body's `values` property. Keep
// the external `$id` only for the registry/contract and omit it from the
// embedded node so AJV applies additionalProperties and nested definitions at
// the actual request boundary.
const { $id: _channelConfigSchemaId, ...channelConfigValueSchema } = channelConfigSchema;
export { channelConfigValueSchema };

type ConfigObject = Record<string, unknown>;
export type ConfigValidationIssue = { code: string; message: string; path: string };

export function validateChannelConfigSemantics(values: ConfigObject): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const minimumTipPaise = typeof values.minimumTipPaise === 'number' ? values.minimumTipPaise : 1_000;
  const brackets = Array.isArray(values.brackets) ? values.brackets as ConfigObject[] : undefined;

  if (minimumTipPaise < 1_000) {
    issues.push({ code: 'ERR_MIN_BELOW_PLATFORM', message: 'The minimum tip cannot be below ₹10.', path: '/minimumTipPaise' });
  }

  if (brackets) {
    if (brackets.length === 0) {
      issues.push({ code: 'ERR_BRACKETS_NO_FINAL', message: 'At least one amount bracket is required when brackets are configured.', path: '/brackets' });
    } else {
      const first = brackets[0];
      if (typeof first?.amountMinPaise === 'number' && first.amountMinPaise !== minimumTipPaise) {
        issues.push({ code: 'ERR_BRACKETS_GAP', message: 'The first bracket must begin at the configured minimum tip.', path: '/brackets/0/amountMinPaise' });
      }
      for (let index = 0; index < brackets.length; index += 1) {
        const current = brackets[index];
        const next = brackets[index + 1];
        if (!current) continue;
        if (current.amountMaxPaise === null && next) {
          issues.push({ code: 'ERR_BRACKETS_OVERLAP', message: 'An open-ended bracket must be the final bracket.', path: `/brackets/${index}/amountMaxPaise` });
        }
        if (typeof current.amountMinPaise === 'number' && typeof current.amountMaxPaise === 'number' && current.amountMaxPaise < current.amountMinPaise) {
          issues.push({ code: 'ERR_BRACKETS_OVERLAP', message: 'A bracket maximum cannot be below its minimum.', path: `/brackets/${index}` });
        }
        if (next && typeof current.amountMaxPaise === 'number' && typeof next.amountMinPaise === 'number' && next.amountMinPaise !== current.amountMaxPaise + 1) {
          issues.push({ code: next.amountMinPaise <= current.amountMaxPaise ? 'ERR_BRACKETS_OVERLAP' : 'ERR_BRACKETS_GAP', message: 'Amount brackets must be contiguous and non-overlapping.', path: `/brackets/${index + 1}/amountMinPaise` });
        }
        if (!next && current.amountMaxPaise !== null) {
          issues.push({ code: 'ERR_BRACKETS_NO_FINAL', message: 'The final amount bracket must be open-ended.', path: `/brackets/${index}/amountMaxPaise` });
        }
      }
    }
  }

  const queue = values.queue as ConfigObject | undefined;
  if (queue?.mode === 'stacked' && queue.stackLimit === undefined) {
    issues.push({ code: 'ERR_STACK_SIZE_INVALID', message: 'Stacked mode requires a stack limit.', path: '/queue/stackLimit' });
  }
  if (queue && typeof queue.stackLimit === 'number' && (queue.stackLimit < 1 || queue.stackLimit > 10)) {
    issues.push({ code: 'ERR_STACK_SIZE_INVALID', message: 'The visible stack must contain between 1 and 10 alerts.', path: '/queue/stackLimit' });
  }
  return issues;
}
