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
});
