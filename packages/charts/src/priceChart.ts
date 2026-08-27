import { scaleLinear } from "d3-scale";

export interface PricePoint {
  tMs: number;
  price: number;
}

export interface PriceChartOptions {
  maxPoints?: number;
  /**
   * Stroke colour for the price line. Deliberately required-in-practice
   * rather than baked in: the canvas 2D default is opaque black, which is
   * invisible on this app's dark surface, and a chart package has no business
   * knowing which theme is active. The caller resolves it from a CSS custom
   * property and passes the computed value in.
   */
  stroke?: string;
  /**
   * Line width in DEVICE pixels, not CSS pixels. The caller sizes the canvas
   * backing store by `devicePixelRatio` (so the line is crisp on a retina
   * display) and every coordinate this module computes is therefore in device
   * pixels too, so the width has to be scaled the same way or the line looks
   * hairline-thin at 2x and 3x.
   */
  lineWidth?: number;
  /** Inset from the canvas edge, also in device pixels, for the same reason. */
  padding?: number;
  /**
   * Extra vertical room, as a fraction of the observed price range, added
   * above and below the series before it is scaled into the plot.
   *
   * With no headroom the highest and lowest points land exactly on the plot's
   * top and bottom insets, so the line always appears to touch both edges
   * regardless of the data -- which reads as a chart that has been clipped
   * rather than one that has been scaled. Defaults to 0 so that existing
   * callers are unaffected.
   */
  priceHeadroom?: number;
}

export interface PriceChart {
  push(point: PricePoint): void;
  points(): readonly PricePoint[];
  render(): void;
  destroy(): void;
}

const DEFAULT_PADDING = 8;
const DEFAULT_LINE_WIDTH = 2;

export function createPriceChart(
  canvas: HTMLCanvasElement,
  opts: PriceChartOptions = {}
): PriceChart {
  const maxPoints = opts.maxPoints ?? 600;
  const padding = opts.padding ?? DEFAULT_PADDING;
  const lineWidth = opts.lineWidth ?? DEFAULT_LINE_WIDTH;
  const priceHeadroom = Math.max(0, opts.priceHeadroom ?? 0);
  const stroke = opts.stroke;
  let buffer: PricePoint[] = [];
  let alive = true;

  function render(): void {
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    if (buffer.length < 2) return;

    const tMin = buffer[0]!.tMs;
    const tMax = buffer[buffer.length - 1]!.tMs;
    const prices = buffer.map((p) => p.price);
    const pMin = Math.min(...prices);
    const pMax = Math.max(...prices);

    const x = scaleLinear()
      .domain([tMin, tMax === tMin ? tMin + 1 : tMax])
      .range([padding, width - padding]);
    // A degenerate range (every point at the same price) still has to produce
    // a finite domain, so the `+ 1` fallback stays and the headroom is
    // computed from the *widened* span rather than from zero.
    const pTop = pMax === pMin ? pMin + 1 : pMax;
    const headroom = (pTop - pMin) * priceHeadroom;
    const y = scaleLinear()
      .domain([pMin - headroom, pTop + headroom])
      .range([height - padding, padding]);

    ctx.beginPath();
    ctx.lineWidth = lineWidth;
    if (stroke !== undefined) ctx.strokeStyle = stroke;
    ctx.moveTo(x(buffer[0]!.tMs), y(buffer[0]!.price));
    for (const point of buffer.slice(1)) {
      ctx.lineTo(x(point.tMs), y(point.price));
    }
    ctx.stroke();
  }

  return {
    push(point) {
      if (!alive) return;
      buffer = [...buffer, point].slice(-maxPoints);
    },
    points() {
      return buffer;
    },
    render,
    destroy() {
      alive = false;
    },
  };
}
