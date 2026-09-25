// src/lib/http.ts
// Shared helpers so every route validates input and reports errors the same way.

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ValidationError, VaultError } from "@/lib/errors";

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}

export function ok(data: Record<string, unknown>, status = 200) {
  return NextResponse.json({ success: true, ...data }, { status });
}

export function fail(err: unknown) {
  if (err instanceof VaultError) {
    return NextResponse.json(
      { success: false, error: err.message, code: err.code, details: err.details ?? null },
      { status: err.status }
    );
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { success: false, error: "Invalid request", code: "INVALID_REQUEST", details: err.issues },
      { status: 400 }
    );
  }
  console.error("[vault] unhandled error:", err);
  return NextResponse.json(
    { success: false, error: err instanceof Error ? err.message : String(err), code: "INTERNAL_ERROR" },
    { status: 500 }
  );
}