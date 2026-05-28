import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Workflow · Cockpit",
  description:
    "Blazity AI Workflow observability — Vercel Workflow runs, Arthur Engine evals & traces, and AI Gateway cost.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Rethink+Sans:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
