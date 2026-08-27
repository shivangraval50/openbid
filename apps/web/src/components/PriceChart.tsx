"use client";

import { useEffect, useRef, useState } from "react";
import { createPriceChart, type PriceChart as Chart } from "@openbid/charts";
import styles from "./PriceChart.module.css";

/** Fallback backing-store size, used for the server render and before the
 *  first measurement. Matches the CSS aspect ratio so the SSR box and the
 *  measured box are the same shape and nothing shifts. */
const FALLBACK_WIDTH = 480;
const FALLBACK_HEIGHT = 150;

/** Reads a CSS custom property off the element, so the chart's colour comes
 *  from the same token layer as everything else and follows the light/dark
 *  appearance without the component knowing which one is active. */
function readToken(el: Element, name: string, fallback: string): string {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

export function PriceChart({ price, serverNow }: { price: number; serverNow: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);
  // Always holds the latest `serverNow`, updated on every render body
  // execution (not just ones that push a point) -- see below.
  const serverNowRef = useRef(serverNow);
  serverNowRef.current = serverNow;

  // The price the chart's domain starts at, captured once. Used only for the
  // caption's "from -> to" annotation, and computed identically on the server
  // render and the client's hydrating render (both see the same `price`
  // prop), so it cannot mismatch.
  const openingRef = useRef(price);
  const [renderNonce, setRenderNonce] = useState(0);
  // How many samples the chart holds. Starts at 1 -- the point the mount
  // effect pushes -- on both the server render and the client's hydrating
  // render, so the placeholder below cannot mismatch.
  const [sampleCount, setSampleCount] = useState(1);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    // Device-pixel-ratio-aware sizing. Without this the canvas was a fixed
    // 480x160 element that overflowed a 390px-wide phone viewport, and drew
    // a blurry line on any retina display.
    let chart: Chart | null = null;

    function build(): void {
      if (canvas === null) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const cssWidth = rect.width || FALLBACK_WIDTH;
      const cssHeight = rect.height || FALLBACK_HEIGHT;
      const nextWidth = Math.max(1, Math.round(cssWidth * dpr));
      const nextHeight = Math.max(1, Math.round(cssHeight * dpr));

      // Writing width/height clears the canvas, so only write when the size
      // genuinely changed -- otherwise every ResizeObserver callback would
      // blank the plot.
      if (canvas.width !== nextWidth) canvas.width = nextWidth;
      if (canvas.height !== nextHeight) canvas.height = nextHeight;

      const points = chart?.points() ?? [];
      chart?.destroy();
      chart = createPriceChart(canvas, {
        stroke: readToken(canvas, "--ob-chart-line", "#64b0ff"),
        lineWidth: 2 * dpr,
        padding: 8 * dpr,
        // Keeps the highest and lowest prices off the plot's own edges. Every
        // series otherwise appears to run corner to corner whatever its
        // shape, which reads as clipped rather than scaled.
        priceHeadroom: 0.18,
      });
      // Carry the series across a rebuild; a window resize must not wipe the
      // price history the user has been watching.
      for (const point of points) chart.push(point);
      chartRef.current = chart;
      chart.render();
    }

    build();

    // Feature-detected, not assumed. ResizeObserver is absent in jsdom (so
    // every component test that mounts a room would throw) and in older
    // Safari; without it the chart simply keeps its first measured size,
    // which is a graceful degradation rather than a broken page.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => build());
    observer?.observe(canvas);

    // The stroke colour is resolved once per build, so a light/dark switch
    // while the page is open needs a rebuild to pick up the new token.
    const scheme =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: light)")
        : null;
    const onSchemeChange = (): void => {
      build();
      setRenderNonce((n) => n + 1);
    };
    scheme?.addEventListener("change", onSchemeChange);

    return () => {
      observer?.disconnect();
      scheme?.removeEventListener("change", onSchemeChange);
      chart?.destroy();
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
    setSampleCount(chartRef.current?.points().length ?? 1);
  }, [price, renderNonce]);

  const opening = openingRef.current;
  const hasMoved = sampleCount > 1 && opening !== price;

  return (
    <figure className={styles.chart}>
      <figcaption className={styles.caption}>
        <span className={styles.captionTitle}>Price over time</span>
        {/* Only shown once there is a range to report. "100 → 100" on an
            untouched lot is ink that says nothing, and the same number is
            already set in display type immediately to the left. */}
        {hasMoved ? (
          <span className={styles.range}>
            {opening}
            <span className={styles.rangeArrow} aria-hidden="true">
              →
            </span>
            <span className={styles.rangeNow}>{price}</span>
          </span>
        ) : null}
      </figcaption>
      <div className={styles.plot}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          width={FALLBACK_WIDTH}
          height={FALLBACK_HEIGHT}
          role="img"
          /* charting-data.md: "it's crucial to provide both accessibility
             labels that describe chart values and components". The static
             "Price over time" alone described the component but none of its
             values. */
          aria-label={
            hasMoved
              ? `Price over time. Opened at ${opening}, now ${price}.`
              : `Price over time. No change since this page opened; the price is ${price}.`
          }
        />
        {sampleCount > 1 ? null : (
          <p className={styles.placeholder}>No change since you opened this page.</p>
        )}
      </div>
    </figure>
  );
}
