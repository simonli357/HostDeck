import { z } from "zod";
import { exactDataObject } from "./exact-data-object.js";
import { sharedSessionTargetIdSchema } from "./shared-codex-runtime.js";

export const sessionIdParamsSchema = exactDataObject(
  z
    .object({
      session_id: sharedSessionTargetIdSchema
    })
    .strict()
);

export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
