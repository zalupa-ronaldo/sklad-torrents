"use client";

import { useEffect } from "react";

/** Opens the designer games screen. Demo cards stay behind ?demo=1. */
export function GamesRedirect({ demo }: { demo: boolean }) {
  useEffect(() => {
    const query = demo ? "?demo=1" : "";
    window.location.replace("/prototype/index.html" + query + "#games");
  }, [demo]);
  return <p>Открывается библиотека игр.</p>;
}
