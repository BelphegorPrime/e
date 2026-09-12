// The pure part of the UI smoke test (smoke-ui.mjs): argument parsing, Chrome
// discovery, the checks that turn a page's measured facts into failures,
// screenshot naming and the pixel diff. No browser and no server here - this
// is what lib.test.mjs covers.

import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** The hash routes of ui/src/index.tsx. `heading: false` for a page without one (a framed app). */
export const ROUTES = [
  { route: '/', name: 'dashboard' },
  { route: '/egress', name: 'egress' },
  { route: '/runs', name: 'runs' },
  { route: '/agents', name: 'agents' },
  { route: '/activity', name: 'activity' },
  { route: '/terminal', name: 'terminal' },
  { route: '/omniroute', name: 'omniroute', heading: false },
  { route: '/settings', name: 'settings' },
];

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 400, height: 800 },
};

/** Every route is shot in these passes; the mobile pass is light only. */
export const PASSES = [
  { theme: 'light', viewport: 'desktop' },
  { theme: 'dark', viewport: 'desktop' },
  { theme: 'light', viewport: 'mobile' },
];

/** The `--background` tokens of ui/src/index.css (`hsl(240 20% 98%)`, `hsl(220 29% 6%)`) as Chrome reports them. */
export const THEME_BACKGROUNDS = {
  light: 'rgb(249, 249, 251)',
  dark: 'rgb(11, 14, 20)',
};

/** The first family of the sans stack in ui/src/index.css. */
export const FONT_STACK_HEAD = '-apple-system';

export const USAGE = `usage: node scripts/smoke-ui/smoke-ui.mjs [options]

Drives the built web UI (dist/ui) through headless Chrome: every page in light,
dark and a phone-width viewport, plus the sidebar, theme and terminal
interactions. Fails on console or page errors, failed or 4xx/5xx requests,
a broken layout, or a pixel diff above --max-diff against the baseline.

  --url <base>          test a running e serve instead of the built-in fixture
  --out <dir>           screenshots, diffs and report.json (default: ui/.smoke)
  --update-baseline     make this run the baseline for later pixel diffs
  --max-diff <percent>  tolerated pixel difference per shot (default: 0.5)
  --chrome <path>       Chrome or Chromium executable ($CHROME_PATH, then PATH)
  --headed              show the browser window
  -h, --help            this text`;

export function parseArgs(argv) {
  const options = {
    url: undefined,
    out: undefined,
    updateBaseline: false,
    maxDiff: 0.5,
    chrome: undefined,
    headed: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value.`);
      return next;
    };
    switch (arg) {
      case '--url':
        options.url = value().replace(/\/+$/, '');
        break;
      case '--out':
        options.out = value();
        break;
      case '--update-baseline':
        options.updateBaseline = true;
        break;
      case '--max-diff': {
        const percent = Number(value());
        if (!Number.isFinite(percent) || percent < 0) {
          throw new Error('--max-diff needs a non-negative number (percent).');
        }
        options.maxDiff = percent;
        break;
      }
      case '--chrome':
        options.chrome = value();
        break;
      case '--headed':
        options.headed = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}".\n\n${USAGE}`);
    }
  }
  return options;
}

const CHROME_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
];

const CHROME_INSTALL_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/**
 * The Chrome executable to drive: `explicit` (--chrome), then $CHROME_PATH,
 * then a Chrome/Chromium name on PATH, then the usual install locations.
 * Undefined when none exists. `exists` and `env` are injectable for tests.
 */
export function findChrome({
  explicit,
  env = process.env,
  exists,
  platform = process.platform,
  delimiter = path.delimiter,
}) {
  if (explicit) return explicit;
  if (env.CHROME_PATH) return env.CHROME_PATH;
  const names =
    platform === 'win32'
      ? CHROME_NAMES.map(name => `${name}.exe`)
      : CHROME_NAMES;
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return CHROME_INSTALL_PATHS.find(candidate => exists(candidate));
}

