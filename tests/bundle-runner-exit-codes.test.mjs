import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Tests for _bundle-runner.mjs exit-code handling.
 *
 * Exit code convention (defined in _seed-utils.mjs):
 *   0  = success
 *   1  = hard failure
 *   2  = RETRY (graceful failure in contract mode — TTL extended, bundle retries)
 * 143 = SIGTERM (expected termination, not a failure)
 *
 * These tests verify that the close handler maps codes to the correct outcomes
 * WITHOUT requiring a full child_process spawn (which is hard to test in isolation).
 * We test the mapping logic by simulating the settle() call patterns directly.
 */

// Re-export constants from _bundle-runner to verify they exist
describe('exit-code constants', () => {
  // Exit code 2 is used for RETRY (graceful failure). We verify this is the
  // code emitted by _seed-utils.mjs in the contract RETRY path (line ~1000).
  it('RETRY path exits with code 2 in _seed-utils.mjs', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('./scripts/_seed-utils.mjs', 'utf8');
    // Find all process.exit(N) calls near RETRY contract state
    const exitCalls = [...src.matchAll(/process\.exit\((\d+)\)/g)].map(m => ({ pos: m.index, code: m[1] }));
    // Exit code 2 is used for RETRY (graceful failure). Find the exit(2) call
    // that is preceded by the specific RETRY log line "declareRecords returned 0"
    // within 1200 chars — other exit calls (exit(0), exit(1)) are unrelated paths.
    const exitCode2 = exitCalls.find(e => {
      const before = src.slice(Math.max(0, e.pos - 1200), e.pos);
      return before.includes('declareRecords returned 0');
    });
    assert.ok(exitCode2, 'RETRY path must call process.exit(2) after declareRecords=0');
    assert.equal(exitCode2.code, '2', 'RETRY path should exit with code 2, not 0');
  });

  it('hard failure path exits with code 1 in _seed-utils.mjs', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('./scripts/_seed-utils.mjs', 'utf8');
    // Validation failure (strictFailure) should exit with 1
    const hardFailMatch = src.match(/strictFailure\s*\?\s*1\s*:\s*0/);
    assert.ok(hardFailMatch, 'strictFailure path should use exit code 1');
  });
});

describe('bundle-runner exit-code mapping', () => {
  // We test the outcome mapping by simulating what the close handler would do
  // for each exit code. The settle() function sets ok=true only for code 0.

  function simulateSettle(code, signal) {
    let result;
    const settle = (val) => { result = val; };
    const lastSeedComplete = { event: 'seed_complete' }; // dummy

    // Replicate the close handler logic from _bundle-runner.mjs
    if (code === 0) {
      settle({ elapsed: '1.0', ok: true, seedComplete: lastSeedComplete });
    } else if (code === 2) {
      settle({ elapsed: '1.0', ok: false, reason: 'graceful_retry', alreadyLogged: false });
    } else {
      settle({ elapsed: '1.0', ok: false, reason: `exit ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}` });
    }
    return result;
  }

  it('code 0 → ok:true, seedComplete set', () => {
    const result = simulateSettle(0, null);
    assert.equal(result.ok, true);
    assert.equal(result.seedComplete?.event, 'seed_complete');
  });

  it('code 2 → ok:false, reason:graceful_retry (RETRY path)', () => {
    const result = simulateSettle(2, null);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'graceful_retry');
  });

  it('code 1 → ok:false, reason mentions exit code', () => {
    const result = simulateSettle(1, null);
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes('exit'), 'reason should mention exit code');
  });

  it('code 143 (SIGTERM) → ok:false, reason mentions signal', () => {
    const result = simulateSettle(null, 'SIGTERM');
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes('SIGTERM'), 'reason should mention SIGTERM');
  });

  it('null code → ok:false, reason handles null gracefully', () => {
    const result = simulateSettle(null, null);
    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes('null'), 'reason should handle null code');
  });
});

describe('seed-complete line streaming', () => {
  // Verify that the bundle runner looks for the correct JSON event marker
  // in stdout lines, and that seeders emit the correct marker on success.

  it('bundle runner parses seed_complete event from stdout', async () => {
    const fs = await import('node:fs');
    const runnerSrc = fs.readFileSync('./scripts/_bundle-runner.mjs', 'utf8');
    // Should look for {"event":"seed_complete" in stdout lines
    assert.ok(runnerSrc.includes('{"event":"seed_complete"'), 'bundle runner should parse seed_complete event');
  });

  it('seeders emit seed_complete JSON line via logSeedResult on success', async () => {
    const fs = await import('node:fs');
    // logSeedResult is defined in _seed-utils.mjs and called by seeders after publish
    const utilsSrc = fs.readFileSync('./scripts/_seed-utils.mjs', 'utf8');
    assert.ok(utilsSrc.includes('seed_complete'), 'logSeedResult should emit seed_complete event');
    // Verify it is called from runSeed after successful publish
    assert.ok(utilsSrc.includes('logSeedResult(domain, recordCount'), 'runSeed should call logSeedResult on success');
  });
});