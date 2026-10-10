/**
 * closeOption.deleteOnClose: after the normal close flow, the channel is
 * deleted after a countdown instead of being kept in a closed category; a
 * restart that drops the countdown is caught by the startup sweep.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub transcript generation (it walks a real channel's history).
const transcriptPath = path.resolve(__dirname, '../src/utils/transcript.js');
require.cache[transcriptPath] = {
  id: transcriptPath, filename: transcriptPath, loaded: true,
  exports: { generateTranscript: async () => '<html>transcript</html>' },
};

process.env.DATABASE_URL = 'sqlite::memory:';
process.env.MSK_API_KEY  = '';
const db = require('../src/database');
const {
  performClose,
  getDeleteOnCloseDelayMs,
  deleteLeftoverClosedChannels,
} = require('../src/utils/ticketActions');

const GUILD = 'g1';
let nextChannel = 1;

test.before(async () => { await db.initDatabase(); });
test.after(async () => { await db.closeDatabase(); });

test('getDeleteOnCloseDelayMs: off, default, clamped', () => {
  assert.equal(getDeleteOnCloseDelayMs({}), null);
  assert.equal(getDeleteOnCloseDelayMs({ deleteOnClose: false, deleteDelaySeconds: 5 }), null);
  assert.equal(getDeleteOnCloseDelayMs({ deleteOnClose: true }), 10_000);
  assert.equal(getDeleteOnCloseDelayMs({ deleteOnClose: true, deleteDelaySeconds: 0 }), 0);
  assert.equal(getDeleteOnCloseDelayMs({ deleteOnClose: true, deleteDelaySeconds: -5 }), 0);
  assert.equal(getDeleteOnCloseDelayMs({ deleteOnClose: true, deleteDelaySeconds: 99999 }), 3_600_000);
  assert.equal(getDeleteOnCloseDelayMs({ deleteOnClose: true, deleteDelaySeconds: 'x' }), 10_000);
});

function fakes(closeOption, ratingSystem = { enabled: false }) {
  const calls = { channelSends: [], dms: [], deleted: 0, parent: 0, renamed: 0 };
  const guild = {
    name: 'Test',
    channels: { fetch: async () => ({ send: async () => null }) },
    members: {
      fetch: async () => ({
        permissions: { has: () => false },
        roles: { cache: new Set() },
        user: { tag: 'creator#0', send: async (p) => { calls.dms.push(p); } },
      }),
    },
  };
  const channel = {
    name: 'ticket-creator',
    guild,
    messages: { fetch: async () => new Map() },
    send: async (p) => { calls.channelSends.push(p); },
    setParent: async () => { calls.parent++; },
    setName: async () => { calls.renamed++; },
    delete: async () => { calls.deleted++; },
    permissionOverwrites: { cache: new Map(), edit: async () => null },
  };
  const client = {
    user: { id: 'bot' },
    config: {
      closeOption: { createTranscript: false, dmUser: false, closeTicketCategoryId: 'closedcat', ...closeOption },
      ratingSystem,
      logs: false,
      ticketTypes: [],
    },
    t: (key, vars = {}) => `${key}${vars.seconds ? `:${vars.seconds}` : ''}`,
    locale: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ticketTypeOf: () => null,
    isStaff: () => false,
  };
  return { calls, channel, client };
}

async function openTicket(guildId = GUILD) {
  const channelId = `d${nextChannel++}`;
  await db.createTicket({ channelId, guildId, creatorId: 'creator', type: 'support' });
  return db.getTicketByChannel(channelId);
}

test('deleteOnClose deletes the channel after the countdown and skips the closed category', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ticket = await openTicket();
  const { calls, channel, client } = fakes({ deleteOnClose: true, deleteDelaySeconds: 10 });
  channel.id = ticket.channel_id;

  await performClose(client, channel, ticket, { id: 'staff1', tag: 'staff#0' }, 'done');

  assert.equal(calls.parent, 0);
  assert.equal(calls.renamed, 0);
  const closedMsg = calls.channelSends.find(p => String(p.content ?? '').startsWith('messages.ticketDeletingIn'));
  assert.ok(closedMsg, 'countdown message posted');
  assert.equal(closedMsg.content, 'messages.ticketDeletingIn:10');
  assert.equal(closedMsg.components, undefined, 'no delete/reopen buttons');
  assert.equal(calls.deleted, 0, 'not before the countdown');

  t.mock.timers.tick(10_000);
  await new Promise(resolve => setImmediate(resolve)); // let the timer's async body run
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.deleted, 1);
});

test('a ticket reopened during the countdown keeps its channel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ticket = await openTicket();
  const { calls, channel, client } = fakes({ deleteOnClose: true, deleteDelaySeconds: 30 });
  channel.id = ticket.channel_id;

  await performClose(client, channel, ticket, { id: 'staff1', tag: 'staff#0' }, null);
  await db.reopenTicket(ticket.channel_id);

  t.mock.timers.tick(30_000);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.deleted, 0);
});

test('with deleteOnClose the rating request goes by DM even if dmUser is off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ticket = await openTicket();
  const { calls, channel, client } = fakes(
    { deleteOnClose: true },
    { enabled: true, dmUser: false },
  );
  channel.id = ticket.channel_id;

  await performClose(client, channel, ticket, { id: 'staff1', tag: 'staff#0' }, null);

  assert.equal(calls.dms.length, 1, 'rating request sent by DM');
  assert.equal(calls.channelSends.some(p => p.components && String(p.content ?? '').includes('<@creator>')), false);
});

test('without deleteOnClose the channel is kept and moved as before', async () => {
  const ticket = await openTicket();
  const { calls, channel, client } = fakes({ deleteOnClose: false });
  channel.id = ticket.channel_id;

  await performClose(client, channel, ticket, { id: 'staff1', tag: 'staff#0' }, null);

  assert.equal(calls.parent, 1);
  assert.equal(calls.deleted, 0);
});

test('the startup sweep deletes overdue leftover channels only', async () => {
  // Own guild: tickets closed by the tests above must not count here.
  const SWEEP_GUILD = 'g-sweep';
  const overdue = await openTicket(SWEEP_GUILD);
  const running = await openTicket(SWEEP_GUILD);
  await db.closeTicket(overdue.channel_id, 'staff1', null, null);
  await db.closeTicket(running.channel_id, 'staff1', null, null);

  const deleted = [];
  const client = {
    config: { closeOption: { deleteOnClose: true, deleteDelaySeconds: 600 } },
    channels: {
      fetch: async (id) => ({ delete: async () => { deleted.push(id); } }),
    },
    t: (k) => k,
    logger: { info() {}, warn() {} },
  };

  // Pretend the first ticket was closed an hour ago: its 10-minute countdown is overdue.
  const realNow = Date.now;
  const closedAt = Number((await db.getTicketByChannel(overdue.channel_id)).closed_at);
  Date.now = () => closedAt + 3_600_000;
  try {
    // Re-close the second ticket "now" so it is still within its countdown.
    await db.closeTicket(running.channel_id, 'staff1', null, null);
    const n = await deleteLeftoverClosedChannels(client, SWEEP_GUILD);
    assert.equal(n, 1);
    assert.deepEqual(deleted, [overdue.channel_id]);
  } finally {
    Date.now = realNow;
  }

  // Off → nothing is touched.
  client.config.closeOption.deleteOnClose = false;
  assert.equal(await deleteLeftoverClosedChannels(client, SWEEP_GUILD), 0);
});
