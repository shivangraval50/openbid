import type { ReactNode } from "react";

export const metadata = {
  title: "openbid",
  description: "A live multi-user auction, authoritative on the server.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
