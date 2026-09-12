// UI smoke test: drives the built web UI (dist/ui) through the system Chrome
// in headless mode - every page in light, dark and a phone-width viewport,
// then the interactions a pixel cannot show (theme toggle, sidebar collapse,
// the mobile sheet, the terminal's Advanced section). Each page is measured
// (lib.mjs `checkFacts`) and shot; console and page errors, failed requests
// and 4xx/5xx answers fail the run, so do layout breaks and, once a baseline
// exists, pixel diffs above --max-diff. By default the UI runs against the
// deterministic fixture BFF (fixture.mjs); `--url` targets a live `e serve`.
//
// Needs Chrome or Chromium on the machine (no download): $CHROME_PATH, PATH,
// or --chrome. Output: ui/.smoke/{current,baseline,diff,interact}/ and
// ui/.smoke/report.json (gitignored).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture.mjs';
import {
  PASSES,
  ROUTES,
  USAGE,
  VIEWPORTS,
  checkFacts,
  diffImages,
  findChrome,
  isSameOrigin,
  parseArgs,
  shotName,
  summarize,
} from './lib.mjs';

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

const SETTLE_MS = 400;
const NETWORK_IDLE_MS = 8000;

/**
 * Runs inside the page: the facts `checkFacts` judges. Kept dependency-free
 * because Playwright serializes it into Chrome.
 */
function probePage() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const toPx = value => {
    const trimmed = value.trim();
    if (trimmed.endsWith('rem')) return parseFloat(trimmed) * rem;
    if (trimmed.endsWith('px')) return parseFloat(trimmed);
    return null;
  };
  const body = getComputedStyle(document.body);
  const sidebarEl = document.querySelector('[data-sidebar=sidebar]');
  const mainEl = document.querySelector('main');
  const buttonEl = document.querySelector('button:not(:disabled)');
  const sidebarRect = sidebarEl?.getBoundingClientRect();
  return {
    bodyBackground: body.backgroundColor,
    darkClass: document.documentElement.classList.contains('dark'),
    fontFamily: body.fontFamily,
    sidebar: sidebarEl
      ? {
          width: Math.round(sidebarRect.width),
          right: Math.round(sidebarRect.right),
          expectedWidth: toPx(
            getComputedStyle(sidebarEl).getPropertyValue('--sidebar-width')
          ),
        }
      : null,
    main: mainEl
      ? { left: Math.round(mainEl.getBoundingClientRect().left) }
      : null,
    button: buttonEl ? { cursor: getComputedStyle(buttonEl).cursor } : null,
    heading: document.querySelector('h1, h2')?.textContent?.trim() ?? '',
    textLength: document.getElementById('root')?.innerText.trim().length ?? 0,
  };
}

/** Runs inside the page: the open mobile sheet's width against its `--sidebar-width-mobile`. */
function probeSheet() {
  const sheet = document.querySelector('[role=dialog][data-state=open]');
  if (!sheet) return null;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const declared = getComputedStyle(sheet)
    .getPropertyValue('--sidebar-width-mobile')
    .trim();
  return {
    width: Math.round(sheet.getBoundingClientRect().width),
    expectedWidth: declared.endsWith('rem')
      ? parseFloat(declared) * rem
      : declared.endsWith('px')
        ? parseFloat(declared)
        : null,
  };
}

/** A browser context for one pass: fixed locale and timezone so dates render alike everywhere, no animations mid-shot. */
async function openContext(browser, pass, theme, problems, baseUrl) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[pass.viewport],
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  await context.addInitScript(value => {
    localStorage.setItem('e-theme', value);
  }, theme);
  const page = await context.newPage();
  const tag = `${pass.theme}/${pass.viewport}`;
  page.on('pageerror', error => {
    problems.push(`[${tag}] page error: ${error.message}`);
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const source = message.location().url;
    if (source && !isSameOrigin(source, baseUrl)) return;
    problems.push(`[${tag}] console.error: ${message.text().slice(0, 300)}`);
  });
  page.on('requestfailed', request => {
    if (!isSameOrigin(request.url(), baseUrl)) return;
    problems.push(
      `[${tag}] request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`
    );
  });
  page.on('response', response => {
    if (response.status() >= 400 && isSameOrigin(response.url(), baseUrl)) {
      problems.push(
        `[${tag}] HTTP ${response.status()}: ${response.request().method()} ${response.url()}`
      );
    }
  });
  return { context, page };
}

