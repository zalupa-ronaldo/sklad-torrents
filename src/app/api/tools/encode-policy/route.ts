import { readEncodePolicy, writeEncodePolicy } from "@/lib/transcode/policy";

import { json, readBody, toolsGuard } from "@/app/api/tools/guard";

export const runtime = "nodejs";

export async function GET() {
  return toolsGuard(async () => {
    const policy = await readEncodePolicy();
    return json({ replaceOriginal: policy.replaceOriginal === true });
  });
}

export async function PUT(request: Request) {
  return toolsGuard(async () => {
    const body = await readBody(request);
    const policy = await writeEncodePolicy({ replaceOriginal: body.replaceOriginal === true });
    return json({ replaceOriginal: policy.replaceOriginal === true });
  });
}
