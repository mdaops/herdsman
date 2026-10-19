import { Schema } from "effect";

export const CoordinatorId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
).pipe(Schema.brand("CoordinatorId"));
export type CoordinatorId = typeof CoordinatorId.Type;

export const ReviewMode = Schema.Literals(["plan", "approve-plan", "code"]);
export type ReviewMode = typeof ReviewMode.Type;
