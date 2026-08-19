/**
 * The talking blob.
 *
 * A circle whose radius is perturbed by three slowly rotating sine harmonics,
 * so the outline is always organic but never repeats visibly. Loudness pushes
 * the radius outward; the level is smoothed on the way in because Vapi emits
 * volume roughly every 100ms and raw values make the shape twitch rather than
 * breathe.
 *
 * Monochrome by construction: it reads --fg and --bg from the stylesheet, so
 * it inverts with the theme without knowing the theme exists.
 */
export class Blob {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.level = 0;        // smoothed 0..1
    this.target = 0;       // latest reported level
    this.state = "idle";   // idle | listening | speaking | connecting
    this.t = 0;
    this.running = false;
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const ratio = window.devicePixelRatio || 1;
    const size = this.canvas.clientWidth || 320;
    this.canvas.width = size * ratio;
    this.canvas.height = size * ratio;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.size = size;
  }

  setLevel(v) {
    this.target = Math.max(0, Math.min(1, v || 0));
  }

  setState(state) {
    this.state = state;
    if (state === "idle") this.target = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const frame = () => {
      if (!this.running) return;
      this.draw();
      requestAnimationFrame(frame);
    };
    frame();
  }

  stop() {
    this.running = false;
  }

  draw() {
    const { ctx, size } = this;
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue("--fg").trim() || "#000";

    ctx.clearRect(0, 0, size, size);

    // Ease toward the reported level: fast to rise, slow to fall, which is how
    // speech actually sounds and stops the blob strobing between syllables.
    const rate = this.target > this.level ? 0.35 : 0.08;
    this.level += (this.target - this.level) * rate;
    this.t += 0.01;

    const cx = size / 2;
    const cy = size / 2;
    const base = size * 0.26;

    // Idle still breathes, so a connected-but-silent agent does not look frozen.
    const breathe = Math.sin(this.t * 1.6) * size * 0.012;
    const speak = this.level * size * 0.11;
    // Idle still deforms clearly; a perfect circle at rest reads as a
    // loading spinner rather than something alive.
    const wobble = this.state === "idle" ? 0.85 : 1.25;

    const ring = (scale, alpha, phase) => {
      ctx.beginPath();
      const steps = 180;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const noise =
          Math.sin(a * 3 + this.t * 1.7 + phase) * 0.055 +
          Math.sin(a * 5 - this.t * 1.1 + phase) * 0.032 +
          Math.sin(a * 2 + this.t * 0.7 + phase) * 0.045;
        const r =
          (base + breathe + speak) * scale * (1 + noise * wobble * (1 + this.level));
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    ctx.fillStyle = fg;

    // Two faint haloes track the core with a phase offset, which reads as
    // depth without introducing a second colour.
    ring(1.34, 0.06, 1.9);
    ring(1.16, 0.10, 0.9);
    ring(1.0, 1, 0);

    // Connecting: a thin sweeping arc, the only non-blob element.
    if (this.state === "connecting") {
      ctx.strokeStyle = fg;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const a0 = this.t * 3;
      ctx.arc(cx, cy, base * 1.55, a0, a0 + Math.PI * 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}
