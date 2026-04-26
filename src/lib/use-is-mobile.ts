"use client";

import { useEffect, useState } from "react";

// Treat as "mobile" when the viewport is narrow OR the device only has a
// coarse pointer (touch). Catches phones in portrait + landscape, and small
// tablets — anything where the desktop 3-column layout falls apart.
const MOBILE_QUERY = "(max-width: 900px), (pointer: coarse) and (max-width: 1024px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
