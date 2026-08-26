"use client";

import { useEffect, useRef } from "react";
import { createPriceChart, type PriceChart as Chart } from "@openbid/charts";

export function PriceChart({ price, serverNow }: { price: number; serverNow: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (canvasRef.current === null) return;
    const chart = createPriceChart(canvasRef.current);
    chartRef.current = chart;
    return () => {
      chart.destroy();
      chartRef.current = null;
    };
  }, []);

  // One point per price change, timestamped on the server-corrected clock.
  useEffect(() => {
    chartRef.current?.push({ tMs: serverNow, price });
    chartRef.current?.render();
  }, [price, serverNow]);

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
