/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage } from "@workglow/storage";
import type { DataPortSchemaObject, FromSchema } from "@workglow/util/schema";

export const AuthorPrimaryKeyNames = ["id"] as const;
export const AuthorSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    tenant: { type: "string" },
    name: { type: "string" },
    country: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["id", "tenant", "name", "country"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const PostPrimaryKeyNames = ["id"] as const;
export const PostSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    tenant: { type: "string" },
    author_id: { anyOf: [{ type: "string" }, { type: "null" }] },
    title: { type: "string" },
    views: { type: "number" },
  },
  required: ["id", "tenant", "author_id", "title", "views"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export type AuthorStorage = ITabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>;
export type PostStorage = ITabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>;
export type JoinFixtureAuthor = FromSchema<typeof AuthorSchema>;
export type JoinFixturePost = FromSchema<typeof PostSchema>;

export const JOIN_FIXTURE_AUTHORS: JoinFixtureAuthor[] = [
  { id: "a1", tenant: "t1", name: "Ann", country: "US" },
  { id: "a2", tenant: "t1", name: "Bob", country: null },
  { id: "a3", tenant: "t2", name: "Cid", country: "FR" },
];
export const JOIN_FIXTURE_POSTS: JoinFixturePost[] = [
  { id: "p1", tenant: "t1", author_id: "a1", title: "one", views: 10 },
  { id: "p2", tenant: "t1", author_id: "a1", title: "two", views: 5 },
  { id: "p3", tenant: "t1", author_id: "a2", title: "three", views: 7 },
  { id: "p4", tenant: "t1", author_id: "zz", title: "orphan", views: 1 },
  { id: "p5", tenant: "t1", author_id: null, title: "anon", views: 3 },
  { id: "p6", tenant: "t2", author_id: "a1", title: "cross", views: 9 },
];

/** Loads both fixture tables, right side first so a left read never races it. */
export async function seedJoinFixtures(
  posts: ITabularStorage<typeof PostSchema, typeof PostPrimaryKeyNames>,
  authors: ITabularStorage<typeof AuthorSchema, typeof AuthorPrimaryKeyNames>
): Promise<void> {
  await authors.putBulk(JOIN_FIXTURE_AUTHORS);
  await posts.putBulk(JOIN_FIXTURE_POSTS);
}
