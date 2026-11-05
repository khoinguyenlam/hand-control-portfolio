// Hand cursor: turns hand frames into the mouse events the portfolio understands.
// Shared with the iPhone/iPad app, where it lives in HandControl-iOS/HandControl/HandBridge.swift;
// keep the two copies the same. Frames: {pts: {joint: [x, y]} mirrored and normalised, ar, gap (cm), edge}.
(() => {
if (window.__hand) return;
// colours follow the page's own accent (--tungsten), so the cursor matches whatever theme the page has
const css = document.createElement('style');
css.textContent = `#__handCursor{position:fixed;left:0;top:0;z-index:2147483647;width:30px;height:30px;margin:-15px 0 0 -15px;
  border-radius:50%;border:3px solid var(--tungsten,#c4741c);background:var(--tungsten-soft,rgba(196,116,28,.16));box-shadow:0 0 0 1px rgba(255,255,255,.9);
  pointer-events:none;opacity:0;transition:opacity .15s,width .15s,height .15s,margin .15s}
#__handCursor.on{opacity:1}#__handCursor.down{width:18px;height:18px;margin:-9px 0 0 -9px;background:var(--tungsten,#c4741c)}
#__handCursor.zoom{border-style:dashed}#__handCursor.edge{border-color:#d9483b;background:rgba(217,72,59,.16)}
#__handTarget{position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;border-radius:12px;opacity:0;
  box-shadow:0 0 0 3px var(--tungsten,#c4741c),0 0 0 6px var(--tungsten-soft,rgba(196,116,28,.25));transition:opacity .12s,transform .12s,width .12s,height .12s}
#__handTarget.on{opacity:1}
#__handTag{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;padding:4px 9px;border-radius:999px;
  background:var(--tungsten,#c4741c);color:#fff;font:600 12px/1.2 -apple-system,system-ui,sans-serif;white-space:nowrap;
  opacity:0;transition:opacity .15s}
#__handTag.on{opacity:1}`;
const cursor = document.createElement('div');
cursor.id = '__handCursor';
// outlines what a pinch would press right now
const outline = document.createElement('div');
outline.id = '__handTarget';
// a short label beside the cursor saying what the hand is doing (Click, Drag, Zoom, Scroll, Back)
const tag = document.createElement('div');
tag.id = '__handTag';
document.documentElement.append(css, outline, cursor, tag);
let tagUntil = 0;
function showTag(text, ms = 900) {
  if (tag.textContent !== text) tag.textContent = text;
  tag.classList.add('on'); tagUntil = performance.now() + ms;
}

// One Euro filter: steady when the hand is still, little lag when it moves fast
class OneEuro {
  constructor(minCutoff = 1, beta = .02, dCutoff = 1) { Object.assign(this, {minCutoff, beta, dCutoff, x: null, dx: 0, t: 0}); }
  static a(c, dt) { const r = 2 * Math.PI * c * dt; return r / (r + 1); }
  reset() { this.x = null; }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, (t - this.t) / 1000); this.t = t;
    this.dx = OneEuro.a(this.dCutoff, dt) * ((v - this.x) / dt) + (1 - OneEuro.a(this.dCutoff, dt)) * this.dx;
    const a = OneEuro.a(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    return this.x = a * v + (1 - a) * this.x;
  }
}
const fx = new OneEuro(.5, .03), fy = new OneEuro(.5, .03);
let cx = innerWidth / 2, cy = innerHeight / 2, pinched = false, pinchFrames = 0, downEl = null, anchor = null;
// grab: a pinch that began on empty space; moving the hand up or down then zooms the map or scrolls the
// panel under it, and letting go without moving is an ordinary click
let grab = null;
const history = [];

// Camera frames arrive ~30 times a second but the screen draws at 60 or 120: the drawn cursor (dx, dy)
// glides toward the latest target (cx, cy) on every screen frame instead of jumping once per camera frame,
// and the page gets its mouse moves at the same smooth rate.
let dx = cx, dy = cy, live = false, lastDraw = 0, frameNo = 0, target = null;
let camGap = .033, lastFrameAt = 0; // seconds between camera frames, averaged
const place = () => {
  cursor.style.transform = `translate3d(${dx}px,${dy}px,0)`;
  tag.style.transform = `translate3d(${Math.min(dx + 24, innerWidth - 90)}px,${dy + 18}px,0)`;
};
function showTarget(t) {
  target = t;
  if (!t) return outline.classList.remove('on');
  const r = t.el.getBoundingClientRect(), pad = 4;
  outline.style.transform = `translate3d(${r.left - pad}px,${r.top - pad}px,0)`;
  outline.style.width = r.width + 2 * pad + 'px'; outline.style.height = r.height + 2 * pad + 'px';
  outline.style.borderRadius = getComputedStyle(t.el).borderRadius || '12px';
  outline.classList.add('on');
}
function glide(now) {
  requestAnimationFrame(glide);
  const dt = Math.min(.05, (now - lastDraw) / 1000 || .016); lastDraw = now;
  if (now > tagUntil && tag.classList.contains('on')) tag.classList.remove('on');
  if (!live) { if (target) showTarget(null); return; }
  if (two) { scrollStep(dt); if (target) showTarget(null); }
  else if (++frameNo % 3 === 0 && !pinched) { // ~40 times a second is plenty
    // a steady outline: stay on the current target until the cursor is clearly off it, so it doesn't
    // flicker between neighbouring buttons as the hand trembles
    let keep = false;
    if (target?.el.isConnected) {
      const r = target.el.getBoundingClientRect();
      keep = dx > r.left - 12 && dx < r.right + 12 && dy > r.top - 12 && dy < r.bottom + 12;
    }
    showTarget(keep ? {el: target.el, c: [dx, dy]} : findTarget(dx, dy));
  }
  // sticky targets: over a button or marker the cursor moves more slowly, so small hand tremor
  // doesn't carry it off before the pinch
  // the chase takes about as long as the wait for the next camera frame, so a slow camera (or a slow computer)
  // gives one even glide rather than a dash and a stop on every frame
  const k = 1 - Math.exp(-dt / Math.max(target && !pinched ? .12 : .035, camGap * .8));
  const nx = dx + (cx - dx) * k, ny = dy + (cy - dy) * k;
  if (Math.abs(nx - dx) + Math.abs(ny - dy) < .2) return;
  dx = nx; dy = ny; place();
  fire('pointermove', dx, dy); fire('mousemove', dx, dy);
}
requestAnimationFrame(glide);

// reach follows the hand's size: about REACH palm-widths of camera image cover the screen,
// and that window slides along when the hand pushes past its edge
const REACH = 3.2;
let box = null, palmS = null, rebaseBox = false;
const P = (f, k) => [f.pts[k][0] * f.ar, f.pts[k][1]];
// The pointing spot: the middle of all five fingertips and the knuckles. Averaging takes out most of the
// shake of a grainy, dark picture, a finger the camera can't see barely shifts it, and it hardly moves as
// the thumb and index close in a pinch.
const SPOT_TIPS = ['thumbTip', 'indexTip', 'middleTip', 'ringTip', 'littleTip'], SPOT_KNUCKLES = ['indexMCP', 'middleMCP', 'littleMCP'];
const ptr = f => {
  const mean = (keys, axis) => keys.reduce((sum, k) => sum + P(f, k)[axis], 0) / keys.length;
  return [0, 1].map(axis => (mean(SPOT_TIPS, axis) + mean(SPOT_KNUCKLES, axis)) / 2);
};
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// The window must stay inside the camera's picture, or reaching a screen edge pulls the hand out of view.
// The pointing spot is mid-hand, with the fingers above it and the wrist below, so top and bottom margins match the hand.
const EDGE = {side: .06, top: .14, bottom: .18};
function updateBox(f) {
  const palm = d2(P(f, 'indexMCP'), P(f, 'littleMCP'));
  palmS = palmS === null ? palm : palmS + (palm - palmS) * .1;
  let hw = palmS * REACH, hh = hw * innerHeight / innerWidth;
  // a hand close to the camera would need a window bigger than the picture: shrink it to fit
  const fit = Math.min(1, (f.ar - 2 * EDGE.side) / (2 * hw), (1 - EDGE.top - EDGE.bottom) / (2 * hh));
  hw *= fit; hh *= fit;
  const [px, py] = ptr(f);
  if (!box) box = {x: px, y: py};
  // the new hand takes over from where the cursor already is, wherever in the picture that hand happens to be
  if ((f.switched || rebaseBox) && live) {
    rebaseBox = false;
    box.x = px - (dx / innerWidth - .5) * 2 * hw / OVERSCAN;
    box.y = py - (dy / innerHeight - .5) * 2 * hh / OVERSCAN;
  }
  box.x = Math.min(px + hw, Math.max(px - hw, box.x));
  box.y = Math.min(py + hh, Math.max(py - hh, box.y));
  box.x = Math.min(f.ar - EDGE.side - hw, Math.max(EDGE.side + hw, box.x));
  box.y = Math.min(1 - EDGE.bottom - hh, Math.max(EDGE.top + hh, box.y));
  box.hw = hw; box.hh = hh;
}
// Overscan: the screen's edges are reached a little inside the window's edges, so the corners never
// need the hand's full stretch (where it is closest to leaving the camera's view).
const OVERSCAN = 1.2;
const toScreen = ([x, y]) => [
  Math.min(1, Math.max(0, .5 + (x - box.x) / (2 * box.hw) * OVERSCAN)) * innerWidth,
  Math.min(1, Math.max(0, .5 + (y - box.y) / (2 * box.hh) * OVERSCAN)) * innerHeight];

function fire(type, x, y, extra) {
  const el = document.elementFromPoint(x, y); if (!el) return null;
  const o = {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
    isPrimary: true, button: 0, buttons: type === 'pointerup' || type === 'mouseup' ? 0 : pinched ? 1 : 0, ...extra};
  el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, o) : type === 'wheel' ? new WheelEvent(type, o) : new MouseEvent(type, o));
  return el;
}
// Click = a pinch, fired as the fingers open, on what was chosen as they started to close. Click is the default:
// a hand always drifts a little during a pinch, so a drag starts only when the pinch has been held a moment and
// the hand then moves well away, and keeps moving. Until then the cursor stays on the target. A very long pinch
// with no movement clicks nothing, so fingers resting together stay harmless.
const QUICK_MS = 1000, DRAG_AFTER_MS = 350, DRAG_PX = 45, DRAG_FRAMES = 3;
let press = null, pinchMin = 99;
// gesture trace for the app's diagnostic log; does nothing in a browser
const trace = m => { try { window.webkit?.messageHandlers?.handLog?.postMessage(m); } catch {} };
function clickAt(x, y) {
  fire('pointermove', x, y);
  const down = fire('pointerdown', x, y); fire('mousedown', x, y);
  // as a real click would, put the keyboard's focus on what was pressed (a search box, say)
  down?.closest?.('input,textarea,select,button,a[href],[tabindex],[contenteditable]')?.focus?.();
  const up = fire('pointerup', x, y); fire('mouseup', x, y);
  // as with a real mouse, the click lands on what press and release share
  let el = down; while (el && up && !el.contains(up)) el = el.parentElement;
  (el || up)?.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0}));
}
function release() {
  const now = performance.now();
  pinched = false; pinchFrames = 0; anchor = null; cursor.classList.remove('down', 'zoom');
  // a quick pinch that didn't drag, zoom or swipe is a click on what it pressed
  let quick = !!press && !press.dragging && !press.opened && now - press.t0 < QUICK_MS;
  if (grab) { if (grab.moved || grab.swiped) quick = false; grab = null; }
  if (downEl) { fire('pointerup', dx, dy); fire('mouseup', dx, dy); downEl = null; } // end of a drag
  trace(`release held=${press ? Math.round(now - press.t0) : -1} click=${quick} min=${pinchMin.toFixed(1)}`);
  if (quick) {
    // a target's live centre, so a marker that slid as the map moved still gets hit
    let [x, y] = press.c;
    if (press.el?.isConnected) {
      const r = press.el.getBoundingClientRect(), c = [r.left + r.width / 2, r.top + r.height / 2], top = document.elementFromPoint(...c);
      if (top && (press.el === top || press.el.contains(top))) [x, y] = c;
    }
    dx = x; dy = y; place();
    clickAt(x, y);
    showTag('Click', 600);
  }
  press = null;
  // opening the fingers shifts the hand a little too: hold still a moment so the cursor doesn't jump off
  aim = {x: dx, y: dy, t: now, until: 250, release: true};
  // pointing goes back from the knuckle to the whole hand: pick up from there without counting the switch as movement
  fx.reset(); fy.reset(); resync = true;
}

