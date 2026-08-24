import { z } from 'zod';

export const NpubSchema = z.string().regex(/^npub1[0-9ac-hj-np-z]{10,}$/, {
  message: "Invalid npub format"
});

export const SessionIdSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/, {
  message: "Invalid session ID format"
});

export const AgentNameSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, {
  message: "Invalid agent name"
});

export const PathSchema = z.string().min(0).max(4096).refine((path) => {
  if (!path) return true;
  const dangerousPatterns = [
    /\.\./,
    /[<>:"|?*]/,
    /\x00/,
    /[\r\n]/,
  ];
  return !dangerousPatterns.some(pattern => pattern.test(path));
}, {
  message: "Invalid path characters detected"
});

export const LimitSchema = z.preprocess(
  (val) => (val === null || val === '' ? undefined : val),
  z.coerce.number().int().min(1).max(200).default(10)
);
export const OffsetSchema = z.preprocess(
  (val) => (val === null || val === '' ? undefined : val),
  z.coerce.number().int().min(0).default(0)
);

export const FilterSchema = z.string().max(100).refine((filter) => {
  const dangerousPatterns = [
    /[<>]/,
    /['"]/,
    /;/,
    /\x00/,
  ];
  return !dangerousPatterns.some(pattern => pattern.test(filter));
}, {
  message: "Invalid filter characters detected"
});

export const ArchiveListOptionsSchema = z.object({
  limit: LimitSchema,
  offset: OffsetSchema,
  filter: z.preprocess(
    (val) => (val === null || val === '' ? undefined : val),
    FilterSchema.optional()
  ).transform(val => val?.trim() || ""),
  since: z.preprocess(
    (val) => (val === null || val === '' ? undefined : val),
    z.string().datetime().optional(),
  ).transform(val => val?.trim() || ""),
  category: z.preprocess(
    (val) => (val === null || val === '' ? undefined : val),
    z.enum(['my', 'auto']).optional(),
  ).transform(val => val ?? ""),
});

export const AuthContextSchema = z.object({
  npub: NpubSchema.optional(),
  session: z.boolean(),
  isAdmin: z.boolean().default(false)
});

export const RequestMethodSchema = z.enum(['GET', 'POST', 'PUT', 'DELETE']);

export const JsonRequestSchema = z.object({
  agent: AgentNameSchema.optional(),
  prompt: z.string().max(10000).optional(),
  sessionId: SessionIdSchema.optional(),
  path: PathSchema.optional(),
  query: z.string().max(1000).optional(),
});

export type ValidatedNpub = z.infer<typeof NpubSchema>;
export type ValidatedSessionId = z.infer<typeof SessionIdSchema>;
export type ValidatedAgentName = z.infer<typeof AgentNameSchema>;
export type ValidatedPath = z.infer<typeof PathSchema>;
export type ValidatedArchiveListOptions = z.infer<typeof ArchiveListOptionsSchema>;
export type ValidatedAuthContext = z.infer<typeof AuthContextSchema>;
export type ValidatedJsonRequest = z.infer<typeof JsonRequestSchema>;

export const validateInput = <T>(schema: z.ZodSchema<T>, data: unknown): T => {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ');
      throw new Error(`Validation failed: ${errorMessages}`);
    }
    throw error;
  }
};

export const sanitizeString = (input: string): string => {
  return input
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[<>]/g, '')
    .trim();
};
