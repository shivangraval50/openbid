// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createPriceChart } from "./priceChart.js";

function fakeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 200;
  // jsdom has no 2d context; stub the calls the renderer makes.
  const ctx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setLineDash: vi.fn(),
    strokeStyle: "",
    lineWidth: 0,
  };
  vi.spyOn(canvas, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return canvas;
}

describe("createPriceChart", () => {
  it("stores pushed points in order", () => {
    const chart = createPriceChart(fakeCanvas());
    chart.push({ tMs: 1, price: 100 });
    chart.push({ tMs: 2, price: 150 });
    expect(chart.points().map((p) => p.price)).toEqual([100, 150]);
  });

  it("drops the oldest point past maxPoints", () => {
    const chart = createPriceChart(fakeCanvas(), { maxPoints: 3 });
    for (let i = 1; i <= 5; i += 1) chart.push({ tMs: i, price: i * 10 });
    expect(chart.points().map((p) => p.price)).toEqual([30, 40, 50]);
  });

  it("renders without throwing when empty", () => {
    const chart = createPriceChart(fakeCanvas());
    expect(() => chart.render()).not.toThrow();
  });

  it("renders without throwing for a single point", () => {
    const chart = createPriceChart(fakeCanvas());
    chart.push({ tMs: 1, price: 100 });
    expect(() => chart.render()).not.toThrow();
  });

  it("draws a line segment per adjacent pair", () => {
    const canvas = fakeCanvas();
    const chart = createPriceChart(canvas);
    chart.push({ tMs: 1, price: 100 });
    chart.push({ tMs: 2, price: 150 });
    chart.push({ tMs: 3, price: 200 });
    chart.render();
    const ctx = canvas.getContext("2d") as unknown as { lineTo: { mock: { calls: unknown[] } } };
    // For 3 points, expect exactly 2 lineTo calls (one for each point after the first)
    expect(ctx.lineTo.mock.calls.length).toBe(2);
  });

  it("stops accepting points after destroy", () => {
    const chart = createPriceChart(fakeCanvas());
    chart.push({ tMs: 1, price: 100 });
    chart.destroy();
    chart.push({ tMs: 2, price: 200 });
    expect(chart.points()).toHaveLength(1);
  });

  it("does not throw when getContext returns null", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 200;
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    const chart = createPriceChart(canvas);
    chart.push({ tMs: 1, price: 100 });
    chart.push({ tMs: 2, price: 150 });
    expect(() => chart.render()).not.toThrow();
  });

  it("handles degenerate time domain (all points at same tMs)", () => {
    const canvas = fakeCanvas();
    const chart = createPriceChart(canvas);
    // All points share the same tMs; the domain guard should prevent NaN
    chart.push({ tMs: 100, price: 100 });
    chart.push({ tMs: 100, price: 150 });
    chart.push({ tMs: 100, price: 200 });
    chart.render();
    const ctx = canvas.getContext("2d") as unknown as { moveTo: { mock: { calls: Array<Array<number>> } }; lineTo: { mock: { calls: Array<Array<number>> } } };
    // All coordinates should be finite (not NaN)
    const allCalls = [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls];
    allCalls.forEach(([x, y]) => {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    });
  });

  it("handles degenerate price domain (all points at same price)", () => {
    const canvas = fakeCanvas();
    const chart = createPriceChart(canvas);
    // All points share the same price; the domain guard should prevent NaN
    chart.push({ tMs: 1, price: 150 });
    chart.push({ tMs: 2, price: 150 });
    chart.push({ tMs: 3, price: 150 });
    chart.render();
    const ctx = canvas.getContext("2d") as unknown as { moveTo: { mock: { calls: Array<Array<number>> } }; lineTo: { mock: { calls: Array<Array<number>> } } };
    // All coordinates should be finite (not NaN)
    const allCalls = [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls];
    allCalls.forEach(([x, y]) => {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    });
  });
});

