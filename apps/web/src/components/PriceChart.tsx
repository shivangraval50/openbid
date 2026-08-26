"use client";

import { useEffect, useRef } from "react";
import { createPriceChart, type PriceChart as Chart } from "@openbid/charts";

export function PriceChart({ price, serverNow }: { price: number; serverNow: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  // Always holds the latest `serverNow`, updated on every render body
  // execution (not just ones that push a point) -- see below.
  const serverNowRef = useRef(serverNow);
  serverNowRef.current = serverNow;

  useEffect(() => {
    if (canvasRef.current === null) return;
    const chart = createPriceChart(canvasRef.current);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, []);

  // One point per *price* change, timestamped on the server-corrected
  // clock. `serverNow` is deliberately NOT in this dependency array: it
  // changes on every render (the countdown's 250ms tick forces one), and
  // including it here would push a near-duplicate point ~4 times a second
  // regardless of whether the price actually moved, collapsing the visible
  // "price over time" domain toward the last ~75 seconds of identical
  // samples. Reading it from a ref -- updated above on every render,
  // including the ones that don't re-run this effect -- keeps the
  // timestamp fresh without retriggering the push on every tick.
  useEffect(() => {
    chartRef.current?.push({ tMs: serverNowRef.current, price });
    chartRef.current?.render();
  }, [price]);

  return (
    <canvas
      ref={canvasRef}
      width={480}
      height={160}
      role="img"
      aria-label="Price over time"
    />
  );
}
