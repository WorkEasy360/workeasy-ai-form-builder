// Types for the generated standalone validator (validate-definition.js).
export interface AjvError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

export declare const validate: ((data: unknown) => boolean) & { errors?: AjvError[] | null };
export default validate;