// Aim lock: a pinch starts well before it registers, and the fingertip slides toward the thumb on the
// way. As soon as the fingers are clearly closing, the cursor stops where it was pointing just before.
let aim = null, prevGap = null, prevT = 0;
let ax = null, ay = null, lastX = 0, lastY = 0, lastXT = 0, resync = false; // accelerated cursor, and the hand position it last saw
const gapHistory = [];
// Targets: the marker or button a pinch would press from here — the one under the cursor (pressed
// where the cursor is), or failing that the nearest within SNAP px (pressed at its centre).
const CLICKABLE = '.pin, button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [onclick], .thumb, .chip, summary, input, select, textarea, label';
const SNAP = 22;
function findTarget(x, y) {
  const hit = document.elementFromPoint(x, y), direct = hit && hit.closest(CLICKABLE);
  if (direct) return {el: direct, c: [x, y]};
  const all = document.querySelectorAll(CLICKABLE);
  // a page with very many links: checking each one this often would slow it down, so look around the cursor instead
  if (all.length > 300) {
    for (const r of [SNAP / 2, SNAP]) for (let a = 0; a < 8; a++) {
      const px = x + Math.cos(a * Math.PI / 4) * r, py = y + Math.sin(a * Math.PI / 4) * r;
      const el = document.elementFromPoint(px, py)?.closest(CLICKABLE);
      if (el) return {el, c: [px, py]};
    }
    return null;
  }
  let best = null, bestD = SNAP;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
    if (d < bestD) {
      const c = [r.left + r.width / 2, r.top + r.height / 2], top = document.elementFromPoint(...c);
      if (top && (el === top || el.contains(top))) { best = {el, c}; bestD = d; } // only what's actually on top there
    }
  }
  return best;
}
function scrollableAt(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.body) {
    if (el.id === 'stage') return el;
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return document.scrollingElement;
}
function lost() {
  cursor.classList.remove('on', 'zoom'); if (pinched) release();
  live = false; aim = null; prevGap = null; gapHistory.length = 0; ax = ay = null; press = null;
  fx.reset(); fy.reset(); history.length = 0; pinchFrames = 0; box = null; palmS = null;
  two = null; poseSince = null; poseKind = null; offSince = null; rebaseBox = false;
}

