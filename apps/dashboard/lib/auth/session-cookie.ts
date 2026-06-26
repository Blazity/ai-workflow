import { cookies } from "next/headers";

const SEVEN_DAYS = 60 * 60 * 24 * 7;

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set("ba_session", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SEVEN_DAYS,
  });
}
