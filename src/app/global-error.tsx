"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ru">
      <body>
        <p>Панель не открылась.</p>
        <button type="button" onClick={() => reset()}>
          Ещё раз
        </button>
      </body>
    </html>
  );
}
