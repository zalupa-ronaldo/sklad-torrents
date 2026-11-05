import { ToolsError, toolsErrorMessage } from "@/addons/media-games/errors";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function toolsGuard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    return json({ error: toolsErrorMessage(error) }, statusFor(error));
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ToolsError("validation", "Пустое тело запроса.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ToolsError) throw error;
    throw new ToolsError("validation", "Не удалось разобрать запрос.");
  }
}

function statusFor(error: unknown): number {
  if (!(error instanceof ToolsError)) return 500;
  if (error.code === "not_found") return 404;
  return 400;
}
