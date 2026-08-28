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
// offset-only token like '-=500' is valid with an implicit base of 0. The base may carry a sign of
// its own, which only matters once an offset follows it: GSAP reads '-50+=100' as 50, since it
// splits at the '=' and runs parseFloat over everything before it. A bare '-50' parses either way,
// as a signed base or as the offset, and to the same number.
const CLAUSE_TOKEN_RE
  = /^(top|center|bottom|[+-]?(?:\d+(?:\.\d*)?|\.\d+))?(%|px)?(?:([+-]=?)(\d+(?:\.\d*)?|\.\d+)(%|px)?)?$/;

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
  // One deliberate divergence, in a token that carries '%' on both the base and the offset
  // ('50%+=10%'). GSAP scales the offset by testing `value.indexOf("%") > eqIndex`, which finds the
  // base's own '%' and stops, leaving the offset a px value: _offsetToPx('50%+=10%', 400) is 210,
  // where this reads 240. Both units are honored here rather than reproducing that.
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

// Takes an already-trimmed whole position value. Every caller has to run this before splitting the
// value into tokens, since after the split there's only the fragment 'clamp(top' left to name.
const assertNotClamped = (trimmed: string) => {
  if (!trimmed.startsWith(CLAMP_PREFIX)) return;

  const inner = trimmed.slice(CLAMP_PREFIX.length).replace(/\)$/, '').trim();

  throw new Error(
    `StickyScrollTrigger: unsupported position clause "${trimmed}": GSAP's clamp() wrapper `
    + 'isn\'t supported here.'
    + (inner ? ` Did you mean "${inner}"?` : ''),
  );
};

// Back-calculates the top position (px) at which the element's anchor point lines up with
// the viewport's anchor point, from a GSAP-standard position clause (e.g. 'center center').
// When only one clause is given, the viewport side defaults to 'top' (matching GSAP).
export const resolveAnchorTop = (
  position: string,
  elementHeight: number,
  viewportHeight: number,
): number => {
  const trimmed = position.trim();

  assertNotClamped(trimmed);

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

// GSAP splits the two '+=' end forms at ScrollTrigger.js:1389. One that also holds a space is a
// position clause in both libraries, but GSAP first prepends the start clause's element token
// (`parsedStart.split(" ")[0] + parsedEnd`), so start: 'bottom bottom' with end: '+=100 bottom'
// resolves as 'bottom+=100 bottom' against endTrigger. Without that prefix, parseClauseToken reads
// the absent base as fraction 0, landing short by the start clause's own fraction of endTrigger's
// height. A non-string start prepends nothing, matching GSAP's own `_isString(parsedStart)` guard.
export const prefixSpacedRelativeEnd = (
  start: PositionInput,
  endResolved: EndValue,
): EndValue => {
  if (typeof endResolved !== 'string') return endResolved;

  const trimmedEnd = endResolved.trim();

  if (!trimmedEnd.startsWith('+=') || !/\s/.test(trimmedEnd)) return endResolved;

  // start is resolved only now, so a function-valued one runs just for the end form that reads it:
  // createResolvedTrigger's start has a callback GSAP already invokes once per refresh.
  const startResolved = resolveMaybeFn(start);

  if (typeof startResolved !== 'string') return endResolved;

  const trimmedStart = startResolved.trim();

  // This check runs before the split below, which would otherwise leave only 'clamp(top' to report.
  // resolveAnchorTop catches a clamp() value on its own, but only after this function has composed
  // the end.
  assertNotClamped(trimmedStart);

  const [elementToken] = trimmedStart.split(/\s+/);

  // Both tokens go through parseClauseToken as written, before anything is glued together.
  // Composing first would make it quote a token the caller never wrote: 'center+=100vh' for a start
  // of 'center center' and an end of '+=100vh bottom'. refSize is irrelevant to whether a token
  // parses, so 0 stands in.
  try {
    parseClauseToken(elementToken, 0);
  } catch (error) {
    // isAbsoluteFormat accepts whatever Number() does, so a start can be a bare number in a
    // spelling CLAUSE_TOKEN_RE has no way to express ('1e3', 'Infinity'). That start is sound
    // everywhere else it's used, so this leaves the end as it stands rather than rejecting it over
    // a prefix the module can't write.
    if (!isAbsoluteFormat(startResolved)) throw error;

    return endResolved;
  }

  parseClauseToken(trimmedEnd.split(/\s+/)[0], 0);

  // The one pair that can't compose. GSAP's _offsetToPx splits a token at its first '=', so a start
  // token already carrying an offset leaves the end's offset in the discarded tail: 'top+=50' with
  // '+=100' resolves to just 50. Unlike the unparseable start above there is no fallback, so this
  // throws, as the module already does for GSAP's other silent-drop forms ('top+50', 'max-100').
  // Those reach GSAP's unguarded refresh loop from a Vars callback the same way this one can.
  // A signed base ('-50+=100') composes cleanly in both libraries, so this leaves it alone, and a
  // '%' base too: it meets a '%' end offset in the one token parseClauseToken reads differently
  // from GSAP (see its note on '50%+=10%'), but that divergence is the token's, not this
  // function's.
  if (elementToken.includes('=')) {
    throw new Error(
      `StickyScrollTrigger: end "${endResolved}" can't be resolved against start `
      + `"${startResolved}": GSAP reads an end that starts with '+=' and holds a space by `
      + `prefixing it with the start clause's element token, and "${elementToken}" carries an `
      + 'offset of its own, which GSAP resolves by discarding the end\'s. Give end a complete '
      + 'position clause instead, such as \'top+=100 bottom\'.',
    );
  }

  return elementToken + trimmedEnd;
};

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

// Which format a resolved start/end value is in. Every start/end in index.ts is classified here
// before anything acts on it, so a call path names the formats it means to answer instead of
// testing the predicates in an order of its own. Where a path answers all four, it switches over
// `kind` and the compiler rejects it for leaving one out; where it rejects or intercepts a single
// format, it tests `kind` for that one alone.
//
// The order below doesn't matter, because the three predicates above are pairwise disjoint. A
// dwell starts with a literal '+=' and 'max' with a literal 'max', so neither is a number that
// Number() can convert, and neither carries the other's prefix. position.test.ts checks that
// across the notations the module accepts.
export type ClassifiedPosition
  = | { kind: 'dwell'; value: string }
    | { kind: 'absolute'; value: number }
    | { kind: 'max'; value: string }
    | { kind: 'clause'; value: string };

// value is the string as given. resolveDwell, resolveMaxOffset and resolveAnchorTop each trim
// before parsing, so there is nothing for this to normalize on their behalf.
export const classifyPosition = (resolved: PositionValue): ClassifiedPosition => {
  if (typeof resolved === 'number') return { kind: 'absolute', value: resolved };

  if (isDwellFormat(resolved)) return { kind: 'dwell', value: resolved };

  if (isMaxFormat(resolved)) return { kind: 'max', value: resolved };

  if (isAbsoluteFormat(resolved)) return { kind: 'absolute', value: resolveAbsolute(resolved) };

  return { kind: 'clause', value: resolved };
};
