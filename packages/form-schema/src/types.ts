/**
 * TypeScript view of contracts/form-definition.schema.json (format 1.0).
 * Structural validation is generated from the contract itself; these types
 * must stay in step with it (the example contract is checked against both).
 */

export const SCHEMA_VERSION = "1.0" as const;

export const FIELD_TYPES = [
  "text",
  "textarea",
  "email",
  "phone",
  "url",
  "integer",
  "decimal",
  "date",
  "time",
  "dropdown",
  "radio",
  "multi_select",
  "checkbox",
  "consent",
  "rating",
  "file",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface ChoiceOption {
  id: string;
  label: string;
}

export interface FieldSettings {
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  options?: ChoiceOption[];
  minSelections?: number;
  maxSelections?: number;
  allowedMimeTypes?: string[];
  maxFileBytes?: number;
  maxFiles?: number;
  consentTextVersion?: string;
}

/**
 * How sensitive a field's answers are (docs/06 §3). Reviewers need a matching
 * permission to see personal or sensitive answers; without it they are masked
 * in responses, filters, downloads and exports.
 */
export const PRIVACY_CLASSES = ["ordinary", "personal", "sensitive"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

export interface Field {
  id: string;
  type: FieldType;
  label: string;
  helpText?: string;
  required: boolean;
  /** Overrides the field type's default classification. */
  privacy?: PrivacyClass;
  settings: FieldSettings;
}

export interface Page {
  id: string;
  title: string;
  fieldIds: string[];
}

export const COMPARISON_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];
export const PRESENCE_OPERATORS = ["isEmpty", "isNotEmpty"] as const;
export type PresenceOperator = (typeof PRESENCE_OPERATORS)[number];
export type Operator = ComparisonOperator | PresenceOperator;
export type Literal = string | number | boolean;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fieldId: string; op: ComparisonOperator; value: Literal }
  | { fieldId: string; op: PresenceOperator };

export type FieldRuleAction = {
  type: "setVisibility" | "setRequired";
  targetFieldId: string;
  onTrue: boolean;
  onFalse: boolean;
};

export type PageRuleAction = {
  type: "skipToPage";
  sourcePageId: string;
  targetPageId: string;
};

export type RuleAction = FieldRuleAction | PageRuleAction;

export interface Rule {
  id: string;
  when: Condition;
  action: RuleAction;
}

export interface Theme {
  accent: string;
  background: string;
  text: string;
  radius: number;
}

export interface FormDefinition {
  schemaVersion: typeof SCHEMA_VERSION;
  title: string;
  description?: string;
  locale: string;
  pages: Page[];
  fields: Field[];
  rules: Rule[];
  theme: Theme;
  success: { message: string };
}
