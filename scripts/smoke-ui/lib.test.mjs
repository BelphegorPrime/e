import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  PASSES,
  ROUTES,
  THEME_BACKGROUNDS,
  checkFacts,
  diffImages,
  findChrome,
  isSameOrigin,
  parseArgs,
  shotName,
  summarize,
} from './lib.mjs';

test('parseArgs: defaults, every option, a trailing slash dropped from --url', () => {
  assert.deepEqual(parseArgs([]), {
    url: undefined,
    out: undefined,
    updateBaseline: false,
    maxDiff: 0.5,
    chrome: undefined,
    headed: false,
    help: false,
  });
  const options = parseArgs([
    '--url',
    'http://127.0.0.1:8080/',
    '--out',
    'tmp/shots',
    '--update-baseline',
    '--max-diff',
    '2.5',
    '--chrome',
    '/opt/chrome',
    '--headed',
  ]);
  assert.equal(options.url, 'http://127.0.0.1:8080');
  assert.equal(options.out, 'tmp/shots');
  assert.equal(options.updateBaseline, true);
  assert.equal(options.maxDiff, 2.5);
  assert.equal(options.chrome, '/opt/chrome');
  assert.equal(options.headed, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs: a missing value, a bad --max-diff and an unknown option are errors', () => {
  assert.throws(() => parseArgs(['--url']), /--url needs a value/);
  assert.throws(() => parseArgs(['--max-diff', 'lots']), /non-negative number/);
  assert.throws(() => parseArgs(['--max-diff', '-1']), /non-negative number/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option "--bogus"/);
});

test('findChrome: --chrome, then $CHROME_PATH, then PATH, then install locations, else undefined', () => {
  const posix = { platform: 'linux', delimiter: ':' };
  const none = () => false;
  assert.equal(
    findChrome({
      explicit: '/x/chrome',
      env: { CHROME_PATH: '/y' },
      exists: none,
      ...posix,
    }),
    '/x/chrome'
  );
  assert.equal(
    findChrome({ env: { CHROME_PATH: '/y/chrome' }, exists: none, ...posix }),
    '/y/chrome'
  );
  assert.equal(
    findChrome({
      env: { PATH: '/usr/local/bin:/usr/bin' },
      exists: file => file === '/usr/bin/chromium',
      ...posix,
    }),
    '/usr/bin/chromium'
  );
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(
    findChrome({
      env: { PATH: '/usr/bin' },
      exists: file => file === mac,
      platform: 'darwin',
      delimiter: ':',
    }),
    mac
  );
  assert.equal(
    findChrome({ env: { PATH: '/usr/bin' }, exists: none, ...posix }),
    undefined
  );
  assert.equal(
    findChrome({
      env: { PATH: 'C:\\Tools' },
      exists: file => file.endsWith('chrome.exe'),
      platform: 'win32',
      delimiter: ';',
    }).endsWith('chrome.exe'),
    true
  );
});

test('shotName: theme for desktop passes, "mobile" for the phone pass; one per route and pass', () => {
  assert.equal(shotName('dashboard', PASSES[0]), 'dashboard-light.png');
  assert.equal(shotName('dashboard', PASSES[1]), 'dashboard-dark.png');
  assert.equal(shotName('dashboard', PASSES[2]), 'dashboard-mobile.png');
  const names = new Set(
    ROUTES.flatMap(route => PASSES.map(pass => shotName(route.name, pass)))
  );
  assert.equal(names.size, ROUTES.length * PASSES.length);
});

const goodFacts = theme => ({
  bodyBackground: THEME_BACKGROUNDS[theme],
  darkClass: theme === 'dark',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  sidebar: { width: 192, right: 192, expectedWidth: 192 },
  main: { left: 192 },
  button: { cursor: 'pointer' },
  heading: 'Dashboard',
  textLength: 640,
});

test('checkFacts: a healthy page in either theme has no failures', () => {
  assert.deepEqual(
    checkFacts(goodFacts('light'), { theme: 'light', viewport: 'desktop' }),
    []
  );
  assert.deepEqual(
    checkFacts(goodFacts('dark'), { theme: 'dark', viewport: 'desktop' }),
    []
  );
  assert.deepEqual(
    checkFacts(
      {
        ...goodFacts('light'),
        sidebar: { width: 0, right: 0, expectedWidth: 192 },
        main: { left: 0 },
      },
      { theme: 'light', viewport: 'mobile' }
    ),
    []
  );
});

test('checkFacts: catches the sidebar collapsing to content width and the content sliding under it', () => {
  // The Tailwind 4 `w-[--sidebar-width]` regression: no width on the sidebar, no gap for the content.
  const failures = checkFacts(
    {
      ...goodFacts('light'),
      sidebar: { width: 163, right: 163, expectedWidth: 192 },
      main: { left: 0 },
    },
    { theme: 'light', viewport: 'desktop' }
  );
  assert.equal(failures.length, 2);
  assert.match(failures[0], /sidebar is 163px wide, expected 192px/);
  assert.match(failures[1], /main content starts at 0px, under the sidebar/);
  assert.match(
    checkFacts(
      { ...goodFacts('light'), sidebar: null },
      { theme: 'light', viewport: 'desktop' }
    )[0],
    /no \[data-sidebar=sidebar\]/
  );
  assert.match(
    checkFacts(
      { ...goodFacts('light'), main: { left: 192 } },
      { theme: 'light', viewport: 'mobile' }
    )[0],
    /on a phone, expected 0/
  );
});

test('checkFacts: palette, dark class, font, cursor, heading and text are each one failure', () => {
  const light = { theme: 'light', viewport: 'desktop' };
  assert.match(
    checkFacts(
      { ...goodFacts('light'), bodyBackground: 'rgb(255, 255, 255)' },
      light
    )[0],
    /body background is rgb\(255, 255, 255\), expected rgb\(249, 249, 251\)/
  );
  assert.match(
    checkFacts({ ...goodFacts('light'), darkClass: true }, light)[0],
    /root \.dark class is true/
  );
  assert.match(
    checkFacts({ ...goodFacts('light'), fontFamily: 'serif' }, light)[0],
    /font-family is "serif"/
  );
  assert.match(
    checkFacts(
      { ...goodFacts('light'), button: { cursor: 'default' } },
      light
    )[0],
    /cursor default, expected pointer/
  );
  assert.match(
    checkFacts({ ...goodFacts('light'), heading: '' }, light)[0],
    /no page heading/
  );
  assert.match(
    checkFacts({ ...goodFacts('light'), textLength: 0 }, light)[0],
    /rendered no text/
  );
  // A framed page has neither a heading nor text of its own.
  assert.deepEqual(
    checkFacts(
      { ...goodFacts('light'), heading: '', textLength: 0 },
      { ...light, heading: false }
    ),
    []
  );
});

test('isSameOrigin: same host and port only; garbage is foreign', () => {
  assert.equal(
    isSameOrigin('http://127.0.0.1:8080/api/x', 'http://127.0.0.1:8080'),
    true
  );
  assert.equal(
    isSameOrigin('http://127.0.0.1:8081/api/x', 'http://127.0.0.1:8080'),
    false
  );
  assert.equal(isSameOrigin('not a url', 'http://127.0.0.1:8080'), false);
});

function png(width, height, paint) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

test('diffImages: identical is 0%, one changed pixel in 100 is 1%, a size change is 100% with a note', () => {
  const white = png(10, 10, () => [255, 255, 255]);
  const oneBlack = png(10, 10, (x, y) =>
    x === 3 && y === 4 ? [0, 0, 0] : [255, 255, 255]
  );
  assert.equal(diffImages(white, white).percent, 0);
  const changed = diffImages(white, oneBlack);
  assert.equal(changed.percent, 1);
  assert.ok(changed.diff instanceof Buffer);
  assert.equal(PNG.sync.read(changed.diff).width, 10);
  const resized = diffImages(
    white,
    png(10, 12, () => [255, 255, 255])
  );
  assert.equal(resized.percent, 100);
  assert.equal(resized.note, 'size 10x10 vs 10x12');
});

test('summarize: one line per page failure, interaction failure, problem and diff over the limit', () => {
  const lines = summarize({
    pages: [
      { shot: 'runs-dark.png', failures: ['a', 'b'] },
      { shot: 'ok.png', failures: [] },
    ],
    interactions: [{ name: 'theme toggle', failures: ['stuck'] }],
    problems: ['[light/desktop] HTTP 404: GET http://x/api/y'],
    diffs: [
      { shot: 'runs-dark.png', percent: 3.456 },
      { shot: 'fine.png', percent: 0.1 },
      { shot: 'resized.png', percent: 100, note: 'size 1x1 vs 2x2' },
    ],
    maxDiff: 0.5,
  });
  assert.deepEqual(lines, [
    'runs-dark.png: a',
    'runs-dark.png: b',
    'theme toggle: stuck',
    '[light/desktop] HTTP 404: GET http://x/api/y',
    'runs-dark.png: 3.46% of pixels differ from the baseline (max 0.5%)',
    'resized.png: 100.00% of pixels differ from the baseline (max 0.5%), size 1x1 vs 2x2',
  ]);
});
