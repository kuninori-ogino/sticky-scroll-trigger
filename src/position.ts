/**
 * Pure functions that parse GSAP's standard position clauses and the dwell-distance notation.
 * These don't depend on the DOM, so they can be verified in plain Node unit tests.
 */

export type PositionValue = string | number;
export type PositionInput = PositionValue | (() => PositionValue);
export type EndValue = string | number;
export type EndInput = EndValue | (() => EndValue);

// Always resolves a value-or-function-returning-a-value down to a plain value
// (re-evaluated on every refresh()).
export const resolveMaybeFn = <T>(value: T | (() => T)): T =>
  typeof value === 'function' ? (value as () => T)() : value;

const KEYWORD_FRACTIONS: Record<string, number> = { top: 0, center: 0.5, bottom: 1 };

// Converts a signed quantity ('+=100', '-25%', '-25px') to px. Matching GSAP's own _offsetToPx,
// only '%' scales by refSize; any other suffix is a literal px value.
const signedPx = (
  sign: string | undefined,
  value: string,
  unit: string | undefined,
  refSize: number,
): number => {
  const magnitude = unit === '%' ? (parseFloat(value) / 100) * refSize : parseFloat(value);

  return sign?.startsWith('-') ? -magnitude : magnitude;
};

// At least one digit is required in each numeric part, so a lone '.' is rejected rather than
// parsed as NaN. The base's unit (group 2) is captured separately from the offset's, since a bare
// number and an explicit percentage mean different things to GSAP. 'px' is accepted because
// GSAP's parseFloat silently drops it, but it's the only suffix accepted: anything else ('top
// 100vh') is a typo worth rejecting. The base is optional, matching GSAP's _offsetToPx, so an
// offset-only token like '-=500' is valid with an implicit base of 0.
const CLAUSE_TOKEN_RE
  = /^(top|center|bottom|(?:\d+(?:\.\d*)?|\.\d+))?(%|px)?(?:([+-]=?)(\d+(?:\.\d*)?|\.\d+)(%|px)?)?$/;

export const parseClauseToken = (
  token: string,
  refSize: number,
): { fraction: number; offsetPx: number } => {
  const match = CLAUSE_TOKEN_RE.exec(token);

  // An empty token (base and offset both missing) is rejected: the base is optional only so that
  // '-=500' passes, not ''.
  if (!match || (!match[1] && !match[3])) {
    // 'max' is a real GSAP keyword, just scoped to end (see isMaxFormat below), so a start: 'max'
    // typo is worth naming as misplaced rather than made up.
    if (MAX_TOKEN_RE.test(token)) {
      throw new Error(
        `StickyScrollTrigger: unsupported position clause "${token}": 'max' is GSAP's `
        + `end-only keyword for the scroller's maximum scroll position.`,
      );
    }

    throw new Error(`StickyScrollTrigger: unsupported position clause "${token}"`);
  }

  const [, base, baseUnit, sign, offsetValue, offsetUnit] = match;

  // GSAP's _offsetToPx splits a token at '=', so with a base in front, the '=' is what separates
  // the two: 'top+100' is neither a keyword nor a number as one atomic string, and silently
  // resolves to 0. Without a base there's nothing to separate, so '+100%' works with or without
  // it. This rejects the silent-0 case outright rather than replicating it.
  if (base !== undefined && sign && !sign.includes('=')) {
    const suggestion = `${base}${baseUnit ?? ''}${sign}=${offsetValue}${offsetUnit ?? ''}`;

    throw new Error(
      `StickyScrollTrigger: unsupported position clause "${token}": a signed offset needs `
      + `an explicit '=' when it follows a keyword or number (GSAP needs it to tell "${base}" `
      + `from the offset). Did you mean "${suggestion}"?`,
    );
  }

  const isKeyword = base !== undefined && base in KEYWORD_FRACTIONS;
  const basePercent = baseUnit === '%';
  // A bare number (or one suffixed 'px') is a literal px offset, not a fraction; a missing base
  // contributes neither.
  const fraction = isKeyword
    ? KEYWORD_FRACTIONS[base]
    : basePercent ? parseFloat(base) / 100 : 0;
  const baseOffsetPx = !isKeyword && !basePercent && base !== undefined ? parseFloat(base) : 0;

  return {
    fraction,
    offsetPx: baseOffsetPx + (sign ? signedPx(sign, offsetValue, offsetUnit, refSize) : 0),
  };
};

// GSAP's own _parsePosition treats a whole position value as an absolute scroll position whenever
// isNaN(value) is false (`isNaN(value) || (value = +value)` at ScrollTrigger.js:750). This mirrors
// that condition as-is, including its acceptance of 'Infinity': a value GSAP itself treats as
// absolute shouldn't be rejected here. Only the single-bare-number form needs the special case,
// since '500 top' and '500px' don't coerce cleanly and reach parseClauseToken in both libraries.
// The one deliberate deviation is the empty string, which GSAP coerces to 0: parseClauseToken's
// "empty token" error is more useful to the caller than a silent absolute-0.
export const isAbsoluteFormat = (resolved: PositionValue): boolean => {
  if (typeof resolved === 'number') return true;

  return resolved.trim() !== '' && !Number.isNaN(Number(resolved));
};

