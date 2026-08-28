import { describe, expect, it } from 'vitest';
import {
  classifyPosition,
  isAbsoluteFormat,
  isDwellFormat,
  isMaxFormat,
  parseClauseToken,
  prefixSpacedRelativeEnd,
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
  // A '%'-suffixed one is read as a signed base rather than as an offset, since the base may carry
  // a sign of its own. Which half of the pair holds it makes no difference to any caller: both are
  // scaled by the same refSize and summed (see resolveAnchorTop), so '+100%' is 1000 either way.
  it('accepts a signed offset with no base at all (implicit base of 0)', () => {
    expect(parseClauseToken('-=500', 1000)).toEqual({ fraction: 0, offsetPx: -500 });
    expect(parseClauseToken('+=500', 1000)).toEqual({ fraction: 0, offsetPx: 500 });
    expect(parseClauseToken('+100%', 1000)).toEqual({ fraction: 1, offsetPx: 0 });
    expect(parseClauseToken('-50%', 1000)).toEqual({ fraction: -0.5, offsetPx: 0 });
    expect(parseClauseToken('-=500px', 1000)).toEqual({ fraction: 0, offsetPx: -500 });
  });

  // The sign on a base only changes the result once an offset follows it, which is the pair GSAP
  // resolves by splitting at the '=' and running parseFloat over everything before it.
  it('accepts a signed number base carrying an offset', () => {
    expect(parseClauseToken('-50', 1000)).toEqual({ fraction: 0, offsetPx: -50 });
    expect(parseClauseToken('-50+=100', 1000)).toEqual({ fraction: 0, offsetPx: 50 });
    expect(parseClauseToken('+50-=100', 1000)).toEqual({ fraction: 0, offsetPx: -50 });
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

  // isNaN('Infinity') is false (Number('Infinity') is Infinity, not NaN), so GSAP's own check
  // treats it as absolute too. This module deliberately doesn't tighten that to a finite check.
  it('recognizes non-finite numeric strings as absolute, matching GSAP', () => {
    expect(isAbsoluteFormat('Infinity')).toBe(true);
    expect(isAbsoluteFormat('-Infinity')).toBe(true);
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

  describe('GSAP\'s clamp() wrapper', () => {
    it('names the whole value and suggests the clause inside it', () => {
      expect(() => resolveAnchorTop('clamp(top center)', 100, 800)).toThrow(
        /unsupported position clause "clamp\(top center\)": GSAP's clamp\(\) wrapper isn't supported here\. Did you mean "top center"\?/,
      );
    });

    it('covers the single-clause and end-keyword forms too', () => {
      expect(() => resolveAnchorTop('clamp(top)', 100, 800)).toThrow(/Did you mean "top"\?/);
      expect(() => resolveAnchorTop('clamp(max)', 100, 800)).toThrow(/Did you mean "max"\?/);
    });

    it('drops the suggestion when there is no clause to suggest', () => {
      expect(() => resolveAnchorTop('clamp()', 100, 800)).toThrow(
        /clamp\(\) wrapper isn't supported here\.$/,
      );
    });

    it('ignores a token that starts with clamp but opens no parenthesis', () => {
      expect(() => resolveAnchorTop('clamped', 100, 800)).toThrow(
        /unsupported position clause "clamped"$/,
      );
    });
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
  // check. A bare number is absolute format instead (see isAbsoluteFormat above), also matching
  // GSAP.
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

describe('prefixSpacedRelativeEnd', () => {
  // GSAP's `parsedStart.split(" ")[0] + parsedEnd` (ScrollTrigger.js:1391), which is what makes
  // start: 'bottom bottom' with end: '+=100 bottom' resolve as 'bottom+=100 bottom'.
  it('prepends the start clause\'s element token to a spaced "+=" end', () => {
    expect(prefixSpacedRelativeEnd('bottom bottom', '+=100 bottom')).toBe('bottom+=100 bottom');
    expect(prefixSpacedRelativeEnd('center center', '+=100 bottom')).toBe('center+=100 bottom');
    expect(prefixSpacedRelativeEnd('50% top', '+=10% bottom')).toBe('50%+=10% bottom');
  });

  // The composed token resolves to the same value GSAP's _offsetToPx gives it: the start token's
  // own fraction of endTrigger's height, plus the end's offset.
  it('composes a token that resolves against endTrigger the way GSAP resolves it', () => {
    const composed = prefixSpacedRelativeEnd('bottom bottom', '+=100 bottom') as string;

    // 800 * 1 (viewport 'bottom') - (200 * 1 + 100) = 500, where GSAP's _offsetToPx reads
    // 'bottom+=100' as 100 + 1 * 200.
    expect(resolveAnchorTop(composed, 200, 800)).toBe(500);
  });

  // Every default start in this module has a 'top'/'0' element token, so nothing moves for a
  // caller who leaves start alone.
  it('leaves the resolved value unchanged for a zero-fraction start token', () => {
    const composed = prefixSpacedRelativeEnd('top top', '+=100 bottom') as string;

    expect(composed).toBe('top+=100 bottom');
    expect(resolveAnchorTop(composed, 200, 800)).toBe(resolveAnchorTop('+=100 bottom', 200, 800));
    expect(prefixSpacedRelativeEnd('0 0', '+=100 bottom')).toBe('0+=100 bottom');
  });

  it('leaves an end that is not a spaced "+=" value alone', () => {
    expect(prefixSpacedRelativeEnd('bottom bottom', '+=500')).toBe('+=500');
    expect(prefixSpacedRelativeEnd('bottom bottom', 'bottom top+=40')).toBe('bottom top+=40');
    expect(prefixSpacedRelativeEnd('bottom bottom', '-=200 bottom')).toBe('-=200 bottom');
    expect(prefixSpacedRelativeEnd('bottom bottom', 'max')).toBe('max');
    expect(prefixSpacedRelativeEnd('bottom bottom', 500)).toBe(500);
  });

  // GSAP's own `_isString(parsedStart) ? parsedStart.split(" ")[0] : ""`: an absolute start
  // contributes no element token, so the end keeps its implicit fraction of 0.
  it('prepends nothing when start is an absolute scroll position', () => {
    expect(prefixSpacedRelativeEnd(500, '+=100 bottom')).toBe('+=100 bottom');
    expect(prefixSpacedRelativeEnd('500', '+=100 bottom')).toBe('500+=100 bottom');
  });

  // GSAP's _offsetToPx splits at the first '=', so 'top+=50+=100' silently resolves to 50 with the
  // end's own offset discarded. This module rejects the pair rather than reproducing that, and
  // quotes what the caller wrote rather than the composed token.
  it('throws when the start\'s element token carries an offset of its own', () => {
    expect(() => prefixSpacedRelativeEnd('top+=50 bottom', '+=100 bottom'))
      .toThrow(/end "\+=100 bottom" can't be resolved against start "top\+=50 bottom"/);
    expect(() => prefixSpacedRelativeEnd('top+=50 bottom', '+=100 bottom'))
      .toThrow(/"top\+=50" carries an offset of its own/);
  });

  // A signed base is the near miss: GSAP composes '-50+=100' into 50 with nothing discarded, so
  // this composes it too rather than rejecting a pair GSAP accepts.
  it('composes a signed element token, which GSAP resolves cleanly', () => {
    const composed = prefixSpacedRelativeEnd('-50 top', '+=100 bottom') as string;

    expect(composed).toBe('-50+=100 bottom');
    // 800 * 1 (viewport 'bottom') - (-50 + 100) = 750, matching _offsetToPx('-50+=100', 200) = 50.
    expect(resolveAnchorTop(composed, 200, 800)).toBe(750);
  });

  // The start side gets the same as-written check the end side does, so a malformed start token is
  // quoted the way the caller wrote it rather than as part of a composed string.
  it('reports a malformed start element token against the token as written', () => {
    expect(() => prefixSpacedRelativeEnd('top+50 bottom', '+=100 bottom'))
      .toThrow(/unsupported position clause "top\+50"/);
  });

  // A bare-number start in a spelling the clause parser can't express is left alone rather than
  // rejected: it resolves fine as an absolute start everywhere else, so throwing would break a
  // config that works. The plain spellings still compose (see the absolute-start case above).
  it('leaves an unparseable but absolute-format start alone instead of throwing', () => {
    expect(prefixSpacedRelativeEnd('1e3', '+=100 bottom')).toBe('+=100 bottom');
    expect(prefixSpacedRelativeEnd('Infinity', '+=100 bottom')).toBe('+=100 bottom');
  });

  // A clamp() start has to be caught on the whole value, since the split this function does would
  // otherwise reduce it to 'clamp(top'. Same message resolveAnchorTop gives it on its own.
  it('reports a clamp() start on the whole value, not the split fragment', () => {
    expect(() => prefixSpacedRelativeEnd('clamp(top center)', '+=100 bottom'))
      .toThrow(/unsupported position clause "clamp\(top center\)".*Did you mean "top center"\?/);
  });

  // The mirror of the rejection above: the end's own offset is checked before the prefix is glued
  // on, so the message quotes '+=100vh' rather than the composed 'center+=100vh'.
  it('reports a malformed offset in the end against the token as written', () => {
    expect(() => prefixSpacedRelativeEnd('center center', '+=100vh bottom'))
      .toThrow(/unsupported position clause "\+=100vh"/);
  });

  it('tolerates surrounding whitespace on both values', () => {
    expect(prefixSpacedRelativeEnd('  bottom  bottom ', ' +=100 bottom ')).toBe(
      'bottom+=100 bottom',
    );
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

// classifyPosition composes the three predicates above into the single value every call path in
// index.ts branches on.
describe('classifyPosition', () => {
  it('classifies dwell notation', () => {
    expect(classifyPosition('+=500')).toEqual({ kind: 'dwell', value: '+=500' });
    expect(classifyPosition('+=100%')).toEqual({ kind: 'dwell', value: '+=100%' });
  });

  it('classifies absolute notation, resolved to a number', () => {
    expect(classifyPosition(500)).toEqual({ kind: 'absolute', value: 500 });
    expect(classifyPosition('500')).toEqual({ kind: 'absolute', value: 500 });
    expect(classifyPosition('Infinity')).toEqual({ kind: 'absolute', value: Infinity });
  });

  it('classifies max notation', () => {
    expect(classifyPosition('max')).toEqual({ kind: 'max', value: 'max' });
    expect(classifyPosition('max-=100')).toEqual({ kind: 'max', value: 'max-=100' });
  });

  it('classifies an ordinary position clause', () => {
    expect(classifyPosition('top top')).toEqual({ kind: 'clause', value: 'top top' });
    expect(classifyPosition('bottom')).toEqual({ kind: 'clause', value: 'bottom' });
  });

  // The space keeps it out of dwell format (see isDwellFormat/DWELL_RELATIVE_RE above), so this
  // is a clause like any other, not a dwell.
  it('classifies a spaced \'+=\' end as a clause, not a dwell', () => {
    expect(classifyPosition('+=100 bottom')).toEqual({ kind: 'clause', value: '+=100 bottom' });
  });

  // classifyPosition's ordering rests on these three staying disjoint, so the samples run through
  // each notation the module accepts, including the variants the predicates parse separately:
  // signs, units, offsets and surrounding whitespace. Clause samples are there for the zero-match
  // case, which is what the 'clause' fallback answers. A predicate that widened into another's
  // territory would fail here rather than send a call path down the wrong branch.
  it('never lets more than one of the three named predicates match the same input', () => {
    const samples: readonly (string | number)[] = [
      500, 0, -500, 0.5, Infinity, -Infinity,
      '500', '-500', '500.5', '  500  ', 'Infinity', '-Infinity',
      '+=500', '+=100%', '+=500px', ' +=500 ',
      'max', 'max-=100', 'max+=10%', ' max ',
      'top top', 'bottom', 'center center', '50% top', 'top+=50 bottom', '+=100 bottom',
    ];

    samples.forEach((sample) => {
      const hits = [
        ['dwell', isDwellFormat(sample)] as const,
        ['absolute', isAbsoluteFormat(sample)] as const,
        ['max', isMaxFormat(sample)] as const,
      ].filter(([, matched]) => matched);

      expect(
        hits.length,
        `expected at most one predicate to match ${JSON.stringify(sample)}, got ${JSON.stringify(hits)}`,
      ).toBeLessThanOrEqual(1);

      // classifyPosition agrees with whichever predicate matched, or falls back to 'clause' when
      // none did.
      const expectedKind = hits.length === 1 ? hits[0][0] : 'clause';

      expect(classifyPosition(sample).kind).toBe(expectedKind);
    });
  });
});
