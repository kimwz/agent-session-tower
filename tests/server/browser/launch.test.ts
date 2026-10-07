import assert from 'node:assert/strict';
import test from 'node:test';
import type { Browser, BrowserContext, LaunchOptions } from 'playwright';
import { LOOPBACK_RESOLVER_RULES, launchOptions, newContext, regularUserAgent, startBrowser } from '../../../server/browser/launch.js';

test('neither tier lets Playwright close the browser on a signal; only `browser` drops the automation markers', () => {
  for (const tier of ['light', 'general'] as const) {
    const options = launchOptions(tier, '--tower-browser=m', 'chrome');
    assert.deepEqual([options.handleSIGINT, options.handleSIGTERM, options.handleSIGHUP, options.headless, options.channel], [false, false, false, true, 'chrome']);
    assert.ok(options.args!.includes('--tower-browser=m'));
  }
  assert.equal(launchOptions('light', 'm', undefined).ignoreDefaultArgs, undefined);
  assert.equal(launchOptions('light', 'm', undefined).channel, undefined);
  const general = launchOptions('general', 'm', undefined);
  assert.deepEqual(general.ignoreDefaultArgs, ['--enable-automation']);
  assert.ok(general.args!.includes('--disable-blink-features=AutomationControlled'));
  for (const tier of ['light', 'general'] as const) {
    assert.equal(launchOptions(tier, 'm', 'chrome').args!.includes(LOOPBACK_RESOLVER_RULES), false);
    assert.ok(launchOptions(tier, 'm', 'chrome', true).args!.includes(LOOPBACK_RESOLVER_RULES), 'redirects to this computer never resolve where outside content is');
  }
  for (const form of ['localhost', '*.localhost', '127.*', '[::1]', '[::ffff:*]']) assert.ok(LOOPBACK_RESOLVER_RULES.includes(`MAP ${form} ~NOTFOUND`), form);
  assert.equal(regularUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 HeadlessChrome/154.0.0.0 Safari/537.36'), 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36');
});

test('the installed Chrome is tried first, then Playwright\'s Chromium; Tower installs neither and other errors pass through', async () => {
  const fake = (fail: (options: LaunchOptions) => Error | undefined) => {
    const asked: (string | undefined)[] = [];
    return { asked, launch: async (options: LaunchOptions) => { asked.push(options.channel); const error = fail(options); if (error) throw error; return {} as Browser; } };
  };
  const chromeOnly = fake(() => undefined);
  await startBrowser('light', 'm', {}, chromeOnly);
  assert.deepEqual(chromeOnly.asked, ['chrome']);
  const noChrome = fake(options => options.channel ? new Error('Chromium distribution \'chrome\' is not found at /Applications/Google Chrome.app') : undefined);
  await startBrowser('general', 'm', {}, noChrome);
  assert.deepEqual(noChrome.asked, ['chrome', undefined]);
  const none = fake(options => new Error(options.channel ? 'distribution \'chrome\' is not found' : 'Executable doesn\'t exist at /cache/chromium'));
  await assert.rejects(startBrowser('light', 'm', {}, none), /No browser is installed.*npx playwright install chromium.*Tower installs none itself/s);
  const broken = fake(() => new Error('Target crashed'));
  await assert.rejects(startBrowser('light', 'm', {}, broken), /Target crashed/);
  assert.deepEqual(broken.asked, ['chrome']);
});

test('a guarded context refuses this computer\'s own addresses, as Tower\'s sign-in bypass knows them, and nothing else', async () => {
  const routes: ((url: URL) => boolean)[] = [];
  const sockets: ((url: URL) => boolean)[] = [];
  const created: unknown[] = [];
  const context = { route: async (match: (url: URL) => boolean) => { routes.push(match); }, routeWebSocket: async (match: (url: URL) => boolean) => { sockets.push(match); } } as unknown as BrowserContext;
  const browser = { newContext: async (options: unknown) => { created.push(options); return context; } } as unknown as Browser;
  await newContext('light', browser, { outsideContent: true });
  assert.deepEqual(created, [{ serviceWorkers: 'block' }]);
  for (const match of [routes[0], sockets[0]]) {
    for (const blocked of ['http://localhost:8000/', 'http://127.0.0.1:8000/api/bootstrap', 'http://127.1.2.3/', 'http://[::1]:8000/', 'ws://localhost:8000/ws']) assert.equal(match(new URL(blocked)), true, blocked);
    for (const open of ['https://example.com/', 'http://127.0.0.1.nip.io:8000/', 'http://my.localhost/', 'http://192.168.0.10:8000/']) assert.equal(match(new URL(open)), false, open);
  }
  const plain = { route: async () => { throw new Error('not guarded'); } } as unknown as BrowserContext;
  await newContext('light', { newContext: async () => plain } as unknown as Browser, {});
});

test('the resolver rules reach the launch where outside content is', async () => {
  const asked: LaunchOptions[] = [];
  await startBrowser('general', 'm', { outsideContent: true }, { launch: async (options: LaunchOptions) => { asked.push(options); return {} as Browser; } });
  assert.ok(asked[0].args!.includes(LOOPBACK_RESOLVER_RULES));
});
