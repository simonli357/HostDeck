import { z } from "zod";
import { exactDataObject } from "./exact-data-object.js";
import { sessionIdSchema } from "./scalars.js";

export const sessionIdParamsSchema = exactDataObject(
  z
    .object({
      session_id: sessionIdSchema
    })
    .strict()
);

export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;