async function settle(page) {
  await page
    .waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS })
    .catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}

/** Every route in one theme/viewport pass: facts, checks, a screenshot each. */
async function runPass(browser, baseUrl, pass, outDir, problems) {
  const { context, page } = await openContext(
    browser,
    pass,
    pass.theme,
    problems,
    baseUrl
  );
  const results = [];
  try {
    for (const entry of ROUTES) {
      await page.goto(`${baseUrl}/#${entry.route}`, { waitUntil: 'load' });
      await settle(page);
      const shot = shotName(entry.name, pass);
      await page.screenshot({ path: path.join(outDir, shot) });
      const facts = await page.evaluate(probePage);
      results.push({
        shot,
        route: entry.route,
        failures: checkFacts(facts, { ...pass, heading: entry.heading }),
        facts,
      });
    }
  } finally {
    await context.close();
  }
  return results;
}

/** The interactions: each a name, a screenshot and its failures. */
async function runInteractions(browser, baseUrl, outDir, problems) {
  const steps = [];
  const desktop = await openContext(
    browser,
    PASSES[0],
    'light',
    problems,
    baseUrl
  );
  try {
    const { page } = desktop;

    await page.goto(`${baseUrl}/#/terminal`, { waitUntil: 'load' });
    await settle(page);
    await page.getByRole('button', { name: /advanced/i }).click();
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: path.join(outDir, 'terminal-advanced.png') });
    const checkboxes = await page.locator('input[type=checkbox]').count();
    steps.push({
      name: 'terminal: Advanced section',
      failures:
        checkboxes > 0
          ? []
          : ['expanding Advanced showed no skill or MCP checkboxes'],
    });

    const toggled = [];
    for (const theme of ['dark', 'light']) {
      await page
        .getByRole('button', { name: new RegExp(theme, 'i') })
        .first()
        .click();
      await page.waitForTimeout(SETTLE_MS);
      const facts = await page.evaluate(probePage);
      toggled.push(
        ...checkFacts(facts, { theme, viewport: 'desktop' }).map(
          failure => `after switching to ${theme}: ${failure}`
        )
      );
    }
    steps.push({ name: 'theme toggle', failures: toggled });

    await page.goto(`${baseUrl}/#/`, { waitUntil: 'load' });
    await settle(page);
    const expanded = await page.evaluate(probePage);
    await page.getByRole('button', { name: /toggle sidebar/i }).click();
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({
      path: path.join(outDir, 'dashboard-sidebar-collapsed.png'),
    });
    const collapsed = await page.evaluate(probePage);
    steps.push({
      name: 'sidebar collapse',
      failures:
        collapsed.main !== null &&
        expanded.main !== null &&
        collapsed.main.left < expanded.main.left
          ? []
          : [
              `main content did not move left when the sidebar collapsed (${expanded.main?.left}px -> ${collapsed.main?.left}px)`,
            ],
    });
  } finally {
    await desktop.context.close();
  }

  const mobile = await openContext(
    browser,
    PASSES[2],
    'light',
    problems,
    baseUrl
  );
  try {
    const { page } = mobile;
    await page.goto(`${baseUrl}/#/runs`, { waitUntil: 'load' });
    await settle(page);
    await page.getByRole('button', { name: /toggle sidebar/i }).click();
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: path.join(outDir, 'runs-mobile-sheet.png') });
    const sheet = await page.evaluate(probeSheet);
    const failures = [];
    if (sheet === null) failures.push('the sidebar sheet did not open');
    else if (
      sheet.expectedWidth !== null &&
      Math.abs(sheet.width - sheet.expectedWidth) > 2
    ) {
      failures.push(
        `the sheet is ${sheet.width}px wide, expected ${sheet.expectedWidth}px (--sidebar-width-mobile)`
      );
    }
    steps.push({ name: 'mobile sidebar sheet', failures });
  } finally {
    await mobile.context.close();
  }
  return steps;
}

