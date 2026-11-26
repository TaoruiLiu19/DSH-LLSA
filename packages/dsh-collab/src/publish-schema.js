import { z } from 'zod';

// Scope can change after registration; the host gate checks the current run on
// every call. A single static schema supports standalone roots and managed children.
export const publishSchema = z.object({
  stepId: z.string().min(1),
  result: z.json(),
  final: z.boolean().default(false).describe('Native Superagent ticket workers must use false for evidence checkpoints and orchestrator_report for formal delivery. true is only for standalone or managed-child final results.'),
  parents: z.array(z.string()).default([]),
  receiptId: z.string().optional(),
}).strict();
