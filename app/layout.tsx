import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dharma Service Desk",
  description: "Open source service desk with configurable workflows and HIPAA technical safeguards for PHI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
