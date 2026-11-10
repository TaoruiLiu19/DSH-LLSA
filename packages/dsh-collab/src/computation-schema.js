import { z } from 'zod';

// JSON-schema-visible structure. normalizeContract additionally checks exact semantics.
const clause = z.object({ field: z.string(), op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict();
const filter = z.array(clause).max(64);
const common = { as: z.string(), unit: z.string() };
const sum = { op: z.literal('sum'), field: z.string(), ...common };
const count = { op: z.literal('count'), ...common };
const select = { op: z.literal('select'), fields: z.array(z.string()).min(1).max(64), ...common };
const v1Operation = z.union([sum, count, select].map(shape => z.object(shape).strict()));
const v2Operation = z.union([
  ...[sum, count, select].map(shape => z.object({ ...shape, filter }).strict()),
  z.object({ op: z.literal('pluck'), field: z.string(), ...common, filter }).strict(),
  z.object({ op: z.enum(['argmin', 'argmax']), field: z.string(), fields: z.array(z.string()).min(1).max(64),
    tie: z.literal('first'), empty: z.literal('null'), ...common, filter }).strict(),
  z.object({ op: z.literal('every'), predicate: clause, empty: z.literal('true'), ...common, filter }).strict(),
]);
const top = { inputRef: z.string(), rowsPath: z.array(z.string()).max(32), filter,
  precision: z.literal('safe_integer'), nullPolicy: z.enum(['reject', 'skip']), deduplicate: z.literal(false) };
export const computationSchema = z.union([
  z.object({ version: z.literal('1'), ...top, operations: z.array(v1Operation).min(1).max(64) }).strict(),
  z.object({ version: z.literal('2'), ...top, operations: z.array(v2Operation).min(1).max(64) }).strict(),
  z.object({ version: z.literal('3'), ...top, operations: z.array(z.union([
    v2Operation,
    z.object({ op: z.literal('at'), index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), ...common, filter }).strict(),
  ])).min(1).max(64) }).strict(),
]);
