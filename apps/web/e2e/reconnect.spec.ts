import { test, expect, type ConsoleMessage, type WebSocketRoute } from "@playwright/test";

test("a dropped connection rebases without losing bids", async ({ page, context }) => {
  // See simultaneous-bid.spec.ts for why this listener exists (reporting a
  // hydration mismatch, not silencing or asserting on one) and why both
  // "console" and "pageerror" are watched (React 19 raises this as an
  // uncaught exception, not a console.error).
  const hydrationWarnings: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/hydrat/i.test(text)) hydrationWarnings.push(text);
  });
  page.on("pageerror", (err) => {
    if (/hydrat/i.test(err.message)) hydrationWarnings.push(err.message);
  });

  // `context.setOffline(true)` alone (the brief's original mechanism) does
  // not close an *already-established* WebSocket in Chromium via CDP --
  // confirmed empirically: the room socket sat open for 20+ real seconds
  // under setOffline(true) with no close/error event and no reconnect
  // banner. `Network.emulateNetworkConditions` (what setOffline drives)
  // only blocks *new* connection attempts, so it is kept below for that
  // half of the job, but the actual drop has to be forced by routing the
  // WebSocket and closing the page's side of it -- a real close, on the
  // real connection, not a mock. Closing one side closes the other by
  // default, so the Worker sees a genuine disconnect too.
  // An object wrapper, not a bare `let`: TypeScript's control-flow
  // narrowing treats a `let x: T | null = null` mutated only inside a
  // passed-in callback as staying `null` forever at every later read site
  // (narrows the post-`?.` branch to `never`), even though the callback
  // demonstrably runs before that read. A property on a `const` object
  // does not fall into that trap.
  const clientSocket: { route: WebSocketRoute | null } = { route: null };
  await context.routeWebSocket(/\/rooms\/[^/]+\/ws$/, (ws) => {
    ws.connectToServer();
    clientSocket.route = ws;
  });

  await page.goto("/");
  await page.getByLabel(/lot name/i).fill("Reconnect lot");
  await page.getByRole("button", { name: /open an auction/i }).click();

  await page.getByLabel(/your bid/i).fill("300");
  await page.getByRole("button", { name: /place bid/i }).click();
  await expect(page.getByTestId("display-price")).toHaveText("300");

  // Drop the network: block new connection attempts, then kill the live
  // one. Confirm the UI admits it, then restore it.
  await context.setOffline(true);
  await clientSocket.route?.close({ code: 1006, reason: "simulated network drop" });
  await expect(page.getByRole("status")).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  // The price survived the round trip: no duplicate, no loss.
  await expect(page.getByTestId("display-price")).toHaveText("300");

  if (hydrationWarnings.length > 0) {
    console.warn(
      `[hydration-warning] ${hydrationWarnings.length} hydration-related console error(s) observed:\n` +
        hydrationWarnings.map((w, i) => `  ${i + 1}. ${w}`).join("\n")
    );
  }
});
