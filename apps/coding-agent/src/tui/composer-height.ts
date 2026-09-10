/** Maximum rows available to the active composer, including its chrome. */
export const composerHeightBudget = (terminalRows: number): number =>
  Math.max(5, Math.floor(terminalRows * 0.3));

/** Reserve the footer and the active component's top/bottom border. */
export const composerContentBudget = (terminalRows: number): number =>
  Math.max(1, composerHeightBudget(terminalRows) - 2);
