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
  if (trimmed.length > 40) throw new Error("Handle must be 40 characters or fewer");

  const user = await prisma.user.upsert({
    where: { handle: trimmed },
    update: {},
    create: { handle: trimmed },
  });

  const store = await cookies();
  store.set(COOKIE_NAME, user.id, {
    httpOnly: true,
    sameSite: "lax",
    // Never send the session over plaintext HTTP in a deployed build.
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });

  return { id: user.id, handle: user.handle };
}

/**
 * Clears the session cookie, returning the browser to the identity gate.
 *
 * Not cosmetic: without it the ONLY way to switch handle is manually clearing
 * cookies, because the cookie is httpOnly and lives for a year. That's a real
 * problem in a demo — hand the laptop to someone who types their own name and
 * you can't get back to your own watchlist without opening devtools.
 */
export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function requireCurrentUser() {
  const userId = await getCurrentUserId();
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}
