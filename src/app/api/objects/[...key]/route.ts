// src/app/api/objects/[...key]/route.ts
// GET /api/objects/<key>          -> raw object bytes (Content-Type from stored metadata)
// GET /api/objects/<key>?meta=1   -> JSON metadata: object + chunks + per-replica status/node
// Keys may contain '/', so this is a catch-all route; each segment is URL-decoded and rejoined.
import { NextRequest, NextResponse } from "next/server";
import { getObject, getObjectMeta } from "@/lib/metadata/readCoordinator";
import { effectiveReplicaStatus } from "@/config/policy";
import { fail, ok } from "@/lib/http";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

function joinKey(segments: string[]): string {
  const key = segments.map((s) => decodeURIComponent(s)).join("/");
  if (!key) throw new ValidationError("Object key is required");
  return key;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  try {
    const { key: segments } = await params;
    const key = joinKey(segments);
    const wantsMeta = req.nextUrl.searchParams.get("meta") === "1";

    if (wantsMeta) {
      const object = await getObjectMeta(key);
      return ok({
        object: {
          key: object.key,
          size: object.size,
          version: object.version,
          contentType: object.contentType,
          checksum: object.checksum,
          replicationFactor: object.replicationFactor,
          writeQuorum: object.writeQuorum,
          readQuorum: object.readQuorum,
          createdAt: object.createdAt.toISOString(),
          updatedAt: object.updatedAt.toISOString(),
          chunks: object.chunks.map((c) => ({
            index: c.index,
            size: c.size,
            checksum: c.checksum,
            replicas: c.replicas.map((r) => ({
              node: r.node.name,
              status: r.status,
              effectiveStatus: effectiveReplicaStatus(r, object.version),
              version: r.version,
              lastVerifiedAt: r.lastVerifiedAt ? r.lastVerifiedAt.toISOString() : null,
            })),
          })),
        },
      });
    }

    const result = await getObject(key);
    return new NextResponse(new Uint8Array(result.data), {
      status: 200,
      headers: {
        "Content-Type": result.contentType || "application/octet-stream",
        "Content-Length": String(result.size),
        "X-Vault-Checksum": result.checksum,
        "X-Vault-Version": String(result.version),
        "Content-Disposition": `inline; filename="${encodeURIComponent(result.key.split("/").pop() || result.key)}"`,
      },
    });
  } catch (err) {
    return fail(err);
  }
}