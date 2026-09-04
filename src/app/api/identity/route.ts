import { NextResponse } from "next/server";
import { identify, requireCurrentUser } from "@/lib/auth";

export async function GET() {
  const user = await requireCurrentUser();
  return NextResponse.json({ user: user ? { id: user.id, handle: user.handle } : null });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const handle = typeof body?.handle === "string" ? body.handle : "";

  try {
    const user = await identify(handle);
    return NextResponse.json({ user });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid handle" }, { status: 400 });
  }
}
