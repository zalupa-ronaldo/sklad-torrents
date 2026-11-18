import { guard, json } from "@/app/api/respond";
import { handleLibraryCommand, readWindowsLibrary } from "@/lib/windows-library/adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => json(await readWindowsLibrary()));
}

export async function POST(request: Request) {
  return guard(async () => json(await handleLibraryCommand(await request.json())));
}
