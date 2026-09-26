/**
 * 0013: the daily model-expiry notice job (lib/model-notices.js).
 * One email per shop; a model is marked noticed only when its email went.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const notify = require('../lib/notify.js');
const { sendModelExpiryNotices } = require('../lib/model-notices.js');

const due = [
  { asset_id: 'a1', kind: 'glb', product_name: 'Rattan Chair', store_id: 's1', store_name: 'Shop One', idle_days: 336, deletable_from: '2026-10-26' },
  { asset_id: 'a2', kind: 'glb', product_name: 'Narra Table', store_id: 's1', store_name: 'Shop One', idle_days: 340, deletable_from: '2026-10-26' },
  { asset_id: 'a3', kind: 'glb', product_name: 'Bamboo Shelf', store_id: 's2', store_name: 'Shop Two', idle_days: 400, deletable_from: '2026-10-26' }
];

function fakeDeps({ deliver }) {
  const calls = { marked: [], emails: [] };
  const serverRpc = async (fn, args) => {
    if (fn === 'server_models_due_notice') return due;
    if (fn === 'server_store_contacts') {
      return { store_id: args.p_store, store_name: args.p_store === 's1' ? 'Shop One' : 'Shop Two',
        store_emails: args.p_store === 's1' ? ['one@shop.test'] : [] };
    }
    if (fn === 'server_mark_model_notice') { calls.marked.push(args.p_asset); return true; }
    throw new Error(`unexpected ${fn}`);
  };
  const fakeNotify = {
    accountMessages: notify.accountMessages,
    sendEmail: async message => {
      calls.emails.push(message);
      const to = (Array.isArray(message.to) ? message.to : [message.to]).filter(Boolean);
      return { sent: deliver && to.length > 0 };
    }
  };
  return { deps: { serverRpc, notify: fakeNotify }, calls };
}

test.before(() => { process.env.PAYMENT_RECORDER_SECRET = 'x'.repeat(40); });
test.after(() => { delete process.env.PAYMENT_RECORDER_SECRET; });

test('one email per shop, listing each of its models and the day each can be deleted', async () => {
  const { deps, calls } = fakeDeps({ deliver: true });
  const result = await sendModelExpiryNotices('https://furnishar.test', deps);
  assert.equal(result.due, 3);
  assert.equal(result.stores, 2);
  const shopOne = calls.emails.find(m => String(m.to) === 'one@shop.test');
  assert.match(shopOne.subject, /Keep 2 3D models at Shop One/);
  assert.deepEqual(shopOne.rows.map(r => r.label), ['Rattan Chair', 'Narra Table']);
  assert.match(shopOne.rows[0].value, /Can be deleted from/);
  assert.equal(shopOne.action.href, 'https://furnishar.test/portal#inventory');
  assert.ok(shopOne.lines.some(line => /Nothing is deleted automatically/.test(line)));
  assert.ok(shopOne.lines.some(line => /product, its measurements and its orders stay/.test(line)));
});

test('a model is marked noticed only when its shop\'s email actually went', async () => {
  const { deps, calls } = fakeDeps({ deliver: true });
  const result = await sendModelExpiryNotices('https://s', deps);
  // Shop Two has no address on file: nothing sent, so nothing marked — its
  // model stays NOT deletable rather than counting an email nobody got.
  assert.deepEqual(calls.marked.sort(), ['a1', 'a2']);
  assert.equal(result.emailed, 1);
  assert.equal(result.marked, 2);
});

test('with email down or unconfigured, nothing is marked', async () => {
  const { deps, calls } = fakeDeps({ deliver: false });
  const result = await sendModelExpiryNotices('https://s', deps);
  assert.deepEqual(calls.marked, []);
  assert.equal(result.marked, 0);
});

test('without the server secret the job does nothing', async () => {
  const saved = process.env.PAYMENT_RECORDER_SECRET;
  delete process.env.PAYMENT_RECORDER_SECRET;
  const { deps, calls } = fakeDeps({ deliver: true });
  assert.equal((await sendModelExpiryNotices('https://s', deps)).skipped, 'unconfigured');
  assert.equal(calls.emails.length, 0);
  process.env.PAYMENT_RECORDER_SECRET = saved;
});

test('a single model gets a singular subject', () => {
  const [message] = notify.accountMessages('model_expiry_notice',
    { store_emails: ['a@b.test'], store_name: 'Shop', models: [due[0]] }, 'https://s');
  assert.match(message.subject, /Keep the 3D model of Rattan Chair\?/);
  assert.match(message.heading, /A 3D model has not been used for 11 months/);
});
