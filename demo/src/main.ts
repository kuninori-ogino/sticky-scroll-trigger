import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import './style.css';
import StickyScrollTrigger from 'sticky-scroll-trigger';

gsap.registerPlugin(ScrollTrigger);

const debounce = <Args extends unknown[]>(func: (...args: Args) => void, wait = 100) => {
  let timer: ReturnType<typeof setTimeout>;

  return (...args: Args) => {
    clearTimeout(timer);
    timer = setTimeout(() => func(...args), wait);
  };
};

const getHeaderHeight = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--headerHeight')) || 0;
const sticky = new StickyScrollTrigger('.container__inner');
// Toggling markers on/off involves a reload, so this is saved to localStorage
// and restored on the next startup
const markersToggle = document.querySelector<HTMLInputElement>('#js-markersToggle');
const markers = localStorage.getItem('stickyScrollDemo:markers') === '1';

if (markersToggle) markersToggle.checked = markers;

// scene (data-progress-scene): animates width and color via --progress.
// 'center' sits at the halfway point of the whole viewport, so this shifts it down
// by half the header height to line up with "the center of the area excluding the header."
document
  .querySelectorAll<HTMLElement>('[data-progress-scene]')
  .forEach((scene) => {
    gsap.fromTo(
      scene,
      { '--progress': 0 },
      {
        '--progress': 1,
        'scrollTrigger': sticky.createStickyTrigger({
          trigger: scene,
          start: () => `center center+=${getHeaderHeight() / 2}`,
          end: '+=100%',
          scrub: true,
          markers,
        }),
      },
    );
  });

// Overlap scroll: wraps "the start through trigger (.overlapScroll__trigger)" in a sticky
// wrapper that freezes, while .overlapScroll__cover onward, left outside the wrapper,
// scrolls normally and covers trigger.
// createOverlapScroll handles building the wrapper, computing sticky top, and adjusting z-order.
document
  .querySelectorAll<HTMLElement>('.overlapScroll__trigger')
  .forEach((trigger) => {
    const cover = trigger.nextElementSibling;

    if (
      !(cover instanceof HTMLElement)
      || !cover.classList.contains('overlapScroll__cover')
    )
      return;

    ScrollTrigger.create(
      sticky.createOverlapScroll({ trigger, cover, start: 'bottom bottom', markers }),
    );
  });

// A partially sticky label: partialSticky__pin starts pinning just below the header
// (headerHeight+20px), and releases once the end marker's (.partialSticky__endTrigger's)
// bottom edge arrives 40px below the pinned label's own bottom.
// Implemented with plain position:sticky; pinning is handled entirely by CSS, not GSAP.
const partialStickyPin = document.querySelector<HTMLElement>(
  '.partialSticky__pin',
);

if (partialStickyPin) {
  ScrollTrigger.create(
    sticky.createStickyPin({
      trigger: partialStickyPin,
      top: () => getHeaderHeight() + 20,
      endTrigger: '.partialSticky__endTrigger',
      end: () =>
        `bottom top+=${getHeaderHeight() + 20 + partialStickyPin.offsetHeight + 40}`,
    }),
  );
}

// A pin spanning a scene section: a layout with scene 3 placed between pin and endTrigger,
// demonstrating that the spacer height accounting for the dwell is computed correctly.
const spanScenePin = document.querySelector<HTMLElement>('.spanScenePin__pin');

if (spanScenePin) {
  ScrollTrigger.create(
    sticky.createStickyPin({
      trigger: spanScenePin,
      top: () => getHeaderHeight() + 20,
      endTrigger: '.spanScenePin__endTrigger',
      end: () =>
        `bottom top+=${getHeaderHeight() + 20 + spanScenePin.offsetHeight + 40}`,
    }),
  );
}

sticky.refresh();

// ---- Everything below is a plain GSAP ScrollTrigger effect on an element that sits inside
// .container__inner, and so inside the sticky nesting, without using createStickyTrigger or
// createOverlapScroll.
//
// Inside it, an element's on-screen position drifts from the absolute position that GSAP's
// string start/end ('top 80%') resolves to, by exactly the Scene layers' dwell.
// sticky.createResolvedTrigger() returns Vars whose start/end already hold corrected absolute px,
// so passing it through as-is keeps the effect in sync with real scroll distance.

const plainFadeBox = document.querySelector<HTMLElement>(
  '.plainSection--fade .plainSection__box',
);

if (plainFadeBox) {
  gsap.fromTo(
    plainFadeBox,
    { autoAlpha: 0, x: -160, scale: 0.6, rotate: -12 },
    {
      autoAlpha: 1,
      x: 0,
      scale: 1,
      rotate: 0,
      scrollTrigger: sticky.createResolvedTrigger({
        trigger: plainFadeBox,
        start: 'top 80%',
        end: 'top 30%',
        scrub: true,
        markers,
      }),
    },
  );
}

// GSAP refreshes every trigger itself on DOMContentLoaded/load/resize, and refreshInit fires
// just before that, which is what guarantees the order "recompute sticky layers → GSAP
// recomputes". The registrations above already bind it through their own onRefreshInit, so
// nothing is needed here. Only a setup registering none of them has to add
// ScrollTrigger.addEventListener('refreshInit', () => sticky.refresh()).

const debouncedRefresh = debounce(() => {
  // sticky.refresh() is invoked via refreshInit, so all this needs to do is kick off GSAP.
  ScrollTrigger.refresh();
}, 100);

if (document.scrollingElement) {
  new ResizeObserver(() => debouncedRefresh()).observe(
    document.scrollingElement,
  );
}

// Toggling markers only takes effect after regenerating things,
// so this is handled via a page reload
markersToggle?.addEventListener('change', (event) => {
  localStorage.setItem(
    'stickyScrollDemo:markers',
    (event.target as HTMLInputElement).checked ? '1' : '0',
  );
  window.location.reload();
});

debouncedRefresh();
