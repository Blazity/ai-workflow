import { z } from "zod";
import type { BlockManifest, WorkflowValueSchema } from "@shared/contracts";

const ticketSchema = {
  type: "object",
  properties: {
    identifier: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    acceptanceCriteria: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          author: { type: "string" },
          body: { type: "string" },
          createdAt: { type: "string" },
        },
        required: ["author", "body", "createdAt"],
        additionalProperties: false,
      },
    },
    priorAnswers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          questions: { type: "array", items: { type: "string" } },
          answer: { type: "string" },
          answeredBy: { type: "string" },
          answeredAt: { type: "string" },
        },
        required: ["questions", "answer"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "identifier",
    "title",
    "description",
    "acceptanceCriteria",
    "labels",
    "comments",
    "priorAnswers",
  ],
  additionalProperties: false,
} satisfies WorkflowValueSchema;
const commentsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      author: { type: "string" },
      body: { type: "string" },
      createdAt: { type: "string" },
    },
    required: ["author", "body", "createdAt"],
    additionalProperties: false,
  },
} satisfies WorkflowValueSchema;
const priorAnswersSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      questions: { type: "array", items: { type: "string" } },
      answer: { type: "string" },
      answeredBy: { type: "string" },
      answeredAt: { type: "string" },
    },
    required: ["questions", "answer"],
    additionalProperties: false,
  },
} satisfies WorkflowValueSchema;

const paramsSchema = z.object({}).strict();


export const manifest = {
  type: "planning_agent",
  paramsSchema,
  contract: {
    category: "action",
    ports: ["out"],
    allowsFailurePort: true,
  },
  ui: {
    group: "agents",
    label: "Planning agent",
    description: "Researches the ticket and returns a plan or clarification questions.",
    glyph: "✦",
    color: "#7C3AED",
    softColor: "#F2EBFD",
  },
  defaults: {},
  inputs: {
    ticket: { required: false, schema: ticketSchema },
    comments: { required: false, schema: commentsSchema },
    priorAnswers: { required: false, schema: priorAnswersSchema },
  },
  execution: "inline",
} satisfies BlockManifest;
