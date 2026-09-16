import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { deliver, register } from '../src/ws-broadcast.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  messages = [];

  send(message) {
    this.messages.push(JSON.parse(message));
  }
}

test('targeted playback events reach only the requesting client', () => {
  const requester = new FakeSocket();
  const observer = new FakeSocket();
  register(requester, 'ios-client');
  register(observer, 'mac-client');

  assert.equal(deliver('dj-tts-ready', { ttsUrl: '/tts/intro.mp3' }, {
    clientId: 'ios-client',
  }), true);
  assert.deepEqual(requester.messages.map(message => message.type), ['dj-tts-ready']);
  assert.deepEqual(observer.messages, []);

  requester.emit('close');
  observer.emit('close');
});

test('a reconnect replaces the stale socket for one client ID', () => {
  const stale = new FakeSocket();
  const current = new FakeSocket();
  register(stale, 'desktop-client');
  register(current, 'desktop-client');

  deliver('dj-response', { say: 'one copy' }, { clientId: 'desktop-client' });
  assert.deepEqual(stale.messages, []);
  assert.deepEqual(current.messages.map(message => message.say), ['one copy']);

  current.emit('close');
});

test('a missing targeted client is buffered for reconnect without leaking to other devices', () => {
  const observer = new FakeSocket();
  register(observer, 'mac-client');

  assert.equal(deliver('dj-response', { firstTrack: { title: 'First' } }, {
    clientId: 'disconnected-ios-client',
  }), false);
  assert.deepEqual(observer.messages, []);

  const reconnectedRequester = new FakeSocket();
  register(reconnectedRequester, 'disconnected-ios-client');
  assert.deepEqual(reconnectedRequester.messages.map(message => message.type), ['dj-response']);

  observer.emit('close');
  reconnectedRequester.emit('close');
});

test('untargeted system events still broadcast to every connected client', () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  register(first, 'first-client');
  register(second, 'second-client');

  assert.equal(deliver('notification', { title: 'Ready' }), true);
  assert.deepEqual(first.messages.map(message => message.type), ['notification']);
  assert.deepEqual(second.messages.map(message => message.type), ['notification']);

  first.emit('close');
  second.emit('close');
});
