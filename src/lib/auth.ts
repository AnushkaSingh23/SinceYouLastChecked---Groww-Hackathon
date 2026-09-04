// Lightweight identity — a handle, no password (see PRD.md non-goals: no
// OAuth in v1). The same handle on any device/browser resolves to the same
// persisted user, which is what "persists across sessions/devices" means in
// practice here: not device-local storage, an honest account-less account.

import { cookies } from "next/headers";
import { prisma } from "./prisma";

const COOKIE_NAME = "watchlist_user_id";

export async function getCurrentUserId(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

export async function identify(handle: string): Promise<{ id: string; handle: string }> {
  const trimmed = handle.trim();
  if (!trimmed) throw new Error("Handle cannot be empty");

  const user = await prisma.user.upsert({
    where: { handle: trimmed },
    update: {},
    create: { handle: trimmed },
  });

  const store = await cookies();
  store.set(COOKIE_NAME, user.id, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });

  return { id: user.id, handle: user.handle };
}

export async function requireCurrentUser() {
  const userId = await getCurrentUserId();
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}
