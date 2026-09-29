import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from '../src/db.js';
import {
  redactText, scanForPII, piiReport, sanitizePagePath, rehydrateText, createRedactionContext,
} from '../src/pii.js';
import { createAssistant, createAssistantRouter, TOOLS, buildSystemPrompt } from '../src/assistant.js';

// ------------------------------------------------------------------------------------------------
// pii.js
// ------------------------------------------------------------------------------------------------
describe('redactText', () => {
  const cases = [
    'jane@example.com',
    'JANE.DOE@EXAMPLE.COM',
    'Jane.Doe+promo@Example.co.uk',
    "o'brien@mail.example.org",
    'first_last-99@sub.domain.io',
    'jane%40example.com',
    'jane.doe%2Bpromo%40example.com',
    'jane at example dot com',
  ];
  for (const c of cases) {
    test(`masks email form: ${c}`, () => {
      const r = redactText(`what about ${c}?`);
      assert.equal(r.count, 1, r.text);
      assert.match(r.text, /^what about \[EMAIL_1\]\?$/);
      assert.ok(!r.text.includes('@') && !/%40/i.test(r.text));
    });
  }

  test('same value -> same placeholder; map stays server-side', () => {
    const ctx = createRedactionContext();
    const a = redactText('a@x.com and A@X.COM and b@y.org', ctx);
    assert.equal(a.text, '[EMAIL_1] and [EMAIL_1] and [EMAIL_2]');
    assert.equal(ctx.map.get('[EMAIL_1]'), 'a@x.com');
    assert.equal(rehydrateText('see [EMAIL_2]', ctx), 'see b@y.org');
  });

  test('user ids, device ids, visitor ids, uuids, hex tokens, phones', () => {
    const r = redactText('u_8f3a91 d_77ab12 v_1234abcd 3f2504e0-4f89-11d3-9a0c-0305e82c3301 ' +
      'deadbeefdeadbeefdeadbeef call +1 (555) 123-4567 or 555.123.4567');
    assert.equal(r.text, '[USER_ID_1] [DEVICE_ID_1] [VISITOR_ID_1] [ID_1] [TOKEN_1] call [PHONE_1] or [PHONE_2]');
  });

  test('does not touch ordinary words, field names, dates, counts or pseudonyms', () => {
    const s = 'user_id visitor_id read_story app_open has_app signup 2026-08-01 1234 users sub_0123456789ab seg_ab12cd34 not_opened_in_days';
    assert.equal(redactText(s).text, s);
  });

  test('placeholders are idempotent', () => {
    const ctx = createRedactionContext();
    const once = redactText('jane@x.com u_12ab34', ctx).text;
    assert.equal(redactText(once, ctx).text, once);
  });

  test('piiReport counts by type', () => {
    assert.deepEqual(piiReport('a@b.co, u_12345a, c@d.io'), { total: 3, byType: { EMAIL: 2, USER_ID: 1 } });
  });
});

describe('scanForPII', () => {
  test('recursively redacts nested objects, arrays and keys and counts findings', () => {
    const input = {
      a: 'hello jane@x.com',
      nested: { list: ['ok', { deep: 'u_9a8b7c6d' }, 42, null, true], 'bob@y.com': 1 },
      keep: 'sub_0123456789ab',
    };
    const { value, count, byType } = scanForPII(input);
    assert.equal(count, 3);
    assert.deepEqual(byType, { EMAIL: 2, USER_ID: 1 });
    assert.equal(value.a, 'hello [EMAIL_1]');
    assert.equal(value.nested.list[1].deep, '[USER_ID_1]');
    assert.equal(value.nested['[EMAIL_2]'], 1);
    assert.equal(value.nested.list[2], 42);
    assert.equal(value.keep, 'sub_0123456789ab');
    assert.equal(input.a, 'hello jane@x.com', 'input not mutated');
  });

  test('skipKeys leaves opaque fields untouched but still counts', () => {
    const r = scanForPII({ signature: 'x@y.com', text: 'x@y.com' }, { skipKeys: ['signature'] });
    assert.equal(r.count, 2);
    assert.equal(r.value.signature, 'x@y.com');
    assert.equal(r.value.text, '[EMAIL_1]');
  });
});

