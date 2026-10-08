import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { loadConfig } from '../src/config.ts';
import { BrowserUseCloud } from '../src/browser-use.ts';
import { AgentBrowser } from '../src/browser.ts';

test('owned cloud session stops after restart; profile survives; credentials are not persisted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'instinct-cloud-'));
  const cfg = { ...loadConfig(), home, cdpUrl: undefined, browserUse: { apiKey: 'secret-test-key', proxyCountry: 'br', timeoutMinutes: 60 } };
  const calls: string[] = [];
  let count = 0;
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/v4', '');
    calls.push(`${init!.method} ${path}`);
    if (path === '/profiles') return Response.json({ id: 'profile-1' });
    if (path === '/browsers') {
      assert.equal(JSON.parse(String(init!.body)).profileId, 'profile-1');
      return Response.json({ id: `browser-${++count}`, cdpUrl: 'wss://example.invalid/secret-cdp' });
    }
    return Response.json({ status: 'stopped' });
  };
  try {
    await new BrowserUseCloud(cfg, request).start();
    const recovered = new BrowserUseCloud(cfg, request);
    await recovered.start();
    await recovered.stop();
    await recovered.stop();
    assert.deepEqual(calls, ['POST /profiles', 'POST /browsers', 'PATCH /browsers/browser-1', 'POST /browsers', 'PATCH /browsers/browser-2']);
    const saved = readFileSync(join(home, 'browser-use.json'), 'utf8');
    assert.deepEqual(JSON.parse(saved), { profileId: 'profile-1' });
    assert.doesNotMatch(saved, /secret/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('provider failure is sanitized and does not discard an unclosed browser', async () => {
  const home = mkdtempSync(join(tmpdir(), 'instinct-cloud-'));
  const cfg = { ...loadConfig(), home, browserUse: { apiKey: 'secret-test-key', proxyCountry: 'br', timeoutMinutes: 60 } };
  writeFileSync(join(home, 'browser-use.json'), JSON.stringify({ profileId: 'profile', activeId: 'owned-browser' }));
  const request: typeof fetch = async () => new Response('sensitive-provider-body', { status: 503 });
  try {
    await assert.rejects(new BrowserUseCloud(cfg, request).start(), e => {
      assert.match(String(e), /HTTP 503/);
      assert.doesNotMatch(String(e), /sensitive|secret-test-key/);
      return true;
    });
    assert.equal(JSON.parse(readFileSync(join(home, 'browser-use.json'), 'utf8')).activeId, 'owned-browser');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CDP failure stops the cloud browser and never launches local Chrome', async () => {
  const home = mkdtempSync(join(tmpdir(), 'instinct-cloud-'));
  const cfg = { ...loadConfig(), home, cdpUrl: undefined, browserUse: { apiKey: 'test', proxyCountry: 'br', timeoutMinutes: 60 } };
  const b = new AgentBrowser(cfg);
  let stops = 0, localLaunches = 0;
  (b as any).cloud = { start: async () => ({ cdpUrl: 'wss://secret.invalid' }), stop: async () => { stops++; } };
  const connect = chromium.connectOverCDP, launch = chromium.launchPersistentContext;
  chromium.connectOverCDP = async () => { throw new Error('wss://secret.invalid leaked in a library error'); };
  chromium.launchPersistentContext = async () => { localLaunches++; throw new Error('unexpected local launch'); };
  try {
    await assert.rejects(b.start(), e => {
      assert.match(String(e), /Could not connect to Browser Use Cloud/);
      assert.doesNotMatch(String(e), /secret.invalid/);
      return true;
    });
    assert.equal(stops, 1);
    assert.equal(localLaunches, 0);
    assert.equal(b.running, false);
  } finally {
    chromium.connectOverCDP = connect;
    chromium.launchPersistentContext = launch;
    rmSync(home, { recursive: true, force: true });
  }
});

test('no key: the free hosted service is the default, registers once and keeps the token private', async () => {
  const home = mkdtempSync(join(tmpdir(), 'instinct-hosted-'));
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('INSTINCT_') || key === 'BROWSER_USE_API_KEY') delete process.env[key];
    process.env.INSTINCT_HOME = home;
    process.env.INSTINCT_HOSTED_URL = 'https://hosted.example';
    const cfg = loadConfig();
    assert.equal(cfg.browserUse?.hostedUrl, 'https://hosted.example');
    assert.equal(cfg.browserUse?.apiKey, undefined);
    assert.equal(cfg.cookieSync, false);
    const calls: string[] = [];
    const request: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      calls.push(init!.method + ' ' + u.pathname + ' ' + ((init!.headers as any)?.authorization ?? ''));
      if (u.pathname === '/v1/installs') return Response.json({ id: 'in_1', token: 'ik_secret' });
      if (u.pathname === '/v1/browsers') {
        assert.deepEqual(JSON.parse(String(init!.body)), { proxyCountry: 'br', timeoutMinutes: 30 });
        return Response.json({ id: 'b1', cdpUrl: 'wss://example.invalid/cdp', liveUrl: 'https://live.example/b1' });
      }
      return Response.json({ ok: true });
    };
    const cloud = new BrowserUseCloud(cfg, request);
    assert.equal(cloud.hosted, true);
    assert.equal((await cloud.start()).liveUrl, 'https://live.example/b1');
    await cloud.stop();
    await new BrowserUseCloud(cfg, request).start();
    assert.deepEqual(calls, ['POST /v1/installs ', 'POST /v1/browsers Bearer ik_secret', 'PATCH /v1/browsers/b1 Bearer ik_secret', 'POST /v1/browsers Bearer ik_secret']);
    assert.equal(statSync(join(home, 'hosted.json')).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(join(home, 'hosted-browser.json'), 'utf8'), /secret|wss/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(home, { recursive: true, force: true });
  }
});

test('hosted limits come back as a clear message with a way out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'instinct-hosted-'));
  const cfg = { ...loadConfig(), home, browserUse: { hostedUrl: 'https://hosted.example', proxyCountry: 'br', timeoutMinutes: 30 } };
  writeFileSync(join(home, 'hosted.json'), JSON.stringify({ url: 'https://hosted.example', token: 'ik_x' }));
  const request: typeof fetch = async () => Response.json({ error: 'install_quota', message: 'Daily free limit reached (60 browser minutes).' }, { status: 429 });
  try {
    await assert.rejects(new BrowserUseCloud(cfg, request).start(), (e: Error) => {
      assert.match(e.message, /Daily free limit reached/);
      assert.match(e.message, /local/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('config.json fills settings the environment does not set', () => {
  const home = mkdtempSync(join(tmpdir(), 'instinct-file-'));
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('INSTINCT_') || key === 'BROWSER_USE_API_KEY') delete process.env[key];
    process.env.INSTINCT_HOME = home;
    process.env.INSTINCT_PROXY_COUNTRY = 'us';
    writeFileSync(join(home, 'config.json'), JSON.stringify({ INSTINCT_BROWSER_PROVIDER: 'local', INSTINCT_PROXY_COUNTRY: 'pt', PATH: '/evil' }));
    const cfg = loadConfig();
    assert.equal(cfg.browserUse, undefined);
    assert.equal(process.env.INSTINCT_PROXY_COUNTRY, 'us');
    assert.notEqual(process.env.PATH, '/evil');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(home, { recursive: true, force: true });
  }
});


test('cloud selection requires a key; saved key selects cloud without automatic cookie export', () => {
  const home = mkdtempSync(join(tmpdir(), 'instinct-config-'));
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('INSTINCT_') || key === 'BROWSER_USE_API_KEY') delete process.env[key];
    process.env.INSTINCT_HOME = home;
    process.env.INSTINCT_BROWSER_PROVIDER = 'browser-use';
    assert.throws(loadConfig, /requires BROWSER_USE_API_KEY/);
    writeFileSync(join(home, 'browser-use.key'), 'test-key', { mode: 0o600 });
    delete process.env.INSTINCT_BROWSER_PROVIDER;
    assert.equal(loadConfig().browserUse?.apiKey, 'test-key');
    assert.equal(loadConfig().cookieSync, false);
    assert.equal(loadConfig().browserIdleMinutes, 5);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(home, { recursive: true, force: true });
  }
});
