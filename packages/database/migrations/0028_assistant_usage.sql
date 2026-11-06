-- The console assistant (packages/ai/src/assistant.ts): a chat agent that
-- reads organization data through permission-checked tools and proposes
-- changes for the member to confirm. Each question counts against its own
-- daily allowance on the organization's AI usage row; its tokens count
-- against the same daily token limit as AI drafting (used_tokens).

ALTER TABLE app.ai_usage_days
  ADD COLUMN assistant_messages integer NOT NULL DEFAULT 0 CHECK (assistant_messages >= 0);
