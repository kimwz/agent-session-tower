/** What the follower reads and moves: the master's timeline, or a stand-in for it in tests. */
export interface ScrollBox { scrollTop: number; readonly scrollHeight: number; readonly clientHeight: number }

/** Within this many pixels of the end, scrolling down counts as having come back to the latest. */
const NEAR_END = 48;
/** Rounding on scaled screens leaves the end a pixel or two short. */
const AT_END = 2;

/**
 * Keeps the timeline on its latest part while the owner is there, and leaves it where the owner put it once they have
 * scrolled up to read. A timeline that has just appeared starts at the latest; earlier entries added above keep what is
 * on screen in place.
 */
export class BottomFollower {
  following = true;
  private lastTop = 0;
  /** Distance from the end to keep while earlier entries are added above, and the first entry before they were. */
  private place: { fromEnd: number; first: string | undefined } | undefined;

  /** A timeline that has just been shown: start at the latest. */
  reset() { this.following = true; this.lastTop = 0; this.place = undefined; }

  /** Moving up leaves the latest; coming back near the end follows it again. */
  scrolled(box: ScrollBox) {
    const top = box.scrollTop;
    const fromEnd = box.scrollHeight - top - box.clientHeight;
    if (top < this.lastTop && fromEnd > AT_END) this.following = false;
    else if (fromEnd <= NEAR_END) this.following = true;
    this.lastTop = top;
  }

  /** The owner sent something: show the latest again. */
  follow(box?: ScrollBox) { this.following = true; if (box) this.toEnd(box); }

  /** Earlier entries are about to be added above `first`: keep what is on screen where it is. */
  keepPlace(box: ScrollBox, first: string | undefined) { this.place = { fromEnd: box.scrollHeight - box.scrollTop, first }; }

  /** After the entries changed, before they are painted. */
  entriesChanged(box: ScrollBox, first: string | undefined) {
    if (this.place && this.place.first !== first) {
      box.scrollTop = box.scrollHeight - this.place.fromEnd;
      this.lastTop = box.scrollTop;
      this.place = undefined;
      return;
    }
    if (this.following) this.toEnd(box);
  }

  /** Something in the timeline, or the timeline itself, changed size (text laid out, a card opened, the panel resized). */
  resized(box: ScrollBox) { if (this.following) this.toEnd(box); }

  private toEnd(box: ScrollBox) {
    box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
    this.lastTop = box.scrollTop;
  }
}
