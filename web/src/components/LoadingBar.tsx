import { useState, useEffect } from "react";

interface Props {
  loading: boolean;
}

/**
 * Thin progress bar pinned to the very top of the screen.
 * Simulates incremental progress while loading, snaps to 100% on done.
 */
export function LoadingBar({ loading }: Props) {
  const [pct, setPct] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (loading) {
      setVisible(true);
      setPct(15);
      const t1 = setTimeout(() => setPct(40), 300);
      const t2 = setTimeout(() => setPct(65), 900);
      const t3 = setTimeout(() => setPct(80), 2000);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    } else {
      setPct(100);
      const t = setTimeout(() => { setVisible(false); setPct(0); }, 350);
      return () => clearTimeout(t);
    }
  }, [loading]);

  if (!visible) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50 h-[2px] bg-transparent pointer-events-none">
      <div
        className="h-full bg-gray-900 transition-all ease-out"
        style={{
          width: `${pct}%`,
          transitionDuration: pct === 100 ? "200ms" : "400ms",
        }}
      />
    </div>
  );
}