describe('sanitizePagePath', () => {
  test('strips query strings / fragments / origins and masks ids', () => {
    assert.equal(sanitizePagePath('/welcome?email=jane%40example.com&utm_source=ig'), '/welcome');
    assert.equal(sanitizePagePath('https://thepourover.org/Subscribe/#top'), '/subscribe');
    assert.equal(sanitizePagePath('/u/jane%40example.com/prefs'), '/u/:redacted/prefs');
    assert.equal(sanitizePagePath('/unsubscribe/3f2504e0-4f89-11d3-9a0c-0305e82c3301'), '/unsubscribe/:redacted');
    assert.equal(sanitizePagePath('/story/123456'), '/story/:id');
    assert.equal(sanitizePagePath('/'), '/');
    assert.equal(sanitizePagePath(null), null);
  });
});

// ------------------------------------------------------------------------------------------------
// assistant tools against a real (in-memory) DB
// ------------------------------------------------------------------------------------------------
const PEOPLE = [
  // email, source, status, signup, last_open
  ['jane.doe+promo@example.com', 'instagram', 'active', '2026-08-03', '2026-08-10'],
  ['bob@example.org', 'instagram', 'active', '2026-08-15', null],
  ['carol@example.net', 'instagram', 'active', '2026-08-20', '2026-09-27'],
  ['dave@example.com', 'facebook', 'active', '2026-08-05', '2026-08-06'],
  ['erin@example.com', 'organic', 'unsubscribed', '2026-09-10', '2026-09-20'],
  ['frank@example.com', 'organic', 'active', '2026-09-15', '2026-09-26'],
];
const EMAILS = PEOPLE.map((p) => p[0]);
const RAW_IDS = ['u_1a2b3c', 'u_9f8e7d', 'd_55aa66', 'v_77cc88dd', 'v_1234abcd'];

function seed(db) {
  const insP = db.prepare(`INSERT INTO profiles (email, is_subscriber, signup_date, status, source, last_open_date, origin)
                           VALUES (?, 1, ?, ?, ?, ?, 'subscribers_csv')`);
  const ids = PEOPLE.map(([e, s, st, su, lo]) => Number(insP.run(e, su, st, s, lo).lastInsertRowid));
  db.prepare(`INSERT INTO app_users (user_id, email, created_date, profile_id, origin) VALUES (?, ?, ?, ?, 'app_users_csv')`)
    .run('u_1a2b3c', EMAILS[0], '2026-08-04', ids[0]);
  db.prepare(`INSERT INTO app_users (user_id, email, created_date, profile_id, origin) VALUES (?, ?, ?, ?, 'app_users_csv')`)
    .run('u_9f8e7d', EMAILS[2], '2026-08-21', ids[2]);
  db.prepare(`INSERT INTO devices (device_id, user_id, first_seen) VALUES ('d_55aa66', 'u_1a2b3c', '2026-08-04')`).run();
  const insE = db.prepare(`INSERT INTO app_events (event_id, event, user_id, device_id, ts, properties, resolved_user_id, profile_id)
                           VALUES (?, ?, ?, 'd_55aa66', ?, ?, ?, ?)`);
  let n = 0;
  for (const [ev, pid, uid, ts] of [['app_open', 0, 'u_1a2b3c', '2026-09-20T10:00:00Z'], ['read_story', 0, 'u_1a2b3c', '2026-09-21T10:00:00Z'],
    ['read_story', 2, 'u_9f8e7d', '2026-09-25T10:00:00Z'], ['link_click', 2, 'u_9f8e7d', '2026-09-26T10:00:00Z']]) {
    insE.run(`evt_${++n}`, ev, uid, ts, JSON.stringify({ note: `hi ${EMAILS[pid]}` }), uid, ids[pid]);
  }
  const insW = db.prepare(`INSERT INTO web_events (visitor_id, page, ts, utm_source, email, profile_id) VALUES (?, ?, ?, ?, ?, ?)`);
  insW.run('v_77cc88dd', '/welcome?email=jane.doe%2Bpromo%40example.com', '2026-08-03T09:00:00Z', 'instagram', EMAILS[0], ids[0]);
  insW.run('v_77cc88dd', '/story/faith-and-news', '2026-09-20T09:00:00Z', 'instagram', null, ids[0]);
  insW.run('v_1234abcd', '/u/bob%40example.org/prefs', '2026-08-15T09:00:00Z', 'bob@example.org', EMAILS[1], ids[1]);
  insW.run('v_1234abcd', '/subscribe', '2026-08-14T09:00:00Z', 'facebook', null, ids[1]);
  insW.run('v_anon1234', '/subscribe', '2026-09-26T09:00:00Z', null, null, null);
  insW.run('v_c4r0l123', '/subscribe?ref=ig', '2026-08-20T09:00:00Z', 'instagram', EMAILS[2], ids[2]);
  return ids;
}

