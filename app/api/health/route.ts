import { NextResponse } from "next/server";
export const runtime = "nodejs";
export async function GET() {
  const baseURL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
  try {
    const r = await fetch(`${baseURL}/api/tags`, { cache: "no-store" });
    const j = await r.json();
    return NextResponse.json({ ok: true, baseURL, models: j });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, baseURL, error: String(e) },
      { status: 500 }
    );
  }
}
