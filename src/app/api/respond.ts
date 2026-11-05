import { OpticalError } from "@/lib/optical/errors";
import { AppError } from "@/lib/app-error";
import { errorMessage, QbittorrentError } from "@/lib/qbittorrent/errors";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function guard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    return json({ error: errorMessage(error) }, statusFor(error));
  }
}

function statusFor(error: unknown): number {
  if (error instanceof AppError) return error.status;
  if (error instanceof OpticalError) {
    if (error.code === "not_found") return 404;
    if (error.code === "conflict") return 409;
    if (error.code === "offline") return 503;
    if (error.code === "forbidden") return 403;
    return 400;
  }
  if (!(error instanceof QbittorrentError)) return 500;
  switch (error.code) {
    case "validation":
      return 400;
    case "auth":
      return 401;
    case "not_found":
      return 404;
    default:
      return 502;
  }
}
