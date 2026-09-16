/*
 * PRF-02 / owner ruling 2026-09-16 (active/tasks/PRF-02.md): Indic script
 * fallback order (§15.4.3, customisation level 1) is OUT of this slice —
 * it is a per-creator customisation knob and this slice is the runtime,
 * not the customisation model. But two constraints bind the two modules
 * this slice ships:
 *
 *   1. Rendering must not hard-code a single font family in a way that
 *      forecloses a later per-text-role fallback stack. Every module here
 *      reads its font from THIS file's data shape rather than inlining a
 *      family name in a CSS string.
 *   2. Indic fallback must already work today, even with no customisation
 *      UI — supporter names and goal titles in this market are routinely
 *      Indic script, and a ticker rendering a real name as tofu is a
 *      broken product, not a missing feature. So the one first-party
 *      default below already carries Noto Sans coverage for the major
 *      Indic scripts, not just a Latin family.
 *
 * A later slice that exposes §15.4.3 level-1 typography controls replaces
 * `defaultCanvasTextStyles()`'s single shared value with a per-role,
 * per-creator one — the CanvasTextStyle/role shape already supports that;
 * only the source of the value changes.
 */

export type CanvasTextRole = 'name' | 'title' | 'amount' | 'label';

export interface CanvasTextStyle {
  fontFamily: string;
}

const DEFAULT_FONT_STACK = [
  'system-ui', '-apple-system',
  "'Noto Sans'", "'Noto Sans Devanagari'", "'Noto Sans Bengali'", "'Noto Sans Gujarati'",
  "'Noto Sans Gurmukhi'", "'Noto Sans Kannada'", "'Noto Sans Malayalam'", "'Noto Sans Oriya'",
  "'Noto Sans Tamil'", "'Noto Sans Telugu'",
  'sans-serif',
].join(', ');

export function defaultCanvasTextStyles(): Record<CanvasTextRole, CanvasTextStyle> {
  return {
    name: { fontFamily: DEFAULT_FONT_STACK },
    title: { fontFamily: DEFAULT_FONT_STACK },
    amount: { fontFamily: DEFAULT_FONT_STACK },
    label: { fontFamily: DEFAULT_FONT_STACK },
  };
}
