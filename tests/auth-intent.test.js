const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.join(__dirname, '..', 'lib', 'auth-intent.js');
const { saveAuthIntent, consumeAuthIntent } = require(modulePath);

test('auth intent persists the protected destination for guest users', async () => {
  const nextPath = '/plan?product=chair-42&ar=1';
  saveAuthIntent(nextPath);

  assert.equal(consumeAuthIntent(), nextPath);
});

test('auth intent is cleared after it is consumed', async () => {
  saveAuthIntent('/account');
  assert.equal(consumeAuthIntent(), '/account');
  assert.equal(consumeAuthIntent(), null);
});
