// Dark-room mode for the hand tracker. In a dim room a camera turns its sensitivity up, so the picture goes grainy
// well before it goes dark, and grain is what loses the hand. So a few frames are blended as soon as the picture is
// dim, and brightened as well if it's actually dark. On a darkened, grainy photo this took the tracker from finding
// the hand in 0 of 12 frames to 11 or 12 of 12. It also makes a small copy of each frame when asked: Safari is many times quicker
// from a small copy than from the video itself. The picture is only used here, on this device.
// Shared by the website and the browser extension; keep the two copies the same.
window.makeFrameBoost = ({width, alwaysCopy}) => {
  const canvas = w => { const c = document.createElement('canvas'); c.width = w; return c; };
  const out = canvas(width), smooth = canvas(width), probe = canvas(16);
  probe.height = 9;
  const outCtx = out.getContext('2d', {alpha: false}), smoothCtx = smooth.getContext('2d', {alpha: false});
  const probeCtx = probe.getContext('2d', {alpha: false, willReadFrequently: true});
  let gain = 1, dim = false, lastProbe = -1e9, fresh = true;
  const DIM = 90; // average brightness below which frames are blended

  // the average brightness (0-255) sets the gain; each change must be clearly past the line, so it doesn't flicker
  const STEPS = [[70, 1], [40, 2], [18, 4], [8, 8], [0, 16]], CLEAR = .12;
  function measure(source) {
    probeCtx.drawImage(source, 0, 0, 16, 9);
    const d = probeCtx.getImageData(0, 0, 16, 9).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += .3 * d[i] + .59 * d[i + 1] + .11 * d[i + 2];
    const luma = sum / (d.length / 4);
    if (dim ? luma > DIM * (1 + CLEAR) : luma < DIM) { dim = !dim; fresh = true; }
    const want = STEPS.find(([floor]) => luma >= floor)[1];
    if (want === gain) return;
    const floor = STEPS.find(s => s[1] === gain)[0]; // the bottom of the current step
    if (want > gain ? luma < floor * (1 - CLEAR) : luma > STEPS.find(s => s[1] === want)[0] * (1 + CLEAR)) {
      gain = want;
    }
  }

  return {
    get gain() { return gain; },
    get active() { return dim; },
    frame(source, sourceW, sourceH, now) {
      if (now - lastProbe > 400) { lastProbe = now; measure(source); }
      if (!dim && !alwaysCopy) return source;
      const h = Math.round(width * sourceH / sourceW);
      if (out.height !== h) { out.height = smooth.height = h; fresh = true; }
      outCtx.globalCompositeOperation = 'source-over';
      if (!dim) { outCtx.drawImage(source, 0, 0, width, h); return out; }
      // the darker it is, the more frames share in the blend
      smoothCtx.globalAlpha = fresh ? 1 : gain >= 8 ? .3 : .4;
      fresh = false;
      smoothCtx.drawImage(source, 0, 0, width, h);
      outCtx.drawImage(smooth, 0, 0);
      outCtx.globalCompositeOperation = 'lighter'; // adding the picture to itself doubles its brightness
      for (let g = gain; g > 1; g /= 2) outCtx.drawImage(out, 0, 0);
      return out;
    }
  };
};
