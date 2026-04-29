/**
 * Functional tests for LeadsService.registerInterest handler.
 * Tests the typed Convex mutation handle (not string-cast).
 * See: koala73/worldmonitor#3253
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeCtx(headers = {}) {
  const req = new Request('https://worldmonitor.app/api/leads/v1/register-interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  return { request: req, pathParams: {}, headers };
}

function validReq(overrides = {}) {
  return {
    email: 'early@example.com',
    source: 'waitlist',
    appVersion: '2.5.23',
    referredBy: undefined,
    ...overrides,
  };
}

let registerInterest;
let ApiError;

describe('LeadsService.registerInterest', () => {
  beforeEach(async () => {
    process.env.CONVEX_URL = 'https://fake-convex.cloud';
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.VERCEL_ENV = 'production';
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    const mod = await import('../server/worldmonitor/leads/v1/register-interest.ts');
    registerInterest = mod.registerInterest;
    const gen = await import('../src/generated/server/worldmonitor/leads/v1/service_server.ts');
    ApiError = gen.ApiError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  describe('Convex mutation', () => {
    it('calls Convex with typed mutation handle (not string-cast)', async () => {
      let capturedBody; // string | undefined;
      globalThis.fetch = async (url, options) => {
        if (typeof url === 'string' && url.includes('turnstile')) {
          return new Response(JSON.stringify({ success: true }));
        }
        if (typeof url === 'string' && url.includes('fake-convex')) {
          capturedBody = await (options?.body ?? '');
          return new Response(
            JSON.stringify({ status: 'success', value: { status: 'registered', referralCode: 'REF123' } }),
          );
        }
        if (typeof url === 'string' && url.includes('resend')) {
          return new Response(JSON.stringify({ id: 'msg_456' }));
        }
        return new Response('{}');
      };
      const res = await registerInterest(makeCtx(), validReq());
      assert.equal(res.status, 'registered');
      assert.equal(res.emailSent, true);
      // Typed call should NOT send the legacy string-cast form
      // Old: {mutationName:"registerInterest:register",args:{...}}
      // New: {path:"registerInterest/register",args:{...}} (typed Convex HTTP)
      assert.ok(
        !capturedBody?.includes('registerInterest:register'),
        'Should NOT use legacy string-cast mutation name',
      );
    });

    it('throws 503 when CONVEX_URL is missing', async () => {
      delete process.env.CONVEX_URL;
      globalThis.fetch = async (url) => {
        if (typeof url === 'string' && url.includes('turnstile')) {
          return new Response(JSON.stringify({ success: true }));
        }
        return new Response('{}');
      };
      await assert.rejects(
        () => registerInterest(makeCtx(), validReq()),
        (err) => err instanceof ApiError && err.statusCode === 503,
      );
    });
  });
});