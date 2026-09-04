"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/lectures", label: "Review Lectures" },
  { href: "/practice", label: "Daily Practice" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/import", label: "Import Content" },
];

const base = "border-b-2 pb-1 text-sm transition-colors";
const inactive =
  "border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100";
const active =
  "border-stone-900 font-medium text-stone-900 dark:border-stone-100 dark:text-stone-100";

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
      <div className="flex items-center gap-6">
        {tabs.map(({ href, label }) => {
          // No tab owns /sessions: a session can be reached from either
          // Review Lectures or Daily Practice, and guessing would be wrong
          // half the time.
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={`${base} ${isActive ? active : inactive}`}
            >
              {label}
            </Link>
          );
        })}
      </div>

      <Link href="/" className="font-semibold tracking-tight">
        studyhelp
      </Link>
    </nav>
  );
}
