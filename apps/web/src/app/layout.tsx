import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import styles from "./layout.module.css";

export const metadata = {
  title: "openbid",
  description: "A live multi-user auction, authoritative on the server.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className={styles.shell}>
          {/* A slim sticky header, not a native navigation bar: there is no
              back chevron and no tab bar, because the browser already owns
              that job and duplicating native chrome in a web app reads as
              costume. See layout.module.css for the guideline this does
              follow. */}
          <header className={styles.header}>
            <Link href="/" className={styles.wordmark}>
              open<span className={styles.wordmarkAccent}>bid</span>
            </Link>
            <nav className={styles.nav} aria-label="Sections">
              <Link href="/leaderboard" className={styles.navLink}>
                Leaderboard
              </Link>
            </nav>
          </header>
          {/* One width-constraining container for every route, so the
              measure and gutters are identical page to page. Each page still
              renders its own <main> landmark inside it. */}
          <div className={styles.main}>{children}</div>
          <footer className={styles.footer}>
            Server-authoritative bidding — one Durable Object per room.
          </footer>
        </div>
      </body>
    </html>
  );
}
