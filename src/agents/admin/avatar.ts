import { AVATAR_IMAGE_MODEL_ID } from "@/config";

/** A generated avatar: raw image bytes plus the MIME type to serve them under. */
export interface GeneratedImage {
  data: Uint8Array<ArrayBuffer>;
  contentType: string;
}

export interface AvatarPromptInput {
  /** The workspace this admin agent belongs to — anchors the avatar's identity. */
  workspaceName: string;
  /** Optional extra art direction from the admin/user (style, colors, motifs). */
  instructions?: string;
}

/**
 * Compose the text-to-image prompt for an admin avatar. The workspace name grounds
 * the result in the team it represents; any caller-supplied `instructions` are
 * folded in as additional art direction.
 */
export function buildAvatarPrompt(input: AvatarPromptInput): string {
  const base =
    `A clean, modern square slack avatar for the "${input.workspaceName}" team's ` +
    `admin assistant — a friendly, professional mascot or emblem.`;
  const direction = input.instructions?.trim();
  const style =
    "Flat vector style, bold simple shapes, centered composition, solid background, " +
    "no text, no lettering.";
  return [base, direction, style].filter(Boolean).join(" ");
}

/**
 * Generate an avatar via Workers AI. Isolated here (like `embed()` in shared/recall)
 * so the AI binding call is the only impure part. FLUX.2 returns the image as a
 * base64-encoded JPEG in `{ image }`; we decode it to bytes for DO storage.
 */
export async function generateAvatar(
  env: Env,
  prompt: string
): Promise<GeneratedImage> {
  // The `Ai` binding overloads don't cover the preview model id, so cast like
  // shared/recall does for the embedding model.
  const res = (await env.AI.run(
    AVATAR_IMAGE_MODEL_ID as Parameters<Ai["run"]>[0],
    { prompt } as Parameters<Ai["run"]>[1]
  )) as { image?: string };

  if (!res?.image) {
    throw new Error("image model returned no image data");
  }
  const binary = atob(res.image);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  return { data, contentType: "image/jpeg" };
}
