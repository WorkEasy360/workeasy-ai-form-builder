import type { FormDefinition, Theme } from "@workeasy/form-schema";

/**
 * Starting points for new forms (docs/01 §2: "Blank, templates"). Templates
 * are complete, valid definitions; a blank form is an intentionally
 * incomplete draft (no fields yet) that becomes valid as the creator builds it.
 */

// WorkEasy360 brand: navy accent and text on white (13.6:1). Stored themes are unaffected.
export const DEFAULT_THEME: Theme = { accent: "#1B3040", background: "#FFFFFF", text: "#1B3040", radius: 8 };
export const DEFAULT_SUCCESS_MESSAGE = "Thank you. Your response has been recorded.";

export function blankDefinition(title: string, locale = "en"): FormDefinition {
  return {
    schemaVersion: "1.0",
    title,
    locale,
    pages: [{ id: "page_1", title: "", fieldIds: [] }],
    fields: [],
    rules: [],
    theme: { ...DEFAULT_THEME },
    success: { message: DEFAULT_SUCCESS_MESSAGE },
  };
}

export interface FormTemplate {
  id: string;
  name: string;
  description: string;
  definition: FormDefinition;
}

const contact: FormTemplate = {
  id: "contact",
  name: "Contact us",
  description: "Name, email and a message, with consent to reply.",
  definition: {
    schemaVersion: "1.0",
    title: "Contact us",
    locale: "en",
    pages: [{ id: "page_1", title: "", fieldIds: ["f_name", "f_email", "f_message", "f_consent"] }],
    fields: [
      { id: "f_name", type: "text", label: "Your name", required: true, settings: { maxLength: 150 } },
      { id: "f_email", type: "email", label: "Email address", required: true, settings: {} },
      { id: "f_message", type: "textarea", label: "Message", required: true, settings: { maxLength: 4000 } },
      {
        id: "f_consent",
        type: "consent",
        label: "I agree that you may use these details to reply to me.",
        required: true,
        settings: { consentTextVersion: "contact-v1" },
      },
    ],
    rules: [],
    theme: { ...DEFAULT_THEME },
    success: { message: "Thanks for getting in touch. We'll reply soon." },
  },
};

const supportRequest: FormTemplate = {
  id: "support-request",
  name: "Support request",
  description: "Category-dependent details, as in the example contract.",
  definition: {
    schemaVersion: "1.0",
    title: "Support request",
    locale: "en",
    pages: [{ id: "page_contact", title: "Your request", fieldIds: ["f_name", "f_email", "f_category", "f_details", "f_consent"] }],
    fields: [
      { id: "f_name", type: "text", label: "Your name", required: true, settings: { maxLength: 150 } },
      { id: "f_email", type: "email", label: "Email address", required: true, settings: { maxLength: 254 } },
      {
        id: "f_category",
        type: "dropdown",
        label: "Request category",
        required: true,
        settings: { options: [{ id: "opt_technical", label: "Technical support" }, { id: "opt_general", label: "General question" }] },
      },
      {
        id: "f_details",
        type: "textarea",
        label: "Technical details",
        helpText: "Describe what happened. Do not include passwords.",
        required: true,
        settings: { maxLength: 4000 },
      },
      {
        id: "f_consent",
        type: "consent",
        label: "I agree that these details may be used to respond to my request.",
        required: true,
        settings: { consentTextVersion: "support-contact-v1" },
      },
    ],
    rules: [
      {
        id: "rule_technical_details",
        when: { fieldId: "f_category", op: "eq", value: "opt_technical" },
        action: { type: "setVisibility", targetFieldId: "f_details", onTrue: true, onFalse: false },
      },
    ],
    theme: { ...DEFAULT_THEME },
    success: { message: "Your request has been received. Our team will get back to you." },
  },
};

const feedback: FormTemplate = {
  id: "feedback",
  name: "Feedback",
  description: "A rating, with a follow-up question when the rating is low.",
  definition: {
    schemaVersion: "1.0",
    title: "Feedback",
    locale: "en",
    pages: [{ id: "page_1", title: "", fieldIds: ["f_rating", "f_improve", "f_comments"] }],
    fields: [
      { id: "f_rating", type: "rating", label: "How satisfied are you?", required: true, settings: { min: 1, max: 5 } },
      { id: "f_improve", type: "textarea", label: "What should we improve?", required: false, settings: { maxLength: 2000 } },
      { id: "f_comments", type: "textarea", label: "Anything else?", required: false, settings: { maxLength: 2000 } },
    ],
    rules: [
      {
        id: "rule_improve_required",
        when: { fieldId: "f_rating", op: "lte", value: 2 },
        action: { type: "setRequired", targetFieldId: "f_improve", onTrue: true, onFalse: false },
      },
    ],
    theme: { ...DEFAULT_THEME },
    success: { message: "Thanks for your feedback." },
  },
};

export const FORM_TEMPLATES: readonly FormTemplate[] = [contact, supportRequest, feedback];

/** A copy of the template's definition titled for the new form, or undefined for an unknown template. */
export function definitionFromTemplate(templateId: string, title: string): FormDefinition | undefined {
  const template = FORM_TEMPLATES.find((t) => t.id === templateId);
  return template ? { ...structuredClone(template.definition), title } : undefined;
}
