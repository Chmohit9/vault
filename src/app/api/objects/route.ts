// src/app/api/objects/route.ts
// GET  -> list objects in the current cluster.
// POST -> upload an object. multipart/form-data: file (required), key (optional, defaults to
//         file.name), and optional replicationFactor / writeQuorum / readQuorum / ifVersion.
import { NextRequest } from "next/server";
import { putObject } from "@/lib/metadata/writeCoordinator";
import { listObjects } from "@/lib/metadata/readCoordinator";
import { ValidationError } from "@/lib/errors";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok({ objects: await listObjects() });
  } catch (err) {
    return fail(err);
  }
}

function parseOptionalInt(value: FormDataEntryValue | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a plain field, not a file`);
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be an integer`);
  return n;
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError("Multipart field 'file' is required");
    }

    const keyRaw = form.get("key");
    const key = typeof keyRaw === "string" && keyRaw.length > 0 ? keyRaw : file.name;
    if (!key) throw new ValidationError("Provide 'key', or upload a named file");

    const data = Buffer.from(await file.arrayBuffer());

    const replicationFactor = parseOptionalInt(form.get("replicationFactor"), "replicationFactor");
    const writeQuorum = parseOptionalInt(form.get("writeQuorum"), "writeQuorum");
    const readQuorum = parseOptionalInt(form.get("readQuorum"), "readQuorum");
    const ifVersion = parseOptionalInt(form.get("ifVersion"), "ifVersion");

    const result = await putObject({
      key,
      data,
      contentType: file.type || null,
      ifVersion,
      policyOverride: { replicationFactor, writeQuorum, readQuorum },
    });

    return ok({ object: result }, 201);
  } catch (err) {
    return fail(err);
  }
}