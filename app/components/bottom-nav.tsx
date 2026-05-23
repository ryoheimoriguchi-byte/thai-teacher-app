"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { LANGUAGE_MAP } from "@/app/lib/users";
import { getUnviewedBadgeCount } from "@/app/lib/badges";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type NavItem = {
  href: string;
  icon: string;
  label: string;
  jpOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", icon: "🏠", label: "Home" },
  { href: "/listening", icon: "🎧", label: "Listen" },
  { href: "/speaking", icon: "🎤", label: "Speak" },
  { href: "/reading", icon: "📖", label: "Read", jpOnly: true },
  { href: "/achievement", icon: "🏆", label: "Award", jpOnly: true },
  { href: "/vocabulary", icon: "⋯", label: "More" },
];

export function BottomNav() {
  const pathname = usePathname();
  const [userId, setUserId] = useState<string | null>(null);
  const [isJp, setIsJp] = useState(false);
  const [unviewedBadges, setUnviewedBadges] = useState(0);

  useEffect(() => {
    const id = localStorage.getItem("currentUserId");
    setUserId(id);
    if (!id) {
      setIsJp(false);
      setUnviewedBadges(0);
      return;
    }
    const language = LANGUAGE_MAP[id] ?? "TH";
    const jp = language === "JP";
    setIsJp(jp);
    if (!jp) {
      setUnviewedBadges(0);
      return;
    }
    getUnviewedBadgeCount(supabase, id)
      .then(setUnviewedBadges)
      .catch(() => setUnviewedBadges(0));
  }, [pathname]);

  if (!userId) return null;

  const items = NAV_ITEMS.filter((item) => !item.jpOnly || isJp);

  return (
    <nav
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9000,
        background: "#fff",
        borderTop: "1px solid #e0e0e0",
        paddingBottom: "env(safe-area-inset-bottom, 0)",
      }}
    >
      <div
        style={{
          maxWidth: "600px",
          margin: "0 auto",
          display: "flex",
          justifyContent: "space-around",
          alignItems: "stretch",
          minHeight: "56px",
        }}
      >
        {items.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const showBadge = item.href === "/achievement" && unviewedBadges > 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "2px",
                textDecoration: "none",
                color: active ? "#388E3C" : "#666",
                fontSize: "10px",
                fontWeight: active ? 700 : 400,
                padding: "6px 2px",
                position: "relative",
              }}
            >
              <span style={{ fontSize: "18px", lineHeight: 1 }}>{item.icon}</span>
              <span>{item.label}</span>
              {showBadge && (
                <span
                  style={{
                    position: "absolute",
                    top: "4px",
                    right: "calc(50% - 22px)",
                    minWidth: "16px",
                    height: "16px",
                    padding: "0 4px",
                    borderRadius: "8px",
                    background: "#e53935",
                    color: "#fff",
                    fontSize: "9px",
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {unviewedBadges > 99 ? "99+" : unviewedBadges}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