/** Assert a serialized payload contains no real identifier from the fixture. */
function assertNoPII(json, label) {
  const lower = json.toLowerCase();
  for (const e of EMAILS) {
    assert.ok(!lower.includes(e), `${label}: leaked email ${e}`);
    assert.ok(!lower.includes(e.replace('@', '%40')), `${label}: leaked url-encoded email ${e}`);
    assert.ok(!lower.includes(e.split('@')[0] + '%2b'), `${label}: leaked encoded local part`);
  }
  for (const id of RAW_IDS) assert.ok(!json.includes(id), `${label}: leaked id ${id}`);
  assert.ok(!/[a-z0-9._%+-]+(@|%40)[a-z0-9-]+\.[a-z]{2,}/i.test(json), `${label}: email-shaped string`);
}

describe('assistant tools (what the model receives)', () => {
  const db = openTestDb();
  seed(db);
  const a = createAssistant({ db, client: null, today: '2026-09-28' });
  const run = (name, input, ctx) => a.runTool(name, input, ctx);

  test('system prompt and tool schemas carry no PII', () => {
    assertNoPII(buildSystemPrompt('2026-09-28'), 'system');
    assertNoPII(JSON.stringify(TOOLS), 'tools');
    assert.match(buildSystemPrompt('2026-09-28'), /2026-08 \(2026-08-01 to 2026-08-31\)/);
  });

  test('describe_data', () => {
    const r = run('describe_data', {});
    assert.equal(r.is_error, false, r.content);
    assertNoPII(r.content, 'describe_data');
    const v = JSON.parse(r.content);
    assert.equal(v.today, '2026-09-28');
    assert.equal(v.last_month.month, '2026-08');
    assert.ok(v.values.common_pages.some((p) => p.value === '/welcome'));
  });

  test('count_segment', () => {
    const r = run('count_segment', { spec: { source: ['instagram'], signup_after: '2026-08-01', signup_before: '2026-08-31', not_opened_in_days: 30 } });
    assert.equal(r.is_error, false, r.content);
    assert.deepEqual(JSON.parse(r.content), { total: 2 }); // jane (last open 08-10) + bob (never)
  });

  test('build_segment returns pseudonyms only, and the human table re-hydrates emails', () => {
    const r = run('build_segment', { spec: { sort: 'engagement_desc' }, name: 'Most engaged' });
    assert.equal(r.is_error, false, r.content);
    assertNoPII(r.content, 'build_segment');
    const v = JSON.parse(r.content);
    assert.match(v.handle, /^seg_[0-9a-f]{8}$/);
    assert.equal(v.total, PEOPLE.length);
    assert.ok(v.preview.length > 0 && v.preview.every((p) => /^sub_[0-9a-f]{12}$/.test(p.reader) && !('email' in p) && !('id' in p)));
    const t = a.segmentTable(v.handle);
    assert.equal(t.table.columns[0], 'email');
    assert.deepEqual(new Set(t.table.rows.map((row) => row[0])), new Set(EMAILS));
    const csv = a.segmentCsv(v.handle);
    for (const e of EMAILS) assert.ok(csv.includes(e));
  });

  test('aggregates', () => {
    const ctx = createRedactionContext();
    const kinds = {
      overview: {}, source_breakdown: {}, cold_by_source: {}, first_pages: { signup_after: '2026-08-01', signup_before: '2026-08-31' },
      page_popularity: { within_days: 0 }, app_event_types: {}, signup_trend: { by_source: true }, utm_breakdown: { within_days: 0 },
    };
    for (const [kind, params] of Object.entries(kinds)) {
      const r = run('aggregate', { kind, params }, ctx);
      assert.equal(r.is_error, false, `${kind}: ${r.content}`);
      assertNoPII(r.content, kind);
    }
    const cold = JSON.parse(run('aggregate', { kind: 'cold_by_source', params: { month: '2026-08' } }).content);
    assert.deepEqual(cold.rows.find((x) => x.source === 'instagram'), { source: 'instagram', cold: 2, signed_up: 3, cold_rate: 0.667 });
    const first = JSON.parse(run('aggregate', { kind: 'first_pages', params: { signup_after: '2026-08-01', signup_before: '2026-08-31' } }).content);
    assert.deepEqual(first.rows, [{ page: '/subscribe', readers: 2 }, { page: '/welcome', readers: 1 }]);
    // the email hidden in a utm_source value is caught by the output guard, and counted
    const utm = run('aggregate', { kind: 'utm_breakdown', params: { within_days: 0 } });
    assert.ok(utm.findings >= 1);
    assert.match(utm.content, /\[EMAIL_\d+\]/);
  });

  test('lookup_profile_summary via placeholder and via pseudonym; raw values rejected', () => {
    const ctx = createRedactionContext();
    const q = redactText('is JANE.DOE+promo@example.com still reading? also u_9f8e7d', ctx);
    assert.equal(q.text, 'is [EMAIL_1] still reading? also [USER_ID_1]');
    const r = run('lookup_profile_summary', { ref: '[EMAIL_1]' }, ctx);
    assertNoPII(r.content, 'lookup');
    const v = JSON.parse(r.content);
    assert.equal(v.found, true);
    assert.equal(v.source, 'instagram');
    assert.equal(v.has_app, true);
    assert.equal(v.app_events.total, 2);
    const byUser = JSON.parse(run('lookup_profile_summary', { ref: '[USER_ID_1]' }, ctx).content);
    assert.equal(byUser.found, true);
    const byToken = JSON.parse(run('lookup_profile_summary', { ref: v.reader }, ctx).content);
    assert.equal(byToken.reader, v.reader);
    const raw = run('lookup_profile_summary', { ref: 'jane.doe+promo@example.com' }, ctx);
    assert.equal(raw.is_error, true);
    assertNoPII(raw.content, 'raw ref error');
  });

  test('invalid spec returns a tool error, not a crash', () => {
    const r = run('count_segment', { spec: { bogus_key: 1 } });
    assert.equal(r.is_error, true);
  });
});

