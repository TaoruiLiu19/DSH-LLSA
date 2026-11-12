/** End only after a successful final commit. Validation errors must remain repairable. */
export function concludeSubmitted(result, requestedFinal, execution, isChild) {
  if (isChild && requestedFinal && result?.submitted === true) execution.concludeTurn?.();
  return result;
}
