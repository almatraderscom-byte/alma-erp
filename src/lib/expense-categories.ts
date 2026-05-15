export const EXPENSE_CATEGORIES = [
  'office rent',
  'internet',
  'electricity',
  'salary',
  'marketing',
  'Facebook ads',
  'software',
  'courier',
  'transport',
  'equipment',
  'miscellaneous',
] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]
