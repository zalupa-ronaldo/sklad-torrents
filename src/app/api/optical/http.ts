import { OpticalError } from "@/lib/optical/errors";

export function opticalJson(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function opticalFailure(error: unknown): Response {
  if (error instanceof OpticalError) {
    const status =
      error.code === "not_found" ? 404 : error.code === "offline" ? 503 : error.code === "forbidden" ? 403 : 400;
    return opticalJson({ error: error.message }, status);
  }
  return opticalJson({ error: "Не получилось выполнить запрос." }, 500);
}
