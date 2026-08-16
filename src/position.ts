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

// Converts a signed quantity like '+=100' / '-25%' / '-25px' to px. GSAP's own _offsetToPx only
// special-cases '%'; any other (or no) suffix is a literal px value, since parseFloat already
// ignores a trailing 'px' on its own, so unit only needs distinguishing to decide whether to
// scale by refSize.
const signedPx = (
  sign: string | undefined,
  value: string,
  unit: string | undefined,
  refSize: number,
): number => {
  const magnitude = unit === '%' ? (parseFloat(value) / 100) * refSize : parseFloat(value);

  return sign?.startsWith('-') ? -magnitude : magnitude;
};

// Requires at least one digit in the numeric part
// (to reject strings like a lone '.' that would otherwise parse to NaN).
// The base's own unit (group 2) is captured separately from the offset's, since GSAP treats
// a bare number and an explicit percentage differently. An explicit 'px' suffix is accepted too
// (GSAP tolerates it: _offsetToPx's parseFloat silently drops any non-'%' suffix. But plain
// parseFloat would also silently accept genuine typos, so this only recognizes 'px' specifically
// and still rejects anything else, e.g. 'top 100vh').
// The offset sign's '=' is captured but only actually required when a base precedes it; see the
// check just below the match, and its comment, for why.
// The base itself is optional, matching GSAP's _offsetToPx: a token that's only a signed offset
// (e.g. '-=500', with no keyword or number before it) is valid; the base implicitly is 0.
const CLAUSE_TOKEN_RE
  = /^(top|center|bottom|(?:\d+(?:\.\d*)?|\.\d+))?(%|px)?(?:([+-]=?)(\d+(?:\.\d*)?|\.\d+)(%|px)?)?$/;

