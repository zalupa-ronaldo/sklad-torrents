import { guard, json } from "@/app/api/respond";
import { setContentOverride } from "@/lib/policies/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json()) as {
      hostId?: string;
      hash?: string;
      kind?: string;
      gameSubtype?: string | null;
      clear?: boolean;
    };
    await setContentOverride({
      hostId: String(body.hostId ?? ""),
      hash: String(body.hash ?? ""),
      kind: body.kind,
      gameSubtype: body.gameSubtype,
      clear: Boolean(body.clear),
    });
    return json({ ok: true });
  });
}
