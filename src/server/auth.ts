import { demoUser } from "@/data/demo";
import type { AppUser, UserRole } from "@/domain/access";
import { isAllowedCorporateEmail, parseAllowedDomains } from "@/domain/access";
import { getAdminAuth, hasFirebaseAdminConfig } from "@/lib/firebase/admin";

const DEFAULT_ALLOWED_DOMAIN = "example.co.jp";

export async function requireAppUser(request: Request): Promise<AppUser> {
  const allowedDomains = parseAllowedDomains(
    process.env.ALLOWED_EMAIL_DOMAINS ?? DEFAULT_ALLOWED_DOMAIN,
  );

  if (isDemoAuthAllowed()) {
    const email = request.headers.get("x-demo-email") ?? demoUser.email;
    if (!isAllowedCorporateEmail(email, allowedDomains)) {
      throw new Response("社内ドメインのアカウントのみ閲覧できます。", { status: 403 });
    }
    return {
      ...demoUser,
      email,
      role: getRoleForEmail(email),
    };
  }

  if (!hasFirebaseAdminConfig()) {
    throw new Response("Firebase Admin設定が不足しています。", { status: 500 });
  }

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    throw new Response("認証が必要です。", { status: 401 });
  }

  const decoded = await getAdminAuth().verifyIdToken(token);
  const email = decoded.email;
  if (!isAllowedCorporateEmail(email, allowedDomains)) {
    throw new Response("社内ドメインのアカウントのみ閲覧できます。", { status: 403 });
  }

  return {
    uid: decoded.uid,
    email: email ?? "",
    displayName: decoded.name,
    role: getRoleForEmail(email, decoded.role as UserRole | undefined),
  };
}

function isDemoAuthAllowed(): boolean {
  return process.env.ALLOW_DEMO_AUTH === "true" || !hasFirebaseAdminConfig();
}

function getRoleForEmail(email?: string, claimRole?: UserRole): UserRole {
  if (claimRole) return claimRole;
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (email && adminEmails.includes(email.toLowerCase())) return "admin";
  return process.env.DEFAULT_USER_ROLE === "sales_member" ? "sales_member" : "viewer";
}