// ------------------------------------------------------------------------------------------------
// Full loop with a mocked Anthropic client
// ------------------------------------------------------------------------------------------------
function mockClient() {
  const requests = [];
  let turn = 0;
  let ph;
  const create = async (body) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    turn++;
    if (turn === 1) {
      ph = body.messages.at(-1).content.match(/\[EMAIL_\d+\]/)[0]; // the placeholder for the email in THIS question
      return { id: 'msg_1', model: body.model, stop_reason: 'tool_use', usage: {}, content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'toolu_1', name: 'describe_data', input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'lookup_profile_summary', input: { ref: ph } },
        { type: 'tool_use', id: 'toolu_3', name: 'build_segment', input: { spec: { source: ['instagram'], not_opened_in_days: 30 }, name: 'Cold Instagram' } },
      ] };
    }
    if (turn === 2) {
      return { id: 'msg_2', model: body.model, stop_reason: 'tool_use', usage: {}, content: [
        { type: 'tool_use', id: 'toolu_4', name: 'aggregate', input: { kind: 'first_pages', params: { signup_after: '2026-08-01', signup_before: '2026-08-31' } } },
      ] };
    }
    const last = body.messages.findLast((m) => m.role === 'user' && Array.isArray(m.content));
    const prev = body.messages.filter((m) => m.role === 'user' && Array.isArray(m.content))[0];
    const seg = JSON.parse(prev.content.find((c) => c.tool_use_id === 'toolu_3').content);
    assert.ok(last);
    return { id: 'msg_3', model: body.model, stop_reason: 'end_turn', usage: {}, content: [
      { type: 'text', text: `There are ${seg.total} cold Instagram readers (${seg.handle}). ${ph} is one of them.` },
    ] };
  };
  return { requests, messages: { create }, beta: { messages: { create } } };
}

