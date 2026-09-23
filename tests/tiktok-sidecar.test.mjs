import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { normalizeTikTokEvent as normalize, attachTikTokEvents, safeCount } from '../sidecar/tiktok-events.mjs';

test('invalid or missing numeric fields are never manufactured as zero', () => {
  for (const n of [null, undefined, '', false, -1, Infinity, 'unknown', '9007199254740993']) assert.equal(safeCount(n), null);
  assert.equal(safeCount('0'), 0);
  assert.equal(normalize('like', { count: 1 }, 'r'), null);
  assert.equal(normalize('viewerCount', {}, 'r'), null);
});
test('installed protobuf v3 and legacy viewer/like fields are supported', () => {
  assert.equal(normalize('viewerCount', { total: '47', totalUser: '999' }, 'r').count, 47);
  assert.equal(normalize('viewerCount', { viewerCount: 47 }, 'r').count, 47);
  assert.equal(normalize('like', { count: 2, total: '12400' }, 'r').totalLikeCount, 12400);
  assert.equal(normalize('like', { likeCount: 2, totalLikeCount: 12400 }, 'r').totalLikeCount, 12400);
});
test('nested users retain chat author and stable event identity', () => {
  const event = normalize('chat', { content: 'hello', user: { id: '42', nickname: 'Viewer', displayId: 'viewer' }, common: { msgId: 'message', roomId: '9876543210987654321' } }, 'r');
  assert.equal(event.username, 'Viewer');
  assert.equal(event.roomId, '9876543210987654321');
  assert.equal(event.eventId, 'message');
});
test('cumulative gift streaks emit only final totals with stable group identity', () => {
  const gift = { user: { id: 'u' }, groupId: 'group', gift: { id: 'rose', type: 1, name: 'Rose', diamondCount: 1 }, repeatCount: 5 };
  assert.equal(normalize('gift', { ...gift, repeatEnd: 0 }, 'r'), null);
  const final = normalize('gift', { ...gift, repeatEnd: 1 }, 'r');
  assert.equal(final.repeatCount, 5);
  assert.equal(final.diamondCount, 1);
  assert.equal(final.giftName, 'Rose');
  assert.equal(final.eventId, normalize('gift', { ...gift, repeatEnd: true }, 'r').eventId);
  assert.equal(normalize('gift', { repeatCount: 1, giftDetails: { giftType: 0, giftName: 'Gift', diamondCount: 5 } }, 'r').diamondCount, 5);
});
test('real connector lifecycle names are subscribed once and fully detached', () => {
  const connection = new EventEmitter();
  connection.state = { roomId: 'room' };
  const received = [];
  const detach = attachTikTokEvents(connection, { WebcastEvent, ControlEvent }, e => received.push(e), () => 100);
  assert.equal(connection.eventNames().length, 9);
  for (const event of connection.eventNames()) assert.equal(connection.listenerCount(event), 1);
  connection.emit(ControlEvent.CONNECTED, connection.state);
  connection.emit(WebcastEvent.LIKE, { count: 1, total: '100' });
  connection.emit(WebcastEvent.FOLLOW, { user: { id: 'u' }, followCount: 500 });
  connection.emit(WebcastEvent.STREAM_END);
  assert.deepEqual(received.map(e => e.type), ['session', 'like', 'follow', 'session']);
  assert.equal(received[0].status, 'connected');
  assert.equal(received[2].followCount, undefined);
  assert.equal(received[3].status, 'ended');
  detach();
  assert.equal(connection.eventNames().length, 0);
});


test('MEMBER JOINED uses the nested viewer, never the operator or a subscription action', () => {
  const connection = new EventEmitter(), received = [];
  const detach = attachTikTokEvents(connection, { WebcastEvent, ControlEvent }, e => received.push(e));
  const payload = { action: 1, common: { msgId: 'join1', roomId: 'room' }, user: { id: '42', nickname: 'Juiste kijker', displayId: 'juiste_kijker' }, operator: { nickname: 'Verkeerde operator' } };
  connection.emit(WebcastEvent.MEMBER, payload);
  connection.emit(WebcastEvent.MEMBER, { ...payload, action: 3 });
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'join');
  assert.equal(received[0].username, 'Juiste kijker');
  assert.equal(received[0].uniqueId, 'juiste_kijker');
  assert.equal(received[0].userId, '42');
  assert.equal(received[0].eventId, 'join1');
  assert.equal(normalize('join', { action: 1, user: { displayId: 'handle' } }, 'room').username, 'handle');
  detach();
  assert.equal(connection.listenerCount(WebcastEvent.MEMBER), 0);
});

test('invalid member actions and nameless/malformed users are safely ignored', () => {
  for (const data of [null, {}, { action: 0, user: { nickname: 'Someone' } }, { action: 1 }, { action: 1, user: { nickname: {}, displayId: 5 } }]) {
    assert.equal(normalize('join', data, 'room'), null);
  }
});
