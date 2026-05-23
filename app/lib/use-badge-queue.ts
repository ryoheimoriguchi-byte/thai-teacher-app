"use client";

import { useCallback, useEffect, useState } from "react";

export type QueuedBadge = {
  module: string;
  category: string;
  threshold: number;
};

/** Stage Up が閉じたあと、キュー内のバッジを1件ずつ表示する */
export function useBadgeQueue(stageUpOpen: boolean) {
  const [badgeQueue, setBadgeQueue] = useState<QueuedBadge[]>([]);
  const [currentBadge, setCurrentBadge] = useState<QueuedBadge | null>(null);

  const enqueueBadges = useCallback((items: QueuedBadge[]) => {
    if (items.length === 0) return;
    setBadgeQueue((prev) => [...prev, ...items]);
  }, []);

  useEffect(() => {
    if (currentBadge !== null) return;
    if (badgeQueue.length === 0) return;
    if (stageUpOpen) return;
    setCurrentBadge(badgeQueue[0]);
    setBadgeQueue((prev) => prev.slice(1));
  }, [currentBadge, badgeQueue, stageUpOpen]);

  const handleBadgeClose = useCallback(() => {
    setCurrentBadge(null);
  }, []);

  return {
    currentBadge,
    enqueueBadges,
    handleBadgeClose,
  };
}
