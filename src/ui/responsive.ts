import { useEffect, useState } from "react";

export const MOBILE_WINDOW_QUERY = "(max-width: 620px)";
export const COMPACT_CHROME_QUERY = "(max-width: 900px), (max-height: 520px)";
export const TOUCH_PRIMARY_QUERY = "(hover: none), (pointer: coarse)";

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}
