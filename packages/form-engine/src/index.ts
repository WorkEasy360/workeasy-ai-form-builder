export { canonicalDecimal, compareDecimal, decimalFromLiteral, DECIMAL_MAX_DIGITS } from "./decimal.js";
export { evaluate, type AnswerError, type EvaluationResult } from "./evaluate.js";
export {
  DEFAULT_MAX_LENGTH,
  DEFAULT_RATING_RANGE,
  FIELD_REGISTRY,
  isEmptyValue,
  type AnswerValue,
  type DecodeResult,
  type FieldTypeSpec,
  type PrivacyClass,
  type ValueKind,
} from "./fields.js";
export {
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  validateDefinition,
  type DefinitionValidationResult,
} from "./validate-definition.js";
