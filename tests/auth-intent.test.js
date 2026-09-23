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

test('auth intent never stores a way off the site', async () => {
  const { saveAuthIntent: save, peekAuthIntent: peek } = require(modulePath);
  for (const trick of ['//evil.example', 'https://evil.example', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)']) {
    assert.equal(save(trick), null, `${JSON.stringify(trick)} must be refused`);
  }
  assert.equal(peek(), null);
});
