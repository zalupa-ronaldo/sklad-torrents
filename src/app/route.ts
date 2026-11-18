import { prototypeHtml } from "@/prototype/serve-home";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const html = await prototypeHtml();
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
