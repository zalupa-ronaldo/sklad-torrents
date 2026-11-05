import { opticalFailure, opticalJson } from "@/app/api/optical/http";
import { getAgentStatus, saveAgentBaseUrl } from "@/lib/optical/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return opticalJson(await getAgentStatus());
  } catch (error) {
    return opticalFailure(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as { baseUrl?: string };
    return opticalJson(await saveAgentBaseUrl(String(body.baseUrl ?? "")));
  } catch (error) {
    return opticalFailure(error);
  }
}
