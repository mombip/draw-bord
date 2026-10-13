import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multipart, syncAction, type DriveFile } from './drive.ts';

const remote: DriveFile = { id: 'f', name: 'board.svg', modifiedTime: '2026-10-13T10:00:00.000Z', version: '7' };
const older = Date.parse(remote.modifiedTime) - 1000, newer = Date.parse(remote.modifiedTime) + 1000;

test('no synced board yet: push ours', () => {
  assert.equal(syncAction(undefined, '', false, newer), 'push');
  assert.equal(syncAction(undefined, '7', false, newer), 'push'); // trashed since we last saw it
});

test('Drive unchanged since we last saw it: push only unsent edits', () => {
  assert.equal(syncAction(remote, '7', false, newer), 'none');
  assert.equal(syncAction(remote, '7', true, newer), 'push');
});

test('changed elsewhere and nothing unsent here: pull', () => {
  assert.equal(syncAction(remote, '6', false, newer), 'pull');
});

test('first connect, or unsent edits against a changed Drive copy: newer wins', () => {
  assert.equal(syncAction(remote, '', false, older), 'pull');
  assert.equal(syncAction(remote, '', false, newer), 'push');
  assert.equal(syncAction(remote, '', false, 0), 'pull'); // never drew in this browser
  assert.equal(syncAction(remote, '6', true, older), 'pull');
  assert.equal(syncAction(remote, '6', true, newer), 'push');
});

test('multipart upload body', () => {
  assert.equal(multipart({ name: 'a.svg' }, '<svg/>', 'B'),
    '--B\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"a.svg"}\r\n'
    + '--B\r\nContent-Type: image/svg+xml\r\n\r\n<svg/>\r\n--B--');
});