export const parseClauseToken = (
  token: string,
  refSize: number,
): { fraction: number; offsetPx: number } => {
  const match = CLAUSE_TOKEN_RE.exec(token);

  // An empty token (both the base and the offset group missing) isn't a match GSAP would
  // recognize either: CLAUSE_TOKEN_RE only makes the base optional so a signed-offset-only
  // token like '-=500' is valid, not so that '' passes.
  if (!match || (!match[1] && !match[3])) {
    // 'max' (and its offset forms) is a real GSAP keyword, just scoped to end (see isMaxFormat
    // below). Without this check, a start: 'max' typo gets the generic "unsupported position
    // clause" error and looks like a made-up token instead of a misplaced one.
    if (MAX_TOKEN_RE.test(token)) {
      throw new Error(
        `StickyScrollTrigger: unsupported position clause "${token}": 'max' is GSAP's `
        + `end-only keyword for the scroller's maximum scroll position.`,
      );
    }

    throw new Error(`StickyScrollTrigger: unsupported position clause "${token}"`);
  }

  const [, base, baseUnit, sign, offsetValue, offsetUnit] = match;

  // GSAP's _offsetToPx finds an offset via value.indexOf("="): with a base (keyword or number)
  // preceding the sign, the '=' is what lets it separate the two: 'top+100' (no '=') is tested
  // as one atomic string that's neither a keyword nor a number, so it silently resolves to 0, not
  // "top offset by 100". Without a base, there's nothing to separate: 'parseFloat' alone already
  // handles a leading sign, so '+100%'/'−500' work identically with or without '='. Rather than
  // replicate GSAP's silent 0 for the base+no-'=' case, this rejects it outright. It matches
  // GSAP's arithmetic for well-formed input, and is louder than GSAP for a likely typo.
  if (base !== undefined && sign && !sign.includes('=')) {
    const suggestion = `${base}${baseUnit ?? ''}${sign}=${offsetValue}${offsetUnit ?? ''}`;

    throw new Error(
      `StickyScrollTrigger: unsupported position clause "${token}": a signed offset needs `
      + `an explicit '=' when it follows a keyword or number (GSAP itself requires this too, `
      + `to tell "${base}" and the offset apart). Did you mean "${suggestion}"?`,
    );
  }

  const isKeyword = base !== undefined && base in KEYWORD_FRACTIONS;
  const basePercent = baseUnit === '%';
  // Matches GSAP's own _offsetToPx: only an explicit '%' scales by refSize; a bare number (or one
  // with an explicit 'px') is a literal px offset instead. A missing base (offset-only token)
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

// GSAP's own _parsePosition treats an entire position value as an absolute scroll position
// whenever it coerces cleanly to a finite number via unary '+' (`isNaN(value) || (value =
// +value)` at ScrollTrigger.js:750). A plain number already qualifies, and so does a string
// containing nothing but a number (no keyword, no second token, no '%'/'px' suffix). Something
// like '500 top' (two tokens) or '500px' (an extra suffix) doesn't coerce cleanly, so GSAP
// resolves those as a position clause via _offsetToPx instead, the same outcome parseClauseToken
// already gives them, so this only needs to special-case the single-bare-number form.
// An empty string technically coerces to 0 in GSAP too, but this module deliberately doesn't
// replicate that: it's always a caller mistake, and parseClauseToken's existing "empty token"
// error is a more useful outcome than a silent absolute-0.
export const isAbsoluteFormat = (resolved: PositionValue): boolean => {
  if (typeof resolved === 'number') return true;

  return resolved.trim() !== '' && !Number.isNaN(Number(resolved));
};

// Converts an already-resolved absolute-format value into its absolute scroll position (px).
export const resolveAbsolute = (resolved: PositionValue): number =>
  (typeof resolved === 'number' ? resolved : Number(resolved));

// Back-calculates the top position (px) at which the element's anchor point lines up with
// the viewport's anchor point, from a GSAP-standard position clause (e.g. 'center center').
// When only one clause is given, the viewport side defaults to 'top' (matching GSAP).
export const resolveAnchorTop = (
  position: string,
  elementHeight: number,
  viewportHeight: number,
): number => {
  const [elementToken, viewportToken = 'top'] = position.trim().split(/\s+/);
  const elementClause = parseClauseToken(elementToken, elementHeight);
  const viewportClause = parseClauseToken(viewportToken, viewportHeight);

  return (
    viewportHeight * viewportClause.fraction
    + viewportClause.offsetPx
    - (elementHeight * elementClause.fraction + elementClause.offsetPx)
  );
};

// GSAP itself only treats a string as relative-to-start when it starts with the literal '+='
// prefix (`if (_isString(parsedEnd) && !parsedEnd.indexOf("+="))` in ScrollTrigger.js). Anything
// else, including '-=500' or '+100%', is a position clause resolved against endTrigger instead.
// A bare number (or a numeric string with no sign/percent) is *not* dwell notation; it matches
// GSAP's own "bare number = absolute scroll position" (isAbsoluteFormat/resolveAbsolute below
// handle that case for end too).
// An explicit 'px' suffix is accepted here too, for the same reason as CLAUSE_TOKEN_RE above.
const DWELL_RELATIVE_RE = /^\+=(\d+(?:\.\d*)?|\.\d+)(%|px)?$/;

export const isDwellFormat = (resolved: EndValue): boolean =>
  typeof resolved === 'string' && DWELL_RELATIVE_RE.test(resolved.trim());

// Converts an already-resolved end value (any function has already been called) into a dwell
// distance (px). Only called once isDwellFormat has confirmed the '+=' notation, so resolved is
// always a string at runtime.
export const resolveDwell = (resolved: EndValue, viewportHeight: number): number => {
  const match = DWELL_RELATIVE_RE.exec(String(resolved).trim());

  if (!match) {
    throw new Error(`StickyScrollTrigger: unsupported end format "${resolved}"`);
  }

  const [, value, unit] = match;

  return signedPx(undefined, value, unit, viewportHeight);
};

// The offset's sign requires '=' too: GSAP's own _parsePosition checks
// `value.charAt(4) === "="` specifically before treating anything past 'max' as an offset at all
// (`ScrollTrigger.js:742`). 'max-100' (no '=') isn't 'max' offset by -100 in real GSAP; it
// silently falls back to bare 'max' with the "-100" discarded entirely. Rather than replicate
// that silent discard, this module doesn't recognize 'max-100' as max format at all, so it throws
// instead (same "louder than GSAP for an ambiguous input" choice as CLAUSE_TOKEN_RE above).
const MAX_TOKEN_RE = /^max(?:([+-]=)(\d+(?:\.\d*)?|\.\d+)(%|px)?)?$/;

// Whether end is in 'max' notation ('max' / 'max-=100' / 'max+=10%'): the scroller's maximum
// scroll position, optionally offset. GSAP defines this for `end` only, not `start`: in raw GSAP
// 3.15.0, `start: 'max'` silently resolves to 0 instead of the scroller's max, so this module
// rejects it for `start` rather than reproducing that.
export const isMaxFormat = (resolved: EndValue): boolean =>
  typeof resolved === 'string' && MAX_TOKEN_RE.test(resolved.trim());

// Converts an already-resolved 'max' end value into its offset (px) from the scroller's maximum
// scroll position (0 for a bare 'max'). refSize mirrors GSAP's own scrollerSize (viewport height).
// Only the bare form matches GSAP's own end: 'max'. Raw GSAP 3.15.0's offset forms
// ('max-=100', 'max+=10%') don't work as documented: they silently drop both the offset and the
// 'max' itself, collapsing end to start's position. This module doesn't replicate that.
export const resolveMaxOffset = (resolved: string, viewportHeight: number): number => {
  const match = MAX_TOKEN_RE.exec(resolved.trim());

  if (!match) {
    throw new Error(`StickyScrollTrigger: unsupported max-position format "${resolved}"`);
  }

  const [, sign, value, unit] = match;

  return sign ? signedPx(sign, value, unit, viewportHeight) : 0;
};
