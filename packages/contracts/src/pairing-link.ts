import { z } from "zod";
import { selectedRawPairingCodeSchema } from "./pairing.js";
import { remoteExternalOriginSchema } from "./remote-ingress.js";

export const selectedPairingBrowserPath = "/" as const;
export const selectedPairingFragmentPrefix = "#pair=" as const;
export const selectedPairingLinkMaxLength = 171 as const;

export const selectedPairingFragmentSchema = z
  .string()
  .regex(/^#pair=[A-Za-z0-9_-]{22}$/u);

export const selectedPairingLinkInputSchema = z
  .object({
    external_origin: remoteExternalOriginSchema,
    code: selectedRawPairingCodeSchema
  })
  .strict();

export const selectedPairingLinkSchema = z
  .string()
  .min(1)
  .max(selectedPairingLinkMaxLength)
  .superRefine((value, context) => {
    const parsed = parseUrl(value);
    if (
      parsed === null ||
      parsed.toString() !== value ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== selectedPairingBrowserPath ||
      parsed.search !== "" ||
      !selectedPairingFragmentSchema.safeParse(parsed.hash).success ||
      !remoteExternalOriginSchema.safeParse(parsed.origin).success
    ) {
      context.addIssue({
        code: "custom",
        message: "Pairing link must be one canonical private HTTPS origin with the raw code only in its fragment."
      });
    }
  });

export function createSelectedPairingLink(input: SelectedPairingLinkInput): SelectedPairingLink {
  const parsed = selectedPairingLinkInputSchema.parse(input);
  return selectedPairingLinkSchema.parse(
    `${parsed.external_origin}${selectedPairingBrowserPath}${selectedPairingFragmentPrefix}${parsed.code}`
  );
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export type SelectedPairingLinkInput = z.infer<typeof selectedPairingLinkInputSchema>;
export type SelectedPairingLink = z.infer<typeof selectedPairingLinkSchema>;
