import type { FormDefinition } from "@workeasy/form-schema";
import { describe, expect, it } from "vitest";
import example from "../../../contracts/support-request.example.json";
import definitionCorpus from "../corpus/definitions.json";
import { evaluate, validateDefinition, type AnswerValue } from "./index.js";

/**
 * The shared engine corpus (docs/03 §3). This file runs unchanged in Node
 * (`pnpm test`) and in headless Chromium (`pnpm test:browser`); both must
 * produce exactly the expected outcomes, so browser and server agree.
 */

const runtime = typeof window === "undefined" ? "node" : "browser";

interface ExpectedOutcome {
  answers: Record<string, AnswerValue>;
  errors: Array<{ fieldId: string; code: string }>;
  visibleFieldIds: string[];
  requiredFieldIds: string[];
  reachablePageIds: string[];
}

interface EvaluationCorpus {
  description: string;
  definition: unknown;
  cases: Array<{ name: string; answers: unknown; expected: ExpectedOutcome }>;
}

interface DefinitionCorpus {
  cases: Array<{ name: string; definition: unknown; expectedIssues: Array<{ path: string; code: string }> }>;
}

/** Corpus files can point at contract examples instead of repeating them. */
const CONTRACTS: Record<string, unknown> = { "contracts/support-request.example.json": example };
const resolve = (definition: unknown): unknown =>
  typeof definition === "string" ? (CONTRACTS[definition] ?? `unknown contract ${definition}`) : definition;

const evaluationFiles = import.meta.glob<EvaluationCorpus>("../corpus/evaluation/*.json", { eager: true, import: "default" });

describe(`form engine corpus: evaluation (${runtime})`, () => {
  it("found the evaluation corpus", () => {
    expect(Object.keys(evaluationFiles).length).toBeGreaterThanOrEqual(4);
  });

  for (const [file, corpus] of Object.entries(evaluationFiles)) {
    const name = file.split("/").pop()!;
    describe(name, () => {
      const validation = validateDefinition(resolve(corpus.definition));

      it("uses a valid definition", () => {
        expect(validation).toMatchObject({ ok: true });
      });

      for (const testCase of corpus.cases) {
        const { name: caseName } = testCase;
        it(caseName, () => {
          if (!validation.ok) throw new Error("definition is invalid");
          const result = evaluate(validation.definition as FormDefinition, structuredClone(testCase.answers));
          expect({
            answers: result.answers,
            errors: result.errors.map(({ fieldId, code }) => ({ fieldId, code })),
            visibleFieldIds: result.visibleFieldIds,
            requiredFieldIds: result.requiredFieldIds,
            reachablePageIds: result.reachablePageIds,
          }).toEqual(testCase.expected);
          // Every error carries a human-readable message.
          for (const error of result.errors) expect(error.message.length).toBeGreaterThan(0);
        });
      }
    });
  }
});

describe(`form engine corpus: definition validation (${runtime})`, () => {
  for (const testCase of (definitionCorpus as DefinitionCorpus).cases) {
    const { name: caseName } = testCase;
    it(caseName, () => {
      const result = validateDefinition(resolve(testCase.definition));
      const issues = result.ok ? [] : result.issues.map(({ path, code }) => ({ path, code }));
      const sort = (list: Array<{ path: string; code: string }>) =>
        [...list].toSorted((a, b) => (a.path + a.code < b.path + b.code ? -1 : 1));
      expect(sort(issues)).toEqual(sort(testCase.expectedIssues));
    });
  }
});

describe(`form engine determinism (${runtime})`, () => {
  it("does not mutate its inputs and returns the same result twice", () => {
    const corpus = Object.values(evaluationFiles)[0]!;
    const validation = validateDefinition(resolve(corpus.definition));
    if (!validation.ok) throw new Error("definition is invalid");
    const definitionBefore = JSON.stringify(validation.definition);
    for (const testCase of corpus.cases) {
      const answersBefore = JSON.stringify(testCase.answers);
      const first = evaluate(validation.definition, testCase.answers);
      const second = evaluate(validation.definition, testCase.answers);
      expect(second).toEqual(first);
      expect(JSON.stringify(testCase.answers)).toBe(answersBefore);
    }
    expect(JSON.stringify(validation.definition)).toBe(definitionBefore);
  });
});
