import test from 'node:test';
import assert from 'node:assert/strict';
import { BottomFollower } from '../../client/src/master/follow-bottom.js';

/** A timeline that clamps its scroll position like a browser does. */
function box(scrollHeight: number, clientHeight = 500) {
  let top = 0;
  return {
    scrollHeight, clientHeight,
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.min(Math.max(0, value), Math.max(0, this.scrollHeight - this.clientHeight)); },
  };
}

test('a timeline that has just opened shows the latest, even while its content is still being laid out', () => {
  const follower = new BottomFollower();
  const timeline = box(4000);
  follower.reset();
  follower.resized(timeline);
  assert.equal(timeline.scrollTop, 3500, 'opens on the latest, not at the top');
  // Markdown and cards settle after the first paint and make the conversation taller.
  timeline.scrollHeight = 4800;
  follower.resized(timeline);
  assert.equal(timeline.scrollTop, 4300, 'still on the latest, not left in the middle');
});

test('a timeline that opens before the conversation arrives still ends on the latest', () => {
  const follower = new BottomFollower();
  const timeline = box(300);
  follower.reset();
  follower.resized(timeline);
  timeline.scrollHeight = 6000;
  follower.entriesChanged(timeline, 'first');
  assert.equal(timeline.scrollTop, 5500);
});

test('new messages and streaming text follow the latest while the owner is there', () => {
  const follower = new BottomFollower();
  const timeline = box(2000);
  follower.reset(); follower.resized(timeline);
  timeline.scrollHeight = 2300;
  follower.entriesChanged(timeline, 'first');
  assert.equal(timeline.scrollTop, 1800);
  // The browser reports the scroll the follower made; that does not count as the owner leaving.
  follower.scrolled(timeline);
  timeline.scrollHeight = 2600;
  follower.scrolled(timeline);
  follower.entriesChanged(timeline, 'first');
  assert.equal(timeline.scrollTop, 2100);
});

test('the owner reading earlier messages is not pulled down by new ones', () => {
  const follower = new BottomFollower();
  const timeline = box(3000);
  follower.reset(); follower.resized(timeline);
  timeline.scrollTop = 2470; follower.scrolled(timeline);
  assert.equal(follower.following, false, 'even a small move up leaves the latest');
  timeline.scrollTop = 1200; follower.scrolled(timeline);
  timeline.scrollHeight = 3400;
  follower.entriesChanged(timeline, 'first');
  follower.resized(timeline);
  assert.equal(timeline.scrollTop, 1200, 'stays where the owner is reading');
  // Scrolling back down near the end follows again.
  timeline.scrollTop = 2870; follower.scrolled(timeline);
  assert.equal(follower.following, true);
  timeline.scrollHeight = 3600;
  follower.resized(timeline);
  assert.equal(timeline.scrollTop, 3100);
});

test('sending a message shows the latest again', () => {
  const follower = new BottomFollower();
  const timeline = box(3000);
  follower.reset(); follower.resized(timeline);
  timeline.scrollTop = 100; follower.scrolled(timeline);
  follower.follow(timeline);
  assert.equal(timeline.scrollTop, 2500);
  timeline.scrollHeight = 3200;
  follower.entriesChanged(timeline, 'first');
  assert.equal(timeline.scrollTop, 2700);
});

test('earlier entries added above keep what is on screen in place', () => {
  const follower = new BottomFollower();
  const timeline = box(3000);
  follower.reset(); follower.resized(timeline);
  timeline.scrollTop = 0; follower.scrolled(timeline);
  follower.keepPlace(timeline, 'first');
  // A resize before the page arrives does not move the owner.
  follower.resized(timeline);
  assert.equal(timeline.scrollTop, 0);
  timeline.scrollHeight = 5000;
  follower.entriesChanged(timeline, 'older');
  assert.equal(timeline.scrollTop, 2000, 'the entry that was at the top is still there');
  timeline.scrollHeight = 5200;
  follower.entriesChanged(timeline, 'older');
  assert.equal(timeline.scrollTop, 2000, 'later changes do not reuse the kept place');
});

test('a short conversation that grows while shown keeps following', () => {
  const follower = new BottomFollower();
  const timeline = box(300);
  follower.reset(); follower.resized(timeline);
  follower.scrolled(timeline);
  assert.equal(follower.following, true);
  timeline.scrollHeight = 900;
  follower.entriesChanged(timeline, 'first');
  assert.equal(timeline.scrollTop, 400);
});
