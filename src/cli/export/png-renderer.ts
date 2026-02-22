/**
 * @fileoverview Render HTML to PNG via Playwright (headless Chromium).
 * Uses playwright-core which is already installed for BrowserSession.
 * @module wunderland/cli/export/png-renderer
 */

export interface PngRenderOptions {
  width?: number;
  deviceScaleFactor?: number;
}

const DEFAULTS: Required<PngRenderOptions> = {
  width: 1200,
  deviceScaleFactor: 2,
};

/**
 * Render an HTML string to a PNG file.
 *
 * Uses playwright-core with bundled Chromium. On first use,
 * the browser binary may need to be installed.
 */
export async function renderPng(
  html: string,
  outputPath: string,
  opts?: PngRenderOptions,
): Promise<void> {
  const o = { ...DEFAULTS, ...opts };

  let chromium: any;
  try {
    const pw = await import('playwright-core');
    chromium = pw.chromium;
  } catch {
    throw new Error(
      'playwright-core is required for PNG export.\n' +
      'Install it: pnpm add playwright-core\n' +
      'Then install a browser: npx playwright install chromium',
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    throw new Error(
      'No Chromium browser found for Playwright.\n' +
      'Install one: npx playwright install chromium\n' +
      'This only needs to be done once.',
    );
  }

  try {
    const context = await browser.newContext({
      viewport: { width: o.width, height: 100 },
      deviceScaleFactor: o.deviceScaleFactor,
    });
    const page = await context.newPage();

    await page.setContent(html, { waitUntil: 'networkidle' });

    // Get actual content height for full-page screenshot
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const bodyHeight = await page.evaluate('document.body.scrollHeight') as number;
    await page.setViewportSize({ width: o.width, height: bodyHeight + 20 });

    await page.screenshot({
      path: outputPath,
      fullPage: true,
      type: 'png',
    });
  } finally {
    await browser.close();
  }
}
