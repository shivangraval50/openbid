import { test, expect, type Browser, type ConsoleMessage, type Page } from "@playwright/test";

// Requirement 2 (task-17 brief): Countdown, PriceChart, and (as it turns
// out) Latency derive values from a clock read during both SSR and client
// hydration. Real elapsed time between the server render and hydration can
// therefore produce a text-content hydration mismatch. Confirmed live in
// this browser on every single run of this suite: `Latency` renders "clock
// offset N ms" server-side and "clock synced" client-side (see
// task-17-report.md for the exact text and root cause). React 19 surfaces
// this as an *uncaught exception* on the page (`page.on("pageerror")`), not
// merely a `console.error` -- an assumption worth stating plainly since it
// is easy to listen for the wrong event and see nothing. Both are watched
// here regardless, since which channel carries it is itself something this
// suite should not have to assume. This does not assert on it (that is a
// product-code question for someone else to rule on, not something this
// suite silences or launders into a passing assertion) -- it only surfaces
// it so a human reading the run output cannot miss it.
function watchForHydrationWarnings(page: Page, sink: string[]): void {
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/hydrat/i.test(text)) sink.push(text);
  });
  page.on("pageerror", (err) => {
    if (/hydrat/i.test(err.message)) sink.push(err.message);
  });
}

// Next.js's App Router injects its own offscreen route announcer -- an
// element that is *also* role="alert" -- to tell screen readers a
// navigation happened. It is present on every page in this app, completely
// unrelated to bidding, and briefly holds the new route's title text right
// after a navigation. A bare `page.getByRole("alert")` therefore always
// finds at least one match on both bidders' pages regardless of whether
// either bid was actually rejected, which silently made the very race
// assertion below untestable (it always saw two "alerts" and never one).
// BidForm's own rejection message is the only role="alert" element that
// lives inside the bid <form>, so scoping to that is what distinguishes
// "this bidder was rejected" from "this page merely navigated once."
function rejectionAlert(page: Page) {
  return page.locator('form p[role="alert"]');
}

async function openRoom(browser: Browser, roomUrl: string, hydrationWarnings: string[]): Promise<Page> {
  // A separate context per bidder: separate cookies, so separate guest identity.
  const context = await browser.newContext();
  const page = await context.newPage();
  watchForHydrationWarnings(page, hydrationWarnings);
  await page.goto(roomUrl);
  await expect(page.getByTestId("display-price")).toBeVisible();
  return page;
}

test("two bidders racing: exactly one wins and both views converge", async ({ browser, page }) => {
  const hydrationWarnings: string[] = [];
  watchForHydrationWarnings(page, hydrationWarnings);

  await page.goto("/");
  await page.getByLabel(/lot name/i).fill("Race condition, the lot");
  await page.getByRole("button", { name: /open an auction/i }).click();
  await expect(page).toHaveURL(/\/rooms\//);
  const roomUrl = page.url();

  const ada = await openRoom(browser, roomUrl, hydrationWarnings);
  const grace = await openRoom(browser, roomUrl, hydrationWarnings);

  // Same amount, dispatched as close to simultaneously as the harness allows.
  const amount = "500";
  await ada.getByLabel(/your bid/i).fill(amount);
  await grace.getByLabel(/your bid/i).fill(amount);

  await Promise.all([
    ada.getByRole("button", { name: /place bid/i }).click(),
    grace.getByRole("button", { name: /place bid/i }).click(),
  ]);

  // Exactly one of them must see a rejection; the DO serialises the pair.
  // Polled, not read once: `click()` resolves as soon as the click is
  // dispatched and the optimistic bid is queued, not once the server's
  // "reject" message has made its round trip back over the socket. Reading
  // the count exactly once right after `Promise.all` raced that round trip
  // and intermittently observed neither rejection having landed yet
  // (0 rather than 1) -- a real flake in this exact assertion, reproduced
  // directly while writing this suite. `expect.poll` retries the same
  // "exactly one" check until it holds or the timeout elapses; it never
  // loosens it to "at least one".
  await expect
    .poll(
      async () => {
        const rejections = await Promise.all([
          rejectionAlert(ada).count(),
          rejectionAlert(grace).count(),
        ]);
        return rejections.filter((n) => n > 0).length;
      },
      { timeout: 15_000 }
    )
    .toBe(1);

  // And both must settle on the same authoritative price -- explicitly
  // including the winner's own screen. Task 11 found a real bug where
  // RoomDO acked before broadcasting the matching delta and the store
  // advanced lastSeenSeq on the ack, so the winner's own client discarded
  // its own winning delta as a duplicate and kept showing the *previous*
  // price while everyone else saw the new one. A converge check that only
  // looked at the loser's screen would have passed with that bug live.
  await expect(ada.getByTestId("display-price")).toHaveText(amount);
  await expect(grace.getByTestId("display-price")).toHaveText(amount);

  // Report, don't silence: log (never assert on) any hydration warning
  // observed on any of the three pages in this test.
  if (hydrationWarnings.length > 0) {
    console.warn(
      `[hydration-warning] ${hydrationWarnings.length} hydration-related console error(s) observed:\n` +
        hydrationWarnings.map((w, i) => `  ${i + 1}. ${w}`).join("\n")
    );
  }
});

test("a losing bid rolls back rather than sticking on screen", async ({ browser, page }) => {
  const hydrationWarnings: string[] = [];
  watchForHydrationWarnings(page, hydrationWarnings);

  await page.goto("/");
  await page.getByLabel(/lot name/i).fill("Rollback lot");
  await page.getByRole("button", { name: /open an auction/i }).click();
  // createRoom is a Server Action that redirects only once its async work
  // (initRoom + registerRoomWithRetry) finishes -- click() resolves as soon
  // as the click is dispatched, not once that navigation lands. Grabbing
  // page.url() before this wait is a real race that intermittently handed
  // openRoom() below the *lobby* URL instead of the room's, observed
  // directly in a run of this suite (both new contexts opened "/" and timed
  // out looking for a display-price that page will never have).
  await expect(page).toHaveURL(/\/rooms\//);
  const roomUrl = page.url();

  const ada = await openRoom(browser, roomUrl, hydrationWarnings);
  const grace = await openRoom(browser, roomUrl, hydrationWarnings);

  await ada.getByLabel(/your bid/i).fill("900");
  await ada.getByRole("button", { name: /place bid/i }).click();
  await expect(ada.getByTestId("display-price")).toHaveText("900");

  // Grace bids below the new minimum; her optimistic price must not survive.
  await grace.getByLabel(/your bid/i).fill("150");
  await grace.getByRole("button", { name: /place bid/i }).click();
  await expect(rejectionAlert(grace)).toBeVisible();
  await expect(grace.getByTestId("display-price")).toHaveText("900");

  if (hydrationWarnings.length > 0) {
    console.warn(
      `[hydration-warning] ${hydrationWarnings.length} hydration-related console error(s) observed:\n` +
        hydrationWarnings.map((w, i) => `  ${i + 1}. ${w}`).join("\n")
    );
  }
});