// Two fingers up (index and middle, like a trackpad): the cursor stops, and the hand scrolls and swipes.
// Move up or down from where the fingers went up to scroll: the farther, the faster, and it keeps going while
// held there, so there's no need to reposition the hand on a long page. A quick flick sideways goes back (left)
// or forward (right). Pointing, an open hand and a pinch all look different, so none of them can set this off.
// Three fingers up (browser extension only, where window.__handAction exists) work the browser itself: flick
// left or right to change tab, flick up for a new tab, hold still to reload. Flicking down closes the tab only
// if the fingers then stay up a moment, because simply lowering a hand looks much the same.
const TWO_ENTER_MS = 200, TWO_EXIT_MS = 200, DEADZONE = .035, SCROLL_RATE = 7, FLICK = .16, FLICK_MS = 250;
const RELOAD_HOLD_MS = 1200, CLOSE_HOLD_MS = 800, NEW_TAB_HOLD_MS = 1200;
let two = null, poseSince = null, poseKind = null, offSince = null;
function poseOf(f) {
  const w = P(f, 'wrist'), reach = k => d2(P(f, k), w);
  const up = n => reach(n + 'Tip') > reach(n + 'PIP') * 1.15, curled = n => reach(n + 'Tip') < reach(n + 'PIP') * 1.05;
  if (!up('index') || !up('middle') || !curled('little')) return null;
  if (curled('ring')) return 'two';
  return up('ring') && window.__handAction ? 'three' : null;
}
const palmAt = f => {
  const a = P(f, 'indexMCP'), b = P(f, 'middleMCP'), c = P(f, 'littleMCP');
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
};
function scrollStep(dt) {
  if (!two.v) return;
  two.carry += two.v * dt;
  const step = Math.trunc(two.carry);
  if (!step) return;
  two.carry -= step;
  if (two.scroller?.id === 'stage') fire('wheel', dx, dy, {deltaY: step, deltaMode: 0});
  else two.scroller?.scrollBy({top: step, behavior: 'instant'});
}
function threeFingers(x, y, t) {
  const act = (name, label) => { two.flicked = true; two.closeAt = 0; showTag(label); window.__handAction(name); trace('action ' + name); };
  if (two.closeAt) {
    if (t >= two.closeAt) act('closeTab', 'Close tab');
    else showTag('Keep fingers up to close', 300);
    return;
  }
  if (two.flicked) return;
  const a = two.track[0], mx = x - a.x, my = y - a.y;
  if (Math.abs(mx) > FLICK && Math.abs(mx) > 2 * Math.abs(my)) return act(mx < 0 ? 'previousTab' : 'nextTab', mx < 0 ? 'Previous tab' : 'Next tab');
  if (Math.abs(my) > FLICK && Math.abs(my) > 2 * Math.abs(mx)) {
    if (my < 0) return act('newTab', 'New tab');
    two.closeAt = t + CLOSE_HOLD_MS; // moved down: only a sign of closing until the fingers stay up
    return;
  }
  // holding still reloads; any real movement starts the wait again
  if (Math.hypot(x - two.x0, y - two.y0) > .04) { two.x0 = x; two.y0 = y; two.t0 = t; }
  const held = t - two.t0;
  if (held >= RELOAD_HOLD_MS) act('reload', 'Reload');
  else if (held > 400) showTag('Keep holding to reload', 300);
}

