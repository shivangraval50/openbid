import { scaleLinear } from "d3-scale";

export interface PricePoint {
  tMs: number;
  price: number;
}

export interface PriceChart {
  push(point: PricePoint): void;
  points(): readonly PricePoint[];
  render(): void;
  destroy(): void;
}

const PADDING = 8;

export function createPriceChart(
  canvas: HTMLCanvasElement,
  opts: { maxPoints?: number } = {}
): PriceChart {
  const maxPoints = opts.maxPoints ?? 600;
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
      .range([PADDING, width - PADDING]);
    const y = scaleLinear()
      .domain([pMin, pMax === pMin ? pMin + 1 : pMax])
      .range([height - PADDING, PADDING]);

    ctx.beginPath();
    ctx.lineWidth = 2;
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
