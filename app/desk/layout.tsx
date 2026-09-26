"use client";

import { Suspense } from "react";
import { Shell } from "@/components/Shell";

export default function DeskLayout({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <Suspense fallback={<main className="page">Loading…</main>}>{children}</Suspense>
    </Shell>
  );
}