// Converts an already-resolved absolute-format value into its absolute scroll position (px).
export const resolveAbsolute = (resolved: PositionValue): number =>
  (typeof resolved === 'number' ? resolved : Number(resolved));

// GSAP's clamp() wrapper, matched the same way GSAP's own _parseClamp does (a 'clamp(' prefix).
// Caught on the whole value rather than per token, since the split below would otherwise report
// the meaningless fragment 'clamp(top'.
const CLAMP_PREFIX = 'clamp(';

// Back-calculates the top position (px) at which the element's anchor point lines up with
// the viewport's anchor point, from a GSAP-standard position clause (e.g. 'center center').
// When only one clause is given, the viewport side defaults to 'top' (matching GSAP).
export const resolveAnchorTop = (
  position: string,
  elementHeight: number,
  viewportHeight: number,
): number => {
  const trimmed = position.trim();

  if (trimmed.startsWith(CLAMP_PREFIX)) {
    const inner = trimmed.slice(CLAMP_PREFIX.length).replace(/\)$/, '').trim();

    throw new Error(
      `StickyScrollTrigger: unsupported position clause "${trimmed}": GSAP's clamp() wrapper `
      + 'isn\'t supported here.'
      + (inner ? ` Did you mean "${inner}"?` : ''),
    );
  }

  const [elementToken, viewportToken = 'top'] = trimmed.split(/\s+/);
  const elementClause = parseClauseToken(elementToken, elementHeight);
  const viewportClause = parseClauseToken(viewportToken, viewportHeight);

  return (
    viewportHeight * viewportClause.fraction
    + viewportClause.offsetPx
    - (elementHeight * elementClause.fraction + elementClause.offsetPx)
  );
};

// GSAP treats a string as relative-to-start only when it begins with the literal '+=' prefix
// (`_isString(parsedEnd) && !parsedEnd.indexOf("+=")` in ScrollTrigger.js). Everything else is a
// position clause resolved against endTrigger, including '-=500' and '+100%'; a bare number stays
// an absolute scroll position (isAbsoluteFormat above). 'px' is accepted for the same reason as
// CLAUSE_TOKEN_RE.
const DWELL_RELATIVE_RE = /^\+=(\d+(?:\.\d*)?|\.\d+)(%|px)?$/;

export const isDwellFormat = (resolved: EndValue): boolean =>
  typeof resolved === 'string' && DWELL_RELATIVE_RE.test(resolved.trim());

// Converts an already-resolved end value into a dwell distance (px). Only reached once
// isDwellFormat has confirmed the '+=' notation, so resolved is always a string at runtime.
export const resolveDwell = (resolved: EndValue, viewportHeight: number): number => {
  const match = DWELL_RELATIVE_RE.exec(String(resolved).trim());

  if (!match) {
    throw new Error(`StickyScrollTrigger: unsupported end format "${resolved}"`);
  }

  const [, value, unit] = match;

  return signedPx(undefined, value, unit, viewportHeight);
};

// The offset's sign requires '=' here too: GSAP's _parsePosition checks `value.charAt(4) === "="`
// (ScrollTrigger.js:742) before reading anything past 'max' as an offset, so 'max-100' silently
// falls back to bare 'max' with the offset discarded. This doesn't recognize that form at all and
// throws instead, the same choice as CLAUSE_TOKEN_RE above.
const MAX_TOKEN_RE = /^max(?:([+-]=)(\d+(?:\.\d*)?|\.\d+)(%|px)?)?$/;

// Whether end is in 'max' notation ('max' / 'max-=100' / 'max+=10%'): the scroller's maximum
// scroll position, optionally offset. GSAP defines this for `end` only. In raw GSAP 3.15.0,
// `start: 'max'` silently resolves to 0, which this module rejects rather than reproduces.
export const isMaxFormat = (resolved: EndValue): boolean =>
  typeof resolved === 'string' && MAX_TOKEN_RE.test(resolved.trim());

// Converts an already-resolved 'max' end into its offset (px) from the scroller's maximum scroll
// position (0 for a bare 'max'), scaling '%' against the viewport height as GSAP's own scrollerSize
// does. Only the bare form matches real GSAP: 3.15.0's documented offset forms silently drop both
// the offset and the 'max', collapsing end onto start, which this module doesn't replicate.
export const resolveMaxOffset = (resolved: string, viewportHeight: number): number => {
  const match = MAX_TOKEN_RE.exec(resolved.trim());

  if (!match) {
    throw new Error(`StickyScrollTrigger: unsupported max-position format "${resolved}"`);
  }

  const [, sign, value, unit] = match;

  return sign ? signedPx(sign, value, unit, viewportHeight) : 0;
};