// Returns true while two fingers are in charge of this frame, so the cursor and pinch leave it alone.
function twoFingers(f, t) {
  const kind = poseOf(f);
  if (!two) {
    if (!kind || pinched || f.sure === false) { poseSince = null; return false; }
    if (kind !== poseKind) { poseKind = kind; poseSince = t; }
    poseSince ??= t;
    if (t - poseSince < TWO_ENTER_MS) return false;
    // curling the other fingers moved the cursor a little: go back to where it was just before
    const b = history[0];
    if (b) { cx = ax = b.cx; cy = ay = b.cy; }
    const [x, y] = palmAt(f);
    two = {kind, t0: t, x0: x, y0: y, sy: y, v: 0, carry: 0, flicked: false, closeAt: 0, track: [{t, x, y}], scroller: scrollableAt(cx, cy)};
    offSince = null; aim = null; pinchFrames = 0; gapHistory.length = 0; prevGap = null; poseSince = null;
    cursor.classList.add('zoom');
    showTag(kind === 'three' ? 'Tabs' : two.scroller?.id === 'stage' ? 'Zoom' : 'Scroll', 800);
    return true;
  }
  if (kind === two.kind) offSince = null;
  else {
    offSince ??= t;
    two.v = 0; // a hand on its way out of the pose doesn't scroll
    if (t - offSince >= TWO_EXIT_MS) {
      two = null; cursor.classList.remove('zoom');
      // the hand has moved: the cursor stays where it is and carries on from here
      rebaseBox = true; fx.reset(); fy.reset(); resync = true;
      aim = {x: dx, y: dy, t, until: 250, release: true};
      return false;
    }
    return true;
  }
  const [x, y] = palmAt(f);
  two.sy += (y - two.sy) * .4;
  two.track.push({t, x, y}); while (t - two.track[0].t > FLICK_MS) two.track.shift();
  if (two.kind === 'three') { threeFingers(x, y, t); return true; }
  if (!two.flicked) {
    const a = two.track[0], mx = x - a.x, my = y - a.y;
    if (Math.abs(mx) > FLICK && Math.abs(mx) > 2 * Math.abs(my)) {
      two.flicked = true; two.v = 0; // one flick per gesture, so bringing the hand back does nothing
      if (mx < 0) {
        if (window.__handBack) window.__handBack();
        else document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true}));
        showTag('Back');
      } else if (window.__handForward) {
        window.__handForward();
        showTag('Forward');
      }
      trace(`flick ${mx < 0 ? 'back' : 'forward'}`);
    }
  }
  const o = two.sy - two.y0, out = Math.max(0, Math.abs(o) - DEADZONE);
  // a sideways flick isn't a scroll
  const sideways = Math.abs(x - two.track[0].x) > .05;
  two.v = two.flicked || sideways ? 0 : Math.sign(o) * Math.min(3000, out * innerHeight * SCROLL_RATE);
  if (two.v) showTag(two.scroller?.id === 'stage' ? 'Zoom' : 'Scroll', 400);
  return true;
}