describe("createPriceChart appearance options", () => {
  function renderTwoPoints(opts?: Parameters<typeof createPriceChart>[1]) {
    const canvas = fakeCanvas();
    const chart = createPriceChart(canvas, opts);
    chart.push({ tMs: 0, price: 100 });
    chart.push({ tMs: 100, price: 200 });
    chart.render();
    return canvas.getContext("2d") as unknown as {
      strokeStyle: string;
      lineWidth: number;
      moveTo: { mock: { calls: Array<Array<number>> } };
      lineTo: { mock: { calls: Array<Array<number>> } };
    };
  }

  // The canvas 2D default strokeStyle is opaque black, which is invisible on
  // this app's dark surface -- the line was being drawn all along and simply
  // could not be seen. This is the fix, and the assertion that it reaches the
  // context.
  it("strokes in the caller's colour", () => {
    expect(renderTwoPoints({ stroke: "#64b0ff" }).strokeStyle).toBe("#64b0ff");
  });

  // Absent an explicit colour the context keeps whatever it already had, so a
  // caller that manages strokeStyle itself is not overridden.
  it("leaves strokeStyle alone when no colour is given", () => {
    expect(renderTwoPoints().strokeStyle).toBe("");
  });

  it("uses the caller's line width", () => {
    expect(renderTwoPoints({ lineWidth: 6 }).lineWidth).toBe(6);
  });

  it("defaults the line width rather than leaving it at zero", () => {
    expect(renderTwoPoints().lineWidth).toBe(2);
  });

  // Padding is what keeps a 2px line from being clipped in half at the top
  // and bottom of the plot. It scales with devicePixelRatio, so it has to be
  // a parameter rather than a constant.
  it("insets the plot by the caller's padding", () => {
    const ctx = renderTwoPoints({ padding: 20 });
    const [firstX, firstY] = ctx.moveTo.mock.calls[0]!;
    const [lastX, lastY] = ctx.lineTo.mock.calls[0]!;
    // canvas is 400x200 (see fakeCanvas); price rises, so the first point
    // sits on the bottom inset and the last on the top inset.
    expect(firstX).toBe(20);
    expect(firstY).toBe(180);
    expect(lastX).toBe(380);
    expect(lastY).toBe(20);
  });
});

describe("createPriceChart price headroom", () => {
  function coords(opts: Parameters<typeof createPriceChart>[1]) {
    const canvas = fakeCanvas(); // 400x200
    const chart = createPriceChart(canvas, opts);
    chart.push({ tMs: 0, price: 100 });
    chart.push({ tMs: 100, price: 200 });
    chart.render();
    const ctx = canvas.getContext("2d") as unknown as {
      moveTo: { mock: { calls: Array<Array<number>> } };
      lineTo: { mock: { calls: Array<Array<number>> } };
    };
    return { low: ctx.moveTo.mock.calls[0]![1]!, high: ctx.lineTo.mock.calls[0]![1]! };
  }

  // Without headroom the extremes land exactly on the insets, so the line
  // always looks clipped to the plot's edges whatever the data is.
  it("puts the extremes on the insets when there is no headroom", () => {
    expect(coords({ padding: 10 })).toEqual({ low: 190, high: 10 });
  });

  it("pulls the extremes inward by the headroom fraction", () => {
    // Span 100, headroom 0.25 -> domain [75, 225]; the usable range is 180px
    // tall, so 100 sits 30px up from the bottom inset and 200 sits 30px down
    // from the top.
    const { low, high } = coords({ padding: 10, priceHeadroom: 0.25 });
    expect(low).toBeCloseTo(160, 6);
    expect(high).toBeCloseTo(40, 6);
  });

  // The degenerate case is what makes this worth a test rather than an
  // inline expression: with every point at one price the span is zero, so a
  // headroom computed off the raw span would be zero too and the widening
  // fallback would be silently cancelled out, producing a NaN-free but
  // meaningless domain.
  it("still produces finite coordinates when every point shares one price", () => {
    const canvas = fakeCanvas();
    const chart = createPriceChart(canvas, { priceHeadroom: 0.2 });
    chart.push({ tMs: 0, price: 150 });
    chart.push({ tMs: 100, price: 150 });
    chart.render();
    const ctx = canvas.getContext("2d") as unknown as {
      moveTo: { mock: { calls: Array<Array<number>> } };
      lineTo: { mock: { calls: Array<Array<number>> } };
    };
    for (const [x, y] of [...ctx.moveTo.mock.calls, ...ctx.lineTo.mock.calls]) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});
