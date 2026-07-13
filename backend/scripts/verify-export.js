#!/usr/bin/env node
/**
 * Offline verifier for clomp JSONL exports.
 *
 * Recomputes the hash chain and validates checkpoint signatures without any
 * access to the server — this is what an auditor runs against an export file.
 *
 * Usage: node scripts/verify-export.js <export.jsonl>
 * Exit code 0 = intact, 1 = broken or unreadable.
 */

const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const { canonicalize } = require('../src/canonical');
const { GENESIS_HASH, eventHash } = require('../src/hashchain');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/verify-export.js <export.jsonl>');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(file, 'utf8'),
    crlfDelay: Infinity
  });

  const eventsByTenant = new Map();
  const checkpoints = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.type === 'event') {
      if (!eventsByTenant.has(obj.tenant_id)) eventsByTenant.set(obj.tenant_id, []);
      eventsByTenant.get(obj.tenant_id).push(obj);
    } else if (obj.type === 'checkpoint') {
      checkpoints.push(obj);
    }
  }

  let ok = true;

  for (const [tenantId, events] of eventsByTenant) {
    events.sort((a, b) => a.sequence - b.sequence);
    let expectedPrev = events[0].sequence === 1 ? GENESIS_HASH : events[0].prev_hash;
    let expectedSeq = events[0].sequence;
    let verified = 0;

    for (const event of events) {
      if (event.sequence !== expectedSeq) {
        console.error(`✘ tenant ${tenantId}: sequence gap at ${expectedSeq}`);
        ok = false;
        break;
      }
      if (event.prev_hash !== expectedPrev) {
        console.error(`✘ tenant ${tenantId}: prev_hash mismatch at sequence ${event.sequence}`);
        ok = false;
        break;
      }
      if (eventHash(event.prev_hash, event) !== event.hash) {
        console.error(`✘ tenant ${tenantId}: hash mismatch at sequence ${event.sequence}`);
        ok = false;
        break;
      }
      expectedPrev = event.hash;
      expectedSeq++;
      verified++;
    }

    if (verified === events.length) {
      console.log(`✔ tenant ${tenantId}: ${verified} events verified, chain intact` +
        (events[0].sequence !== 1 ? ` (partial export starting at sequence ${events[0].sequence})` : ''));
    }

    // Checkpoints must match the exported events they point into.
    for (const cp of checkpoints.filter(c => c.tenant_id === tenantId)) {
      const payload = canonicalize({ tenant_id: cp.tenant_id, sequence: cp.sequence, hash: cp.hash, signed_at: cp.signed_at });
      const sigOk = crypto.verify(
        null,
        Buffer.from(payload, 'utf8'),
        crypto.createPublicKey(cp.public_key),
        Buffer.from(cp.signature, 'base64')
      );
      const referenced = events.find(e => e.sequence === cp.sequence);
      const hashOk = !referenced || referenced.hash === cp.hash;
      if (!sigOk || !hashOk) {
        console.error(`✘ tenant ${tenantId}: checkpoint at sequence ${cp.sequence} ${sigOk ? 'hash mismatch' : 'signature invalid'}`);
        ok = false;
      } else {
        console.log(`✔ tenant ${tenantId}: checkpoint at sequence ${cp.sequence} signed ${cp.signed_at} — signature valid`);
      }
    }
  }

  if (!eventsByTenant.size) {
    console.error('No events found in export');
    ok = false;
  }

  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('❌ Verify failed:', err.message);
  process.exit(1);
});