// Which hand controls the cursor when two are in view: the same logic as ActiveHandPicker.swift, for the
// web page. Follows one hand by position, and hands control over only when the other is clearly the one
// moving, never during a pinch. Positions in picture heights, times in seconds.
window.__handPicker = () => {
  const MAX_JUMP = .25, SAME_HAND = .04, MIN_SPEED = .2, RATIO = 2.5, SUSTAIN = 6, HANDOVER = 5, FORGET = 12;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let active = null, other = null, activeSpeed = 0, otherSpeed = 0, sustain = 0, missing = 0, last = null;
  const noteOther = (anchors, ai, dt) => {
    const found = anchors.findIndex((a, i) => i !== ai && dist(a, anchors[ai]) > SAME_HAND);
    if (found < 0) { other = null; otherSpeed = 0; return -1; }
    if (other && dist(other, anchors[found]) <= MAX_JUMP) otherSpeed += (dist(other, anchors[found]) / dt - otherSpeed) * .3;
    else otherSpeed = 0; // it has only just appeared
    other = anchors[found];
    return found;
  };
  return {
    pick(anchors, time, busy) {
      const dt = Math.max(1e-3, time - (last ?? time)); last = time;
      if (!anchors.length) {
        missing++; other = null; otherSpeed = 0; sustain = 0;
        if (missing >= FORGET) active = null;
        return {index: -1, switched: false};
      }
      if (!active) {
        active = anchors[0]; activeSpeed = 0; missing = 0; sustain = 0;
        noteOther(anchors, 0, dt);
        return {index: 0, switched: false};
      }
      let near = 0;
      anchors.forEach((a, i) => { if (dist(a, active) < dist(anchors[near], active)) near = i; });
      const d = dist(anchors[near], active);
      if (d > MAX_JUMP + .05 * missing) {
        missing++;
        if (missing < HANDOVER) return {index: -1, switched: false};
        active = anchors[near]; activeSpeed = 0; missing = 0; sustain = 0; other = null; otherSpeed = 0;
        return {index: near, switched: true};
      }
      activeSpeed += (d / (dt * (missing + 1)) - activeSpeed) * .3;
      active = anchors[near]; missing = 0;
      const o = noteOther(anchors, near, dt);
      if (o < 0) { sustain = 0; return {index: near, switched: false}; }
      sustain = !busy && otherSpeed > MIN_SPEED && otherSpeed > RATIO * activeSpeed ? sustain + 1 : 0;
      if (sustain < SUSTAIN) return {index: near, switched: false};
      [activeSpeed, otherSpeed] = [otherSpeed, activeSpeed];
      other = active; active = anchors[o]; sustain = 0;
      return {index: o, switched: true};
    }
  };
};

