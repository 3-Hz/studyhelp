"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/dashboard", label: "Dashboard", match: "/dashboard" },
  { href: "/lectures/new", label: "Add lecture", match: "/lectures" },
];

const inactiveClass =
  "text-sm text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100";
const activeClass = "text-sm text-stone-900 dark:text-stone-100";

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="mx-auto flex max-w-6xl items-baseline gap-6 px-6 py-4">
      <Link href="/" className="font-semibold tracking-tight">
        studyhelp
      </Link>
      {tabs.map(({ href, label, match }) => {
        const isActive =
          pathname === match || pathname.startsWith(`${match}/`);
        return (
          <Link
            key={href}
            href={href}
            className={isActive ? activeClass : inactiveClass}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
