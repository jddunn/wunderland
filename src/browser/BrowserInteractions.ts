/**
 * @fileoverview Browser interactions - Ported from OpenClaw
 * @module wunderland/browser/BrowserInteractions
 *
 * High-level browser interaction methods using Playwright.
 */

import type { BrowserSession } from './BrowserSession.js';
import type {
  ClickOptions,
  TypeOptions,
  BrowserFormField,
  ScreenshotOptions,
  WaitOptions,
} from './types.js';

/**
 * Browser interactions helper class.
 *
 * Provides high-level methods for browser automation that can be used
 * by Wunderland agents.
 *
 * @example
 * ```typescript
 * const interactions = new BrowserInteractions(session);
 *
 * await interactions.click({ ref: 'e1' });
 * await interactions.type({ ref: 'e2', text: 'Hello world' });
 * await interactions.screenshot({});
 * ```
 */
export class BrowserInteractions {
  constructor(private readonly session: BrowserSession) {}

  /**
   * Clicks an element by ref.
   */
  async click(options: Omit<ClickOptions, 'cdpUrl'>): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    const locator = this.session.refLocator(page, options.ref);
    const timeout = options.timeoutMs ?? 30000;

    if (options.doubleClick) {
      await locator.dblclick({
        timeout,
        button: options.button,
        modifiers: options.modifiers,
      });
    } else {
      await locator.click({
        timeout,
        button: options.button,
        modifiers: options.modifiers,
      });
    }
  }

  /**
   * Hovers over an element by ref.
   */
  async hover(options: { ref: string; targetId?: string; timeoutMs?: number }): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    const locator = this.session.refLocator(page, options.ref);
    await locator.hover({ timeout: options.timeoutMs ?? 30000 });
  }

  /**
   * Types text into an element.
   */
  async type(options: Omit<TypeOptions, 'cdpUrl'>): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    const locator = this.session.refLocator(page, options.ref);
    const timeout = options.timeoutMs ?? 30000;

    // Clear existing content first
    await locator.fill('', { timeout });

    if (options.slowly) {
      await locator.pressSequentially(options.text, {
        delay: 50,
        timeout,
      });
    } else {
      await locator.fill(options.text, { timeout });
    }

    if (options.submit) {
      await locator.press('Enter', { timeout: 5000 });
    }
  }

  /**
   * Fills a form with multiple fields.
   */
  async fillForm(options: {
    fields: BrowserFormField[];
    targetId?: string;
    timeoutMs?: number;
  }): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    const timeout = options.timeoutMs ?? 30000;

    for (const field of options.fields) {
      const locator = this.session.refLocator(page, field.ref);

      switch (field.type) {
        case 'select':
          await locator.selectOption(field.value, { timeout });
          break;
        case 'checkbox':
        case 'radio':
          if (field.value === 'true') {
            await locator.check({ timeout });
          } else {
            await locator.uncheck({ timeout });
          }
          break;
        default:
          await locator.fill(field.value, { timeout });
      }
    }
  }

  /**
   * Selects an option from a dropdown.
   */
  async selectOption(options: {
    ref: string;
    values: string[];
    targetId?: string;
    timeoutMs?: number;
  }): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    const locator = this.session.refLocator(page, options.ref);
    await locator.selectOption(options.values, {
      timeout: options.timeoutMs ?? 30000,
    });
  }

  /**
   * Presses a keyboard key.
   */
  async pressKey(options: { key: string; targetId?: string; delayMs?: number }): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    await page.keyboard.press(options.key, {
      delay: options.delayMs,
    });
  }

  /**
   * Scrolls an element into view.
   */
  async scrollIntoView(options: {
    ref: string;
    targetId?: string;
    timeoutMs?: number;
  }): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    const locator = this.session.refLocator(page, options.ref);
    await locator.scrollIntoViewIfNeeded({
      timeout: options.timeoutMs ?? 30000,
    });
  }

  /**
   * Takes a screenshot.
   */
  async screenshot(options: Omit<ScreenshotOptions, 'cdpUrl'>): Promise<Buffer> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    if (options.ref) {
      const locator = this.session.refLocator(page, options.ref);
      return await locator.screenshot({
        type: options.type ?? 'png',
      });
    }

    if (options.element) {
      const locator = page.locator(options.element);
      return await locator.screenshot({
        type: options.type ?? 'png',
      });
    }

    return await page.screenshot({
      fullPage: options.fullPage ?? false,
      type: options.type ?? 'png',
    });
  }

  /**
   * Waits for a condition.
   */
  async wait(options: Omit<WaitOptions, 'cdpUrl'>): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    const timeout = options.timeoutMs ?? 30000;

    if (options.timeMs) {
      await page.waitForTimeout(options.timeMs);
    }

    if (options.text) {
      await page.waitForSelector(`text=${options.text}`, { timeout });
    }

    if (options.textGone) {
      await page.waitForSelector(`text=${options.textGone}`, {
        state: 'detached',
        timeout,
      });
    }

    if (options.selector) {
      await page.waitForSelector(options.selector, { timeout });
    }

    if (options.url) {
      await page.waitForURL(options.url, { timeout });
    }

    if (options.loadState) {
      await page.waitForLoadState(options.loadState, { timeout });
    }

    if (options.fn) {
      await page.waitForFunction(options.fn, undefined, { timeout });
    }
  }

  /**
   * Navigates to a URL.
   */
  async goto(options: { url: string; targetId?: string; timeoutMs?: number }): Promise<void> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    await page.goto(options.url, {
      timeout: options.timeoutMs ?? 30000,
    });
  }

  /**
   * Gets the current page URL.
   */
  async getUrl(targetId?: string): Promise<string> {
    const page = targetId
      ? await this.session.getPageByTargetId(targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    return page.url();
  }

  /**
   * Gets the current page title.
   */
  async getTitle(targetId?: string): Promise<string> {
    const page = targetId
      ? await this.session.getPageByTargetId(targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    return page.title();
  }

  /**
   * Evaluates JavaScript in the page context.
   */
  async evaluate<T>(options: { fn: string; targetId?: string; ref?: string }): Promise<T> {
    const page = options.targetId
      ? await this.session.getPageByTargetId(options.targetId)
      : await this.session.getPage();

    if (!page) {
      throw new Error('Page not found');
    }

    if (options.ref) {
      const locator = this.session.refLocator(page, options.ref);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return await locator.evaluate(new Function('el', options.fn) as (el: unknown) => T);
    }

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return await page.evaluate(new Function(options.fn) as () => T);
  }
}
