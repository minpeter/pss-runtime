// Minimal Standard Schema v1 types. pss-runtime does not depend on Zod; any
// Standard-Schema-compliant validator (Zod, Valibot, ArkType, ...) is accepted
// via this structural type, so the evals subpath stays dependency-free.

export interface StandardSchemaResult {
  readonly issues?: readonly { readonly message: string }[];
  readonly value?: unknown;
}

export interface StandardSchemaV1 {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => StandardSchemaResult | Promise<StandardSchemaResult>;
  };
}
