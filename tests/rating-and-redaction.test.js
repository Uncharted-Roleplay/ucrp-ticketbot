/**
 * Only the ticket creator may rate a ticket, and database URLs never reach
 * logs or error messages with their password.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = 'sqlite::memory:';
const db = require('../src/database');
const { redactUrl, parseDatabaseUrl } = require('../src/database/url');
const rateButton = require('../src/components/buttons/rateTicket');

const GUILD = 'g1';

test.before(async () => { await db.initDatabase(); });
test.after(async () => { await db.closeDatabase(); });

function interaction(userId, ticketId) {
  const calls = { reply: [], modal: 0 };
  return {
    calls,
    customId: `tb_rate:5:${ticketId}`,
    user: { id: userId },
    reply: async (payload) => { calls.reply.push(payload); },
    showModal: async () => { calls.modal++; },
  };
}

const client = { t: (key) => key };

test('the creator gets the rating modal', async () => {
  await db.createTicket({ channelId: 'r1', guildId: GUILD, creatorId: 'creator', type: 'support' });
  const ticket = await db.getTicketByChannel('r1');

  const i = interaction('creator', ticket.id);
  await rateButton.execute(client, i);

  assert.equal(i.calls.modal, 1);
  assert.equal(i.calls.reply.length, 0);
});

test('anyone else is refused', async () => {
  await db.createTicket({ channelId: 'r2', guildId: GUILD, creatorId: 'creator', type: 'support' });
  const ticket = await db.getTicketByChannel('r2');

  const i = interaction('staffer', ticket.id);
  await rateButton.execute(client, i);

  assert.equal(i.calls.modal, 0);
  assert.equal(i.calls.reply[0].content, 'messages.onlyCreatorCanRate');
});

test('redactUrl masks the password and nothing else', () => {
  assert.equal(redactUrl('postgres://bot:s3cr%40t@127.0.0.1:5432/tickets'), 'postgres://bot:***@127.0.0.1:5432/tickets');
  assert.equal(redactUrl('postgres://bot:pa/ss@host/db'), 'postgres://bot:***@host/db');
  assert.equal(redactUrl('postgres://host:5432/db'), 'postgres://host:5432/db');
  assert.equal(redactUrl('sqlite:./data/tickets.db'), 'sqlite:./data/tickets.db');
});

test('a malformed DATABASE_URL error does not contain the password', () => {
  assert.throws(
    () => parseDatabaseUrl('postgres://bot:hunter2@'),
    (err) => !err.message.includes('hunter2'),
  );
});
