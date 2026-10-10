/**
 * /history: staff see a user's past tickets and stored transcripts, limited to
 * the ticket types they handle; transcript access is written to the log.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = 'sqlite::memory:';
const db = require('../src/database');
const { TicketClient } = require('../src/client');
const { historyScope, buildHistoryPage, buildTicketDetail, sendTranscript } = require('../src/utils/history');

const GUILD  = 'g1';
const PLAYER = '111111111111111111';

// Real staff rules, no discord.js client.
const client = Object.create(TicketClient.prototype);
client.config = {
  mainColor: '#5eb131',
  logs: true,
  logsChannelId: 'logs',
  rolesWhoHaveAccessToTheTickets: ['global'],
  ticketTypes: [
    { codeName: 'general', name: 'General', emoji: '💬', staffRoles: [] },
    { codeName: 'tech',    name: 'Tech',    emoji: '🛠️', staffRoles: ['tech'] },
  ],
};
client.t = (key, vars = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), key);
client.logger = { info() {}, warn() {} };

const member = (roles) => ({ permissions: { has: () => false }, roles: { cache: new Set(roles) } });
const player = { id: PLAYER, username: 'player' };

let ids;
test.before(async () => {
  await db.initDatabase();
  ids = {};
  for (const [channelId, type] of [['h1', 'general'], ['h2', 'tech'], ['h3', 'tech'], ['h4', 'removedtype']]) {
    await db.createTicket({ channelId, guildId: GUILD, creatorId: PLAYER, type });
    ids[channelId] = (await db.getTicketByChannel(channelId)).id;
  }
  await db.closeTicket('h2', 'staff1', 'fixed <@&999> **bold**', '<html>tech transcript</html>');
  await db.addRating(ids.h2, PLAYER, 4, 'thanks');
  await db.addNote(ids.h2, 'staff1', 'checked the logs');
  // Another guild's ticket must never show up.
  await db.createTicket({ channelId: 'other', guildId: 'g2', creatorId: PLAYER, type: 'general' });
});
test.after(async () => { await db.closeDatabase(); });

test('historyScope follows the staff rules, including removed types', () => {
  assert.deepEqual(historyScope(client, member(['tech'])), {
    allowedTypes: ['tech'], includeOtherTypes: false, configuredTypes: ['general', 'tech'],
  });
  assert.deepEqual(historyScope(client, member(['global'])), {
    allowedTypes: ['general'], includeOtherTypes: true, configuredTypes: ['general', 'tech'],
  });
});

test('tech staff only see tech tickets', async () => {
  const { total, rows } = await db.getTicketHistory(PLAYER, GUILD, historyScope(client, member(['tech'])));
  assert.equal(total, 2);
  assert.deepEqual(rows.map(r => r.type), ['tech', 'tech']);
  assert.equal(rows.find(r => r.id === ids.h2).rating, 4);
  assert.equal(Number(rows.find(r => r.id === ids.h2).has_transcript), 1);
});

test('global staff see general tickets and tickets of removed types, not tech', async () => {
  const { total, rows } = await db.getTicketHistory(PLAYER, GUILD, historyScope(client, member(['global'])));
  assert.equal(total, 2);
  assert.deepEqual(rows.map(r => r.type).sort(), ['general', 'removedtype']);
});

test('a member with no staff role sees nothing', async () => {
  const { total } = await db.getTicketHistory(PLAYER, GUILD, historyScope(client, member([])));
  assert.equal(total, 0);
});

test('the list page has one transcript button per ticket, disabled without a transcript', async () => {
  const view = await buildHistoryPage(client, member(['tech']), GUILD, player, 0);
  const fields = view.embeds[0].data.fields;
  assert.equal(fields.length, 2);
  const buttons = view.components[0].components.map(b => b.data);
  assert.deepEqual(buttons.map(b => b.custom_id).sort(), [`tb_histTranscript:${ids.h2}`, `tb_histTranscript:${ids.h3}`].sort());
  assert.equal(buttons.find(b => b.custom_id.endsWith(`:${ids.h3}`)).disabled, true);
  assert.equal(buttons.find(b => b.custom_id.endsWith(`:${ids.h2}`)).disabled, false);
  assert.equal(view.components.length, 1, 'no paging row for a single page');
  // Close reasons are shown escaped, and nothing in the reply can ping.
  assert.match(fields.find(f => f.name.startsWith(`#${ids.h2}`)).value, /\\\*\\\*bold\\\*\\\*/);
  assert.deepEqual(view.allowedMentions.parse, []);
});

test('the detail view refuses tickets of a type the member does not handle', async () => {
  assert.equal(await buildTicketDetail(client, member(['global']), GUILD, ids.h2), null);
  assert.equal(await buildTicketDetail(client, member(['tech']), 'g2', ids.h2), null, 'other guild');
  const detail = await buildTicketDetail(client, member(['tech']), GUILD, ids.h2);
  const names = detail.embeds[0].data.fields.map(f => f.name);
  assert.ok(names.includes('history.notes'));
  assert.ok(names.includes('history.rating'));
});

function transcriptInteraction(roles) {
  const calls = { replies: [], logs: [] };
  return {
    calls,
    guildId: GUILD,
    member: member(roles),
    user: { id: '222222222222222222', tag: 'staff#0' },
    guild: { channels: { fetch: async () => ({ send: async (p) => { calls.logs.push(p); } }) } },
    reply: async (p) => { calls.replies.push(p); },
  };
}

test('sending a transcript gives the file to the staff member and logs the access', async () => {
  const i = transcriptInteraction(['tech']);
  await sendTranscript(client, i, ids.h2);
  assert.equal(i.calls.replies.length, 1);
  assert.equal(i.calls.replies[0].files.length, 1);
  assert.equal(i.calls.logs.length, 1);
  assert.match(i.calls.logs[0].content, /history\.accessLog/);
});

test('out-of-scope or missing transcripts are refused without a log entry', async () => {
  const outOfScope = transcriptInteraction(['global']);
  await sendTranscript(client, outOfScope, ids.h2);
  assert.match(outOfScope.calls.replies[0].content, /history\.notFound/);
  assert.equal(outOfScope.calls.logs.length, 0);

  const none = transcriptInteraction(['tech']);
  await sendTranscript(client, none, ids.h3);
  assert.match(none.calls.replies[0].content, /history\.noTranscript/);
  assert.equal(none.calls.logs.length, 0);
});

test('more than one page adds previous/next buttons and clamps out-of-range pages', async () => {
  const busy = { id: '333333333333333333', username: 'busy' };
  for (let i = 0; i < 7; i++) {
    await db.createTicket({ channelId: `p${i}`, guildId: GUILD, creatorId: busy.id, type: 'general' });
  }
  const first = await buildHistoryPage(client, member(['global']), GUILD, busy, 0);
  assert.equal(first.embeds[0].data.fields.length, 5);
  const nav = first.components[1].components.map(b => b.data);
  assert.equal(nav[0].disabled, true, 'no previous on page 1');
  assert.equal(nav[1].custom_id, `tb_histPage:${busy.id}:1`);

  const last = await buildHistoryPage(client, member(['global']), GUILD, busy, 99);
  assert.equal(last.embeds[0].data.fields.length, 2, 'clamped to the last page');
  assert.match(last.embeds[0].data.footer.text, /history\.footer/);
});