describe('assistant loop (mocked model)', () => {
  test('no PII in anything sent to the model; human gets real emails; audit proves it', async () => {
    const db = openTestDb();
    seed(db);
    const client = mockClient();
    const a = createAssistant({ db, client, today: '2026-09-28', model: 'claude-sonnet-5-5' });
    const res = await a.ask({
      message: 'How many Instagram signups went cold? Also, is Jane.Doe+promo@Example.com one of them? her id is u_1a2b3c',
      history: [{ role: 'user', content: 'hi, I am bob@example.org' }, { role: 'assistant', content: 'Hello! How can I help?' }],
    });

    assert.equal(client.requests.length, 3);
    for (const [i, body] of client.requests.entries()) assertNoPII(JSON.stringify(body), `request ${i}`);
    assert.match(client.requests[0].messages.at(-1).content, /\[EMAIL_\d\].*\[USER_ID_1\]/s);
    assert.equal(client.requests[0].model, 'claude-sonnet-5-5');
    assert.equal(client.requests[0].system[0].cache_control.type, 'ephemeral');

    // the human view
    assert.match(res.answer, /jane\.doe\+promo@example\.com is one of them/i, 'placeholder re-hydrated for the human');
    assert.ok(res.segment && /^seg_/.test(res.segment.handle));
    assert.equal(res.segment.total, 2);
    assert.equal(res.table.columns[0], 'email');
    assert.deepEqual(new Set(res.table.rows.map((r) => r[0])), new Set(['jane.doe+promo@example.com', 'bob@example.org']));
    assert.deepEqual(res.trace.map((t) => t.tool), ['describe_data', 'lookup_profile_summary', 'build_segment', 'aggregate']);
    for (const t of res.trace) assertNoPII(t.output_summary, `trace ${t.tool}`);

    // the audit log
    const rep = a.auditReport();
    assert.equal(rep.summary.total_payloads, 3);
    assert.equal(rep.summary.emails_seen_by_model, 0);
    assert.equal(rep.summary.identifiers_seen_by_model, 0);
    assert.ok(rep.summary.payloads_with_findings_before_redaction >= 1);
    for (const r of db.prepare('SELECT payload FROM llm_audit').all()) assertNoPII(r.payload, 'audit row');
  });

  test('router returns 503 without an API key', async () => {
    const db = openTestDb();
    const a = createAssistant({ db, client: null });
    const router = createAssistantRouter(() => a);
    const layer = router.stack.find((l) => l.route?.path === '/' && l.route.methods.post);
    let status, body;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    await layer.route.stack[0].handle({ body: { message: 'hi' } }, res, (e) => { throw e; });
    assert.equal(status, 503);
    assert.match(body.error, /ANTHROPIC_API_KEY/);
  });
});
