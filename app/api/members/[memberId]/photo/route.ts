import {
  fetchMicrosoftProfilePhoto,
  getMicrosoftProfilePhotoAccessToken,
} from "@/integrations/microsoftGraph";
import { requireAppUser } from "@/server/auth";
import { getMemberStore } from "@/server/memberStore";

const PRIVATE_PHOTO_CACHE = "private, max-age=300, must-revalidate";

export async function GET(
  request: Request,
  context: { params: Promise<{ memberId: string }> },
) {
  try {
    await requireAppUser(request);
  } catch (error) {
    if (error instanceof Response) return error;
    return unavailableResponse();
  }

  try {
    const { memberId } = await context.params;
    const member = await getMemberStore().getActiveMemberById(memberId);
    if (!member) return notFoundResponse();

    const photo = await fetchMicrosoftProfilePhoto({
      accessToken: await getMicrosoftProfilePhotoAccessToken(),
      userPrincipalName: member.microsoftEmail,
    });
    if (!photo) return notFoundResponse();

    const responseBody = new Uint8Array(photo.bytes.byteLength);
    responseBody.set(photo.bytes);
    return new Response(responseBody.buffer, {
      status: 200,
      headers: {
        "cache-control": PRIVATE_PHOTO_CACHE,
        "content-length": String(photo.bytes.byteLength),
        "content-type": photo.contentType,
        vary: "Authorization",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return unavailableResponse();
  }
}

function notFoundResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      "cache-control": PRIVATE_PHOTO_CACHE,
      vary: "Authorization",
      "x-content-type-options": "nosniff",
    },
  });
}

function unavailableResponse(): Response {
  return new Response(null, {
    status: 502,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
