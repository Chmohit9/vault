import { collectPrometheusMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const body = await collectPrometheusMetrics();
    return new Response(body, { status: 200, headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`# Vault metrics collection failed: ${message.replace(/\n/g, " ")}\n`, { status: 500, headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" } });
  }
}