/** Diffs every current shot against the baseline; writes highlight images; optionally adopts the run as baseline. */
function compareWithBaseline(dirs, options) {
  const diffs = [];
  const shots = fs.readdirSync(dirs.current).filter(f => f.endsWith('.png'));
  const hasBaseline = fs.existsSync(dirs.baseline);
  for (const shot of shots) {
    const baselineFile = path.join(dirs.baseline, shot);
    if (hasBaseline && fs.existsSync(baselineFile)) {
      const result = diffImages(
        fs.readFileSync(baselineFile),
        fs.readFileSync(path.join(dirs.current, shot))
      );
      if (result.diff)
        fs.writeFileSync(path.join(dirs.diff, shot), result.diff);
      diffs.push({ shot, percent: result.percent, note: result.note });
    }
  }
  if (options.updateBaseline) {
    fs.rmSync(dirs.baseline, { recursive: true, force: true });
    fs.cpSync(dirs.current, dirs.baseline, { recursive: true });
  }
  return { diffs, hasBaseline };
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const chrome = findChrome({
    explicit: options.chrome,
    exists: fs.existsSync,
  });
  if (!chrome) {
    console.error(
      'smoke-ui: no Chrome or Chromium found. Install one, set CHROME_PATH, or pass --chrome <path>.'
    );
    return 2;
  }
  const outRoot = path.resolve(
    repoRoot,
    options.out ?? path.join('ui', '.smoke')
  );
  const dirs = {
    current: path.join(outRoot, 'current'),
    baseline: path.join(outRoot, 'baseline'),
    diff: path.join(outRoot, 'diff'),
  };
  fs.rmSync(dirs.current, { recursive: true, force: true });
  fs.rmSync(dirs.diff, { recursive: true, force: true });
  fs.mkdirSync(dirs.current, { recursive: true });
  fs.mkdirSync(dirs.diff, { recursive: true });

  const target = options.url
    ? { baseUrl: options.url, close: async () => undefined }
    : await startFixture(repoRoot);
  console.log(
    `smoke-ui: ${options.url ? 'live server' : 'fixture BFF'} at ${target.baseUrl}, Chrome at ${chrome}`
  );
  const problems = [];
  const pages = [];
  const interactions = [];
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: !options.headed,
  });
  try {
    for (const pass of PASSES) {
      pages.push(
        ...(await runPass(
          browser,
          target.baseUrl,
          pass,
          dirs.current,
          problems
        ))
      );
    }
    interactions.push(
      ...(await runInteractions(
        browser,
        target.baseUrl,
        dirs.current,
        problems
      ))
    );
  } finally {
    await browser.close();
    await target.close();
  }

  const { diffs, hasBaseline } = compareWithBaseline(dirs, options);
  const findings = summarize({
    pages,
    interactions,
    problems: [...new Set(problems)],
    diffs,
    maxDiff: options.maxDiff,
  });

  console.table(
    pages.map(page => ({
      shot: page.shot,
      failures: page.failures.length,
      heading: page.facts.heading,
      sidebar: page.facts.sidebar?.width ?? '-',
      mainLeft: page.facts.main?.left ?? '-',
    }))
  );
  for (const step of interactions) {
    console.log(`${step.failures.length === 0 ? 'ok  ' : 'FAIL'} ${step.name}`);
  }
  if (diffs.length > 0) {
    const worst = [...diffs].sort((a, b) => b.percent - a.percent)[0];
    console.log(
      `pixel diff vs baseline: ${diffs.length} shots, worst ${worst.shot} at ${worst.percent.toFixed(2)}%`
    );
  } else if (!hasBaseline) {
    console.log(
      'no baseline yet: pass --update-baseline to make this run the reference for pixel diffs'
    );
  }
  if (options.updateBaseline)
    console.log(`baseline updated at ${dirs.baseline}`);

  const report = {
    target: target.baseUrl,
    chrome,
    pages,
    interactions,
    problems: [...new Set(problems)],
    diffs,
    findings,
  };
  fs.writeFileSync(
    path.join(outRoot, 'report.json'),
    JSON.stringify(report, null, 2) + '\n'
  );

  if (findings.length > 0) {
    console.error(`\nsmoke-ui: ${findings.length} finding(s)`);
    for (const line of findings) console.error(`  - ${line}`);
    console.error(`screenshots: ${dirs.current}`);
    return 1;
  }
  console.log(`smoke-ui: all clear; screenshots in ${dirs.current}`);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).then(
    code => {
      process.exitCode = code;
    },
    error => {
      console.error(
        `smoke-ui: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exitCode = 2;
    }
  );
}
