/**
 * ScrollTrigger.Vars keys this module decides for itself. Single source of truth for both
 * PassThroughVars' type-level Omit (types.ts) and the runtime check that rejects a plain
 * JS/JSON caller handing them through anyway (index.ts's #assertNoExcludedVars).
 */

// Why excluded: (1) trigger/start/end/endTrigger: this module derives these itself;
// (2) the pin family: meaningless since sticky handles pinning;
// (3) horizontal/scroller/containerAnimation: this module assumes vertical, window scrolling,
// so passing them would silently throw things off.
export const EXCLUDED_VAR_KEYS = [
  'trigger',
  'start',
  'end',
  'endTrigger',
  'pin',
  'pinSpacing',
  'anticipatePin',
  'pinnedContainer',
  'pinReparent',
  'pinSpacer',
  'pinType',
  'horizontal',
  'scroller',
  'containerAnimation',
] as const;
