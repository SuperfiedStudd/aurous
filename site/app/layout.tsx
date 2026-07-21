import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aurous — Productivity Resolved",
  description: "A clear, safe guide to installing and using Aurous.",
  icons: { icon: "/aurous-logo.png" },
  openGraph: {
    title: "Aurous — Productivity Resolved",
    description: "A clear, safe guide to installing and using Aurous.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Aurous — Productivity Resolved" }],
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
