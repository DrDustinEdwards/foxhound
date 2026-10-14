import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";

// When the page's data was last read: the server's time on the first load,
// then each time a navigation, a form or a revalidation finishes (every one
// re-runs the page's loader). The page bar says it in words ("Updated 2
// minutes ago"), so nobody reads minutes-old numbers as live.
export function useReadAt(serverReadAt: number): number {
  const [readAt, setReadAt] = useState(serverReadAt);
  const navigation = useNavigation();
  const { key } = useLocation();
  const wasBusy = useRef(false);
  useEffect(() => {
    if (navigation.state !== "idle") {
      wasBusy.current = true;
    } else if (wasBusy.current) {
      wasBusy.current = false;
      setReadAt(Date.now());
    }
  }, [navigation.state, key]);
  return readAt;
}
