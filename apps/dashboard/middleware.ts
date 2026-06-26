import { NextResponse, type NextRequest } from "next/server";

/**
 * Cheap presence check: any page navigation without a ba_session cookie is
 * redirected to /login. Real validation happens server-side in the cockpit
 * layout (requireSession). API routes (/api/**), public auth pages, and Next
 * internals are excluded — protected /api proxies are gated by getJSON's
 * cookie requirement.
 */
export function middleware(req: NextRequest) {
  if (req.cookies.has("ba_session")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|login|forgot-password|reset-password|invite/accept).*)",
  ],
};