window.__hand = {
  frame(f) {
    const t = performance.now();
    if (!f) return lost();
    // control has just passed to the other hand: drop this hand's history, but leave the cursor where it is
    if (f.switched && live) {
      if (pinched) release();
      aim = null; prevGap = null; gapHistory.length = 0; pinchFrames = 0; palmS = null;
      if (two) cursor.classList.remove('zoom');
      two = null; poseSince = null; poseKind = null;
      fx.reset(); fy.reset(); resync = true;
      showTag('Other hand', 700);
    }
    if (lastFrameAt && t - lastFrameAt < 500) camGap += ((t - lastFrameAt) / 1000 - camGap) * .1;
    lastFrameAt = t;
    updateBox(f);
    if (twoFingers(f, t)) return;
    const gap = f.gap;
    // A pinch starts only from a real closing motion of the fingers (which the aim lock has caught) or when
    // they clearly touch, so fingers drifting near each other never click on their own. Once that closing
    // motion has been seen, frames where a fingertip was only guessed still count: at the moment of contact
    // the tips often hide each other. A pinch starts after 3 frames and ends after 2 clear ones.
    const sure = f.sure !== false, closing = !!aim && !aim.release;
    // Release is relative to how far this pinch closed, so it lets go as soon as the fingers open.
    // Measured real pinches close to 1.6-2.5 cm for 5 or more frames; accidental dips mostly stop at
    // 2.9-3.8 cm for 1-5 frames, hence 2.8 cm held for 3 frames.
    if (pinched) pinchMin = Math.min(pinchMin, gap);
    const want = pinched ? gap < Math.min(4.5, pinchMin + 1.5) : gap < 2.8 && (closing || gap < 1.8);
    if (want === pinched) pinchFrames = 0; else if (pinched ? sure : sure || closing) pinchFrames++;
    const changed = pinchFrames >= (pinched ? 2 : 3);

    let [tx, ty] = toScreen(ptr(f));
    if (pinched && anchor) { // while pinched, follow the index knuckle, which stays put as the fingers close
      const [kx, ky] = toScreen(P(f, 'indexMCP'));
      tx = anchor.cx + (kx - anchor.kx); ty = anchor.cy + (ky - anchor.ky);
    }
    const fxv = fx.filter(tx, t), fyv = fy.filter(ty, t);
    // Pointer acceleration, like a mouse: slow, careful movements move the cursor less than the hand
    // (fine control for small buttons), quick ones move it fully; while moving quickly the cursor also
    // drifts back toward where the hand points, so the two never stay apart for long.
    if (ax === null) { ax = fxv; ay = fyv; }
    else if (resync) resync = false;
    else {
      const ddx = fxv - lastX, ddy = fyv - lastY, sp = Math.hypot(ddx, ddy) / Math.max(.001, (t - lastXT) / 1000);
      // a gentle boost only, and a constant pull back under the hand, so the cursor never drifts away from it
      const gain = Math.min(1.15, .6 + sp / 1500);
      ax += ddx * gain; ay += ddy * gain;
      const pull = Math.max(.06, Math.min(.25, sp / 4000));
      // edge assist: as the hand nears a screen edge the cursor catches up with it however slowly it
      // moves, so slow, careful movements can't leave the corners out of reach
      const edgePull = (v, size) => { const e = Math.min(v, size - v) / size; return e < .15 ? .4 * (1 - e / .15) : 0; };
      // ... all only while the hand is moving: a still hand never moves the cursor
      const moving = sp > 15;
      const px = moving ? Math.max(pull, edgePull(fxv, innerWidth)) : 0, py = moving ? Math.max(pull, edgePull(fyv, innerHeight)) : 0;
      ax += (fxv - ax) * px; ay += (fyv - ay) * py;
      ax = Math.min(innerWidth, Math.max(0, ax)); ay = Math.min(innerHeight, Math.max(0, ay));
    }
    lastX = fxv; lastY = fyv; lastXT = t;
    const hx = ax, hy = ay;
    history.push({t, cx: hx, cy: hy}); while (history.length && t - history[0].t > 300) history.shift();

    // closing speed of the pinch, in cm per second (negative = closing)
    const speed = prevGap === null ? 0 : (gap - prevGap) / Math.max(.001, (t - prevT) / 1000);
    prevGap = gap; prevT = t;
    gapHistory.push({t, gap}); while (gapHistory.length && t - gapHistory[0].t > 250) gapHistory.shift();
    // a real pinch closes the fingers by well over a centimetre in a quarter second; noise doesn't
    const closed = Math.max(...gapHistory.map(g => g.gap)) - gap;
    if (!pinched) {
      if (aim && (t - aim.t > aim.until || (!aim.release && gap > 6.5))) aim = null;
      if ((!aim || aim.release) && sure && gap < 5.5 && closed > 1.2 && speed < -6) {
        // where the hand was just before the fingers started to close; during the hold after a pinch
        // the cursor stays exactly where it already is
        const b = aim ? {cx: aim.x, cy: aim.y} : history.find(h => t - h.t <= 160) ?? history[history.length - 1];
        // target lock: what a pinch will press is decided now, before the hand moves
        aim = {x: b.cx, y: b.cy, t, until: 700, hit: aim ? null : findTarget(b.cx, b.cy)};
      }
    }
    cx = aim && !pinched ? aim.x : hx; cy = aim && !pinched ? aim.y : hy;
    if (!live) { dx = cx; dy = cy; place(); live = true; } // a hand that reappears starts where it is, no swoop
    cursor.classList.add('on');
    cursor.classList.toggle('edge', !!f.edge); // red: the hand is about to leave the camera's view

    // grab: pinched on empty space — moving the hand up or down zooms the map (up = closer) or scrolls the
    // panel under it (the content follows the hand, as with a finger on a touch screen); the cursor stays put
    if (pinched && grab) {
      const [kx, ky] = P(f, 'indexMCP');
      grab.fy += (ky * innerHeight - grab.fy) * .35; // smoothed hand height, so zooming doesn't jerk
      // movement so far, as fractions of the camera picture
      const sx = (kx - grab.kx) / f.ar, sy = ky - grab.ky;
      // swipe left while pinching: back, like swiping back on an iPhone
      if (!grab.moved && !grab.swiped && sx < -.12 && Math.abs(sx) > 2 * Math.abs(sy)) {
        grab.swiped = true;
        // the page's own Escape handling closes a project, the About or List panel, or a zoomed group;
        // the browser extension sets __handBack to go back a page instead
        if (window.__handBack) window.__handBack();
        else document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true}));
        showTag('Back');
      }
      // up or down: zoom or scroll, only once the pinch has been held a moment and the hand has clearly
      // moved, so a click with a little hand movement never turns into a zoom
      if (!grab.moved && !grab.swiped && t - grab.t0 > 250 && Math.abs(grab.fy - grab.y0) > 40 && Math.abs(sy) > Math.abs(sx)) {
        grab.moved = true; grab.last = grab.fy; cursor.classList.add('zoom');
      }
      if (grab.moved) {
        const step = grab.fy - grab.last; grab.last = grab.fy;
        const onMap = grab.scroller?.id === 'stage';
        if (onMap) fire('wheel', grab.x, grab.y, {deltaY: step * 2, deltaMode: 0}); else grab.scroller?.scrollBy(0, -step * 1.8);
        showTag(onMap ? 'Zoom' : 'Scroll', 400);
      }
      cx = grab.x; cy = grab.y;
    } else if (pinched && press && anchor) {
      const moved = Math.hypot(cx - anchor.cx, cy - anchor.cy);
      if (!press.dragging) {
        cx = anchor.cx; cy = anchor.cy; // stay on the target: this is still a click
        press.away = moved > DRAG_PX && t - press.t0 > DRAG_AFTER_MS ? (press.away || 0) + 1 : 0;
        if (press.away >= DRAG_FRAMES && !press.opened) {
          press.dragging = true;
          fire('pointermove', anchor.cx, anchor.cy); downEl = fire('pointerdown', anchor.cx, anchor.cy); fire('mousedown', anchor.cx, anchor.cy);
          trace('drag');
        } else if (!press.opened && window.__handAction && t - press.t0 > NEW_TAB_HOLD_MS && moved <= DRAG_PX &&
                   press.el?.closest?.('a[href]')?.href) {
          // a link pinched and held still opens in a new tab behind this one
          press.opened = true;
          window.__handAction('openLink', press.el.closest('a[href]').href);
          showTag('Opened in new tab');
        }
      }
      if (press.dragging) { cx = ax; cy = ay; showTag('Drag', 400); }
    }

    if (changed && !pinched) {
      // press exactly what's outlined; with nothing outlined, press where the aim lock held (or, for a
      // very quick pinch, where the hand was ~150 ms ago), pulled onto a target just beside it
      const b = aim ? {cx: aim.x, cy: aim.y} : history.find(h => t - h.t <= 150) ?? history[history.length - 1];
      const locked = aim?.hit?.el?.isConnected ? aim.hit : null;
      const hit = locked || (target && target.el.isConnected ? target : findTarget(b.cx, b.cy));
      [cx, cy] = hit ? hit.c : [b.cx, b.cy]; aim = null;
      // a drag continues from the pressed spot
      ax = cx; ay = cy; fx.x = cx; fy.x = cy; lastX = cx; lastY = cy;
      pinched = true; pinchFrames = 0; pinchMin = gap; cursor.classList.add('down');
      dx = cx; dy = cy; place();
      press = {t0: t, c: [cx, cy], el: hit?.el || null, dragging: false};
      trace(`pinch hit=${!!hit}`);
      if (hit) {
        // nothing happens yet: released quickly it clicks, held and moved it drags
        const [kx, ky] = toScreen(P(f, 'indexMCP')); anchor = {cx, cy, kx, ky};
      } else {
        // nothing to press here: hold off until it's clear whether this is a click or a grab
        anchor = null;
        const [kx, ky] = P(f, 'indexMCP');
        grab = {x: cx, y: cy, t0: t, kx, ky, y0: ky * innerHeight, fy: ky * innerHeight, moved: false, swiped: false,
          scroller: scrollableAt(cx, cy)};
      }
    } else if (changed && pinched) release();
  }
};
})();
