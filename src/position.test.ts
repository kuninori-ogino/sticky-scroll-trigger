import { describe, expect, it } from 'vitest';
import {
  isAbsoluteFormat,
  isDwellFormat,
  isMaxFormat,
  parseClauseToken,
  resolveAbsolute,
  resolveAnchorTop,
  resolveDwell,
  resolveMaxOffset,
  resolveMaybeFn,
} from './position';

// position.ts is nothing but pure functions that never touch the DOM,
// so it can run as-is in a Node environment with no layout.
// Verifying actual pinned positions and freeze windows is e2e's job
// (e2e/StickyScrollTrigger.spec.ts).

describe('resolveMaybeFn', () => {
  it('returns a non-function value as-is', () => {
    expect(resolveMaybeFn('top top')).toBe('top top');
    expect(resolveMaybeFn(500)).toBe(500);
  });

  it('returns the result of calling a function value (so variable values like header height stay current on every refresh())', () => {
    expect(resolveMaybeFn(() => 'center center')).toBe('center center');
    expect(resolveMaybeFn(() => 500)).toBe(500);
  });
});

describe('parseClauseToken', () => {
  it('converts a keyword into a fraction', () => {
    expect(parseClauseToken('top', 1000)).toEqual({ fraction: 0, offsetPx: 0 });
    expect(parseClauseToken('center', 1000)).toEqual({ fraction: 0.5, offsetPx: 0 });
    expect(parseClauseToken('bottom', 1000)).toEqual({ fraction: 1, offsetPx: 0 });
  });

  it('converts a percentage into a fraction', () => {
    expect(parseClauseToken('80%', 1000)).toEqual({ fraction: 0.8, offsetPx: 0 });
  });

  // Matches GSAP's own _offsetToPx: only an explicit '%' suffix scales by refSize; a bare
  // number is used as a literal px value regardless of refSize.
  it('treats a bare number without a unit as a literal px offset, not a percentage', () => {
    expect(parseClauseToken('80', 1000)).toEqual({ fraction: 0, offsetPx: 80 });
    expect(parseClauseToken('80', 500)).toEqual({ fraction: 0, offsetPx: 80 }); // refSize-independent
  });

  it('extracts a px offset with its sign', () => {
    expect(parseClauseToken('top+=100', 1000)).toEqual({ fraction: 0, offsetPx: 100 });
    expect(parseClauseToken('center-=50', 1000)).toEqual({ fraction: 0.5, offsetPx: -50 });
  });

  // Verified directly against GSAP's own _offsetToPx (copied out and run standalone): with a base
  // present, omitting '=' makes GSAP silently resolve the whole token to 0. 'top+100' isn't
  // "top offset by 100" in real GSAP, since there's no '=' for _offsetToPx to split the base from
  // the offset on. This module throws instead of replicating that silent 0.
  it('throws when `+`/`-` notation omits `=` and a base precedes it (unlike GSAP\'s silent 0, matching its arithmetic requires `=` here)', () => {
    expect(() => parseClauseToken('top+100', 1000)).toThrow(/unsupported position clause "top\+100"/);
    expect(() => parseClauseToken('bottom-25.5', 1000)).toThrow(/unsupported position clause/);
    expect(() => parseClauseToken('80+10', 1000)).toThrow(/unsupported position clause/);
    // Same rule regardless of the base's own kind; this covers the percentage-base case
    // specifically, so a future refactor that special-cases basePercent can't silently skip it.
    expect(() => parseClauseToken('50%+10', 1000)).toThrow(/unsupported position clause "50%\+10"/);
  });

  it('suggests the `=`-corrected form in the error message', () => {
    expect(() => parseClauseToken('top+100', 1000)).toThrow(/Did you mean "top\+=100"\?/);
    expect(() => parseClauseToken('50%+10', 1000)).toThrow(/Did you mean "50%\+=10"\?/);
  });

  it('resolves a percentage offset relative to refSize', () => {
    expect(parseClauseToken('top+=10%', 1000)).toEqual({ fraction: 0, offsetPx: 100 });
    expect(parseClauseToken('bottom-=25%', 800)).toEqual({ fraction: 1, offsetPx: -200 });
  });

  it('throws for an unsupported notation', () => {
    expect(() => parseClauseToken('left', 1000)).toThrow(/unsupported position clause "left"/);
    expect(() => parseClauseToken('top+=10vh', 1000)).toThrow(/unsupported position clause/);
  });

  it('names \'max\' as an end-only keyword rather than a generic unsupported clause', () => {
    expect(() => parseClauseToken('max', 1000))
      .toThrow(/'max' is GSAP's end-only keyword for the scroller's maximum scroll position\./);
    expect(() => parseClauseToken('max-=100', 1000))
      .toThrow(/'max' is GSAP's end-only keyword/);
    expect(() => parseClauseToken('max+=10%', 1000))
      .toThrow(/'max' is GSAP's end-only keyword/);
    // A token that merely starts with "max" isn't this case; it stays the generic message.
    expect(() => parseClauseToken('maxWidth', 1000))
      .toThrow(/unsupported position clause "maxWidth"$/);
  });

  // GSAP itself doesn't parse 'px' specially: _offsetToPx's parseFloat silently drops any
  // non-'%' suffix, so 'top 100px' and 'top 100' behave identically in real GSAP. This module
  // recognizes 'px' explicitly (rather than adopting parseFloat's full leniency, which would also
  // silently accept a genuine typo like 'top 100vh' as 100) so the two stay equivalent here too.
  it('treats an explicit "px" suffix the same as no suffix (matching GSAP\'s own leniency)', () => {
    expect(parseClauseToken('100px', 1000)).toEqual(parseClauseToken('100', 1000));
    expect(parseClauseToken('top+=100px', 1000)).toEqual(parseClauseToken('top+=100', 1000));
    expect(parseClauseToken('bottom-=25.5px', 1000)).toEqual(parseClauseToken('bottom-=25.5', 1000));
    expect(parseClauseToken('-500px', 1000)).toEqual(parseClauseToken('-500', 1000)); // offset-only, no base
  });

  it('still throws for a unit that isn\'t "%" or "px"', () => {
    expect(() => parseClauseToken('100vh', 1000)).toThrow(/unsupported position clause "100vh"/);
    expect(() => parseClauseToken('100pxpx', 1000)).toThrow(/unsupported position clause/);
  });

  // Since the notation requires at least one digit, a string with no digits at all
  // (`parseFloat` would return NaN, silently swallowed by GSAP's `||` fallback and treated as
  // scroll position 0) throws instead.
  it('throws for a notation with zero digits (would otherwise turn into NaN)', () => {
    expect(() => parseClauseToken('.', 1000)).toThrow(/unsupported position clause "\."/);
    expect(() => parseClauseToken('..', 1000)).toThrow(/unsupported position clause/);
    expect(() => parseClauseToken('top+=.', 1000)).toThrow(/unsupported position clause/);
  });

  // Multiple dots are rejected for the same reason.
  it('throws for a notation containing multiple dots', () => {
    expect(() => parseClauseToken('1.2.3', 1000)).toThrow(/unsupported position clause/);
  });

  it('still accepts valid decimals with a leading or trailing dot', () => {
    expect(parseClauseToken('.5', 1000)).toEqual({ fraction: 0, offsetPx: 0.5 });
    expect(parseClauseToken('5.', 1000)).toEqual({ fraction: 0, offsetPx: 5 });
    expect(parseClauseToken('top+=.5', 1000)).toEqual({ fraction: 0, offsetPx: 0.5 });
  });

  it('combines a bare-number base with a signed offset (both are literal px)', () => {
    expect(parseClauseToken('80+=10', 1000)).toEqual({ fraction: 0, offsetPx: 90 });
    expect(parseClauseToken('80-=10%', 1000)).toEqual({ fraction: 0, offsetPx: -20 }); // 80 - 10%*1000
  });

  // A token that's only a signed offset, with no keyword or number before it, is valid. GSAP's
  // own _offsetToPx treats the implicit base as 0 (this is what lets an end like '-=500' resolve
  // as a position clause against endTrigger instead of dwell).
  it('accepts a signed offset with no base at all (implicit base of 0)', () => {
    expect(parseClauseToken('-=500', 1000)).toEqual({ fraction: 0, offsetPx: -500 });
    expect(parseClauseToken('+=500', 1000)).toEqual({ fraction: 0, offsetPx: 500 });
    expect(parseClauseToken('+100%', 1000)).toEqual({ fraction: 0, offsetPx: 1000 });
    expect(parseClauseToken('-50%', 1000)).toEqual({ fraction: 0, offsetPx: -500 });
    expect(parseClauseToken('-=500px', 1000)).toEqual({ fraction: 0, offsetPx: -500 });
  });

  // Without a base, there's nothing for '=' to separate the sign from, and parseFloat handles a
  // leading '+'/'-' on its own. So omitting '=' works here even though it throws when a base
  // precedes the sign (see the base+offset tests above/below).
  it('accepts a signed offset with no base and no `=` either', () => {
    expect(parseClauseToken('+500', 1000)).toEqual(parseClauseToken('+=500', 1000));
    expect(parseClauseToken('-500', 1000)).toEqual(parseClauseToken('-=500', 1000));
  });

  it('still throws for an empty token (an offset-only base doesn\'t mean any input goes)', () => {
    expect(() => parseClauseToken('', 1000)).toThrow(/unsupported position clause ""/);
  });
});

describe('isAbsoluteFormat', () => {
  // Matches GSAP's own _parsePosition: `isNaN(value) || (value = +value)` at
  // ScrollTrigger.js:750, a value coerces cleanly via unary '+' only when it's a plain number,
  // or a string with nothing in it but a number.
  it('recognizes a plain number as absolute', () => {
    expect(isAbsoluteFormat(500)).toBe(true);
    expect(isAbsoluteFormat(0)).toBe(true);
    expect(isAbsoluteFormat(-500)).toBe(true);
  });

  it('recognizes a numeric-only string as absolute', () => {
    expect(isAbsoluteFormat('500')).toBe(true);
    expect(isAbsoluteFormat('-500')).toBe(true);
    expect(isAbsoluteFormat('500.5')).toBe(true);
    expect(isAbsoluteFormat('  500  ')).toBe(true); // surrounding whitespace is fine
  });

  it('rejects a two-token clause, matching GSAP (only a single-token value coerces cleanly)', () => {
    expect(isAbsoluteFormat('500 top')).toBe(false);
  });

  it('rejects a value with a unit suffix, matching GSAP (parseFloat alone isn\'t unary \'+\')', () => {
    expect(isAbsoluteFormat('500px')).toBe(false);
    expect(isAbsoluteFormat('50%')).toBe(false);
  });

  it('rejects a keyword', () => {
    expect(isAbsoluteFormat('top')).toBe(false);
  });

  it('rejects an offset-only clause', () => {
    expect(isAbsoluteFormat('+=500')).toBe(false);
  });

  // Deliberately not matching GSAP here (empty string coerces to 0 there); see the comment on
  // isAbsoluteFormat's definition.
  it('rejects an empty string, unlike GSAP', () => {
    expect(isAbsoluteFormat('')).toBe(false);
    expect(isAbsoluteFormat('   ')).toBe(false);
  });
});

describe('resolveAbsolute', () => {
  it('returns a number as-is', () => {
    expect(resolveAbsolute(500)).toBe(500);
  });

  it('converts a numeric string', () => {
    expect(resolveAbsolute('500')).toBe(500);
    expect(resolveAbsolute('  -500  ')).toBe(-500);
  });
});

describe('resolveAnchorTop', () => {
  it('returns the top that lines up the element\'s anchor point with the viewport\'s anchor point', () => {
    // Aligning the top edge of a 100-tall element with the viewport's top edge → top 0
    expect(resolveAnchorTop('top top', 100, 800)).toBe(0);
    // Center alignment → 800/2 - 100/2
    expect(resolveAnchorTop('center center', 100, 800)).toBe(350);
    // Aligning the bottom edge of a 300-tall element with the viewport's bottom edge
    // (createOverlapScroll's default) → 800 - 300
    expect(resolveAnchorTop('bottom bottom', 300, 800)).toBe(500);
  });

  it('treats the viewport side as `top` when only one clause is given (matching GSAP)', () => {
    // GSAP itself defaults the second clause to "0" via
    // `_offsetToPx(offsets[1] || "0", scrollerSize)`.
    // So 'center' is equivalent to 'center top', not 'center center'.
    expect(resolveAnchorTop('center', 100, 800)).toBe(resolveAnchorTop('center top', 100, 800));
    expect(resolveAnchorTop('center', 100, 800)).toBe(-50);
    expect(resolveAnchorTop('top', 100, 800)).toBe(0);
    expect(resolveAnchorTop('bottom', 100, 800)).toBe(-100);
  });

  it('shifts downward for a viewport-side offset', () => {
    // Equivalent to main.ts's header correction: lowers the center by half the header height.
    expect(resolveAnchorTop('center center+=28', 100, 800)).toBe(378);
  });

  it('shifts upward for an element-side offset', () => {
    expect(resolveAnchorTop('top+=100 top', 100, 800)).toBe(-100);
  });

  it('ignores extra whitespace around and between clauses', () => {
    expect(resolveAnchorTop('  top   bottom  ', 100, 800)).toBe(800);
  });
});

describe('isDwellFormat', () => {
  // Only the literal '+=' prefix means dwell, matching GSAP's own `!parsedEnd.indexOf("+=")`
  // check. A bare number is *not* dwell notation: it's absolute format instead (see
  // isAbsoluteFormat above), matching GSAP.
  it('recognizes dwell-distance notation as dwell', () => {
    expect(isDwellFormat('+=500')).toBe(true);
    expect(isDwellFormat('+=100%')).toBe(true);
    expect(isDwellFormat(' +=500 ')).toBe(true);
    expect(isDwellFormat('+=500px')).toBe(true);
  });

  // GSAP resolves these as a position clause against endTrigger instead of a dwell distance.
  // A bare number resolves as absolute format instead (see isAbsoluteFormat above).
  it('treats anything other than a bare "+=" prefix as a position clause, not dwell', () => {
    expect(isDwellFormat(500)).toBe(false);
    expect(isDwellFormat('500')).toBe(false);
    expect(isDwellFormat('500px')).toBe(false);
    expect(isDwellFormat('-=200')).toBe(false);
    expect(isDwellFormat('+100%')).toBe(false);
    expect(isDwellFormat('50%')).toBe(false);
    expect(isDwellFormat('bottom top')).toBe(false);
    expect(isDwellFormat('bottom')).toBe(false);
    expect(isDwellFormat('center center+=50')).toBe(false);
  });
});

describe('resolveDwell', () => {
  it('converts the `+=` prefix to px', () => {
    expect(resolveDwell('+=500', 800)).toBe(500);
  });

  it('resolves `+=` percentage notation relative to the viewport height', () => {
    expect(resolveDwell('+=100%', 800)).toBe(800);
  });

  // GSAP's own leniency (parseFloat ignores a trailing 'px') applies to dwell distances too.
  it('treats an explicit "px" suffix the same as no suffix', () => {
    expect(resolveDwell('+=500px', 800)).toBe(500);
  });

  it('throws for a non-dwell notation', () => {
    expect(() => resolveDwell('bottom top', 800)).toThrow(/unsupported end format "bottom top"/);
  });

  // A bare number used to be dwell notation in this module; now it resolves as absolute format
  // instead (matching GSAP, see isAbsoluteFormat/resolveAbsolute above), so resolveDwell itself
  // no longer accepts it.
  it('throws for notation that GSAP treats as a position clause or absolute format, not dwell', () => {
    expect(() => resolveDwell('-=200', 800)).toThrow(/unsupported end format "-=200"/);
    expect(() => resolveDwell('+100%', 800)).toThrow(/unsupported end format "\+100%"/);
    expect(() => resolveDwell('50%', 800)).toThrow(/unsupported end format "50%"/);
    expect(() => resolveDwell('500', 800)).toThrow(/unsupported end format "500"/);
    expect(() => resolveDwell('500px', 800)).toThrow(/unsupported end format "500px"/);
  });

  // Same reason as parseClauseToken (a lone '.' used to turn into NaN via parseFloat,
  // silently swallowed by GSAP's `||` fallback and treated as end=0).
  // Tightening the notation to require at least one digit now throws instead.
  it('throws for a notation with zero digits (would otherwise turn into NaN)', () => {
    expect(() => resolveDwell('+=.', 800)).toThrow(/unsupported end format/);
    expect(isDwellFormat('.')).toBe(false);
  });

  it('still accepts valid decimals with a leading or trailing dot in the `+=` form', () => {
    expect(resolveDwell('+=.5', 800)).toBe(0.5);
    expect(resolveDwell('+=5.', 800)).toBe(5);
  });
});

describe('isMaxFormat', () => {
  it('recognizes GSAP\'s max notation', () => {
    expect(isMaxFormat('max')).toBe(true);
    expect(isMaxFormat('max-=100')).toBe(true);
    expect(isMaxFormat('max+=10%')).toBe(true);
    expect(isMaxFormat(' max ')).toBe(true);
  });

  it('does not treat a number or an unrelated clause as max', () => {
    expect(isMaxFormat(500)).toBe(false);
    expect(isMaxFormat('bottom top')).toBe(false);
    expect(isMaxFormat('+=500')).toBe(false);
    // 'max' must be the whole token, not merely a prefix.
    expect(isMaxFormat('maxWidth')).toBe(false);
  });

  // Verified against GSAP's own _parsePosition, which checks `value.charAt(4) === "="`
  // specifically before applying any offset. 'max-100' (no '=') isn't max offset by -100 in
  // real GSAP, it silently falls back to bare 'max' with "-100" discarded. This module doesn't
  // recognize 'max-100' as max format at all, so it throws downstream instead of replicating
  // that silent discard.
  it('does not recognize `+`/`-` notation without `=` as max format', () => {
    expect(isMaxFormat('max-100')).toBe(false);
    expect(isMaxFormat('max+50')).toBe(false);
  });
});

describe('resolveMaxOffset', () => {
  it('returns 0 for a bare "max"', () => {
    expect(resolveMaxOffset('max', 800)).toBe(0);
  });

  it('converts `+=`/`-=` notation to px', () => {
    expect(resolveMaxOffset('max-=100', 800)).toBe(-100);
    expect(resolveMaxOffset('max+=50', 800)).toBe(50);
  });

  it('resolves percentage notation relative to the viewport height', () => {
    expect(resolveMaxOffset('max-=25%', 800)).toBe(-200);
  });

  it('treats an explicit "px" suffix the same as no suffix', () => {
    expect(resolveMaxOffset('max-=100px', 800)).toBe(-100);
  });

  it('throws for a non-max notation', () => {
    expect(() => resolveMaxOffset('bottom top', 800)).toThrow(
      /unsupported max-position format "bottom top"/,
    );
  });
});
