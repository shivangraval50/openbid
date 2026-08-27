/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@openbid/auction-core", "@openbid/protocol", "@openbid/store", "@openbid/charts"],
  // The Playwright config (apps/web/playwright.config.ts) drives the app
  // via http://127.0.0.1:3000, not http://localhost:3000. Next's dev-only
  // cross-origin guard does not treat those as the same origin by default,
  // so it silently refuses every HMR/static-chunk request from the
  // Playwright-driven browser -- the page loads its server-rendered HTML
  // but client JS never arrives, so nothing ever hydrates and the bid
  // button (disabled until the socket effect runs) never enables. This is
  // dev-server wiring, not auction behaviour -- see task-17-report.md.
  allowedDevOrigins: ["127.0.0.1"],
};
