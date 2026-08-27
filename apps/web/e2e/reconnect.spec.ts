import { test, expect, type ConsoleMessage, type WebSocketRoute } from "@playwright/test";

test("a dropped connection rebases without losing bids", async ({ page, context, browser }) => {
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
  // default, so the Worker sees a genuine disconnect too -- PROVIDED the
  // close code is one the WebSocket spec actually allows an endpoint to
  // send (see the `close()` call below; 1006 is not).
  //
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
  await expect(page).toHaveURL(/\/rooms\//);
  const roomUrl = page.url();

  await page.getByLabel(/your bid/i).fill("300");
  await page.getByRole("button", { name: /place bid/i }).click();
  await expect(page.getByTestId("display-price")).toHaveText("300");

  // Drop the network: block new connection attempts, then kill the live
  // one. Confirm the UI admits it.
  //
  // Close code 1006 ("abnormal closure") is reserved by the WebSocket spec
  // -- an endpoint may never *send* it, only report it after the fact --
  // so a real `WebSocket.close(1006, ...)` throws `InvalidAccessError`.
  // Playwright's `WebSocketRoute.close()` still synthesizes a close on the
  // *page* side either way (which is why the banner below did appear even
  // with code 1006), but the mirrored close it attempts on the real
  // server-side connection throws that same error, gets swallowed, and
  // never happens -- so the Worker's socket leaked, open, forever, and the
  // "genuine disconnect" claimed above was only ever half true.
  //
  // Verified directly against this project's actual Chromium (not just the
  // spec text) which codes an endpoint may send via `close()`: only 1000,
  // or any integer 3000-4999. 1001 -- suggested as an alternative during
  // review -- throws the exact same `InvalidAccessError` as 1006 in this
  // browser; only 1000 and the 3000-4999 range actually worked when tried
  // directly. 4000 is used here, in that allowed custom range, so this
  // closes both sides for real.
  await context.setOffline(true);
  await clientSocket.route?.close({ code: 4000, reason: "simulated network drop" });
  await expect(page.getByRole("status")).toBeVisible();

  // While the first bidder is offline, a second, independent bidder raises
  // the price. This is the actual gap the "no loss, no duplication" claim
  // needs exercised: with nothing happening during the outage, an
  // implementation whose resume replayed *nothing* (or duplicated the
  // existing bid) would look identical to a correct one -- the price
  // would trivially still read "300" either way. Only a real intervening
  // event, replayed correctly on reconnect, distinguishes them.
  const secondBidderContext = await browser.newContext();
  const secondBidderPage = await secondBidderContext.newPage();
  await secondBidderPage.goto(roomUrl);
  await expect(secondBidderPage.getByTestId("display-price")).toBeVisible();
  await secondBidderPage.getByLabel(/your bid/i).fill("900");
  await secondBidderPage.getByRole("button", { name: /place bid/i }).click();
  await expect(secondBidderPage.getByTestId("display-price")).toHaveText("900");

  // Restore the first bidder's connection.
  await context.setOffline(false);
  await expect(page.getByRole("status")).toBeHidden({ timeout: 30_000 });

  // The first bidder must converge on the price that changed while she was
  // gone -- the DO's replay-on-`hello` (bounded by `lastSeenSeq`) doing its
  // job, not "nothing happened so nothing needed replaying." Not "300"
  // (lost the update) and not stuck mid-reconnect: exactly "900".
  await expect(page.getByTestId("display-price")).toHaveText("900");
  await expect(page.getByTestId("pending")).toHaveCount(0);

  if (hydrationWarnings.length > 0) {
    console.warn(
      `[hydration-warning] ${hydrationWarnings.length} hydration-related console error(s) observed:\n` +
        hydrationWarnings.map((w, i) => `  ${i + 1}. ${w}`).join("\n")
    );
  }
});