/** `dashboard-light.png`, `dashboard-dark.png`, `dashboard-mobile.png`. */
export function shotName(name, pass) {
  return `${name}-${pass.viewport === 'mobile' ? 'mobile' : pass.theme}.png`;
}

/**
 * The failures in one page's facts, as `probePage` in smoke-ui.mjs measures
 * them: the theme palette applied to the body and the `.dark` class in step
 * with it, the font stack, the sidebar at its declared `--sidebar-width` with
 * the main content beside it rather than under it (the Tailwind 4
 * `w-[--var]` -> `w-(--var)` regression), a pointer on buttons, a heading and
 * some text. Pure: facts in, sentences out; empty means the page is fine.
 */
export function checkFacts(facts, { theme, viewport, heading = true }) {
  const failures = [];
  const background = THEME_BACKGROUNDS[theme];
  if (facts.bodyBackground !== background) {
    failures.push(
      `body background is ${facts.bodyBackground}, expected ${background} (${theme})`
    );
  }
  if (facts.darkClass !== (theme === 'dark')) {
    failures.push(
      `root .dark class is ${facts.darkClass}, expected ${theme === 'dark'} (${theme})`
    );
  }
  if (!facts.fontFamily.startsWith(FONT_STACK_HEAD)) {
    failures.push(
      `body font-family is "${facts.fontFamily}", expected the stack starting with ${FONT_STACK_HEAD}`
    );
  }
  if (viewport === 'desktop') {
    if (facts.sidebar === null) {
      failures.push('no [data-sidebar=sidebar] element rendered');
    } else {
      if (
        facts.sidebar.expectedWidth !== null &&
        Math.abs(facts.sidebar.width - facts.sidebar.expectedWidth) > 2
      ) {
        failures.push(
          `sidebar is ${facts.sidebar.width}px wide, expected ${facts.sidebar.expectedWidth}px (--sidebar-width)`
        );
      }
      if (facts.main !== null && facts.main.left < facts.sidebar.right - 1) {
        failures.push(
          `main content starts at ${facts.main.left}px, under the sidebar that ends at ${facts.sidebar.right}px`
        );
      }
    }
  } else if (facts.main !== null && facts.main.left > 1) {
    failures.push(
      `main content starts at ${facts.main.left}px on a phone, expected 0 (sidebar off-canvas)`
    );
  }
  if (facts.button !== null && facts.button.cursor !== 'pointer') {
    failures.push(
      `an enabled button has cursor ${facts.button.cursor}, expected pointer`
    );
  }
  if (heading && facts.heading === '')
    failures.push('no page heading rendered');
  if (heading && facts.textLength === 0)
    failures.push('the page rendered no text');
  return failures;
}

/** True when `url` shares the origin of `baseUrl`; a malformed url counts as foreign. */
export function isSameOrigin(url, baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Compares two PNG buffers pixel by pixel. `percent` is the share of pixels
 * that differ beyond the anti-aliasing tolerance; `diff` is the highlight
 * image. Images of different sizes are 100% different, with a `note`.
 */
export function diffImages(baseline, current, threshold = 0.1) {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(current);
  if (a.width !== b.width || a.height !== b.height) {
    return {
      percent: 100,
      diff: undefined,
      note: `size ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold,
  });
  return {
    percent: (100 * differing) / (a.width * a.height),
    diff: PNG.sync.write(diff),
  };
}

/** One line per finding, for the console and report.json. */
export function summarize({ pages, interactions, problems, diffs, maxDiff }) {
  const lines = [];
  for (const page of pages) {
    for (const failure of page.failures) {
      lines.push(`${page.shot}: ${failure}`);
    }
  }
  for (const step of interactions) {
    for (const failure of step.failures) lines.push(`${step.name}: ${failure}`);
  }
  for (const problem of problems) lines.push(problem);
  for (const entry of diffs) {
    if (entry.percent > maxDiff) {
      lines.push(
        `${entry.shot}: ${entry.percent.toFixed(2)}% of pixels differ from the baseline (max ${maxDiff}%)${entry.note ? `, ${entry.note}` : ''}`
      );
    }
  }
  return lines;
}
