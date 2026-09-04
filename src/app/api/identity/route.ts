import { NextResponse } from "next/server";
import { identify, requireCurrentUser, signOut } from "@/lib/auth";

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

// Sign out = drop the session cookie. There is nothing server-side to revoke
// (the cookie IS the session), so this is the whole operation.
export async function DELETE() {
  await signOut();
  return NextResponse.json({ ok: true });
}
